import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, expect, it, vi } from "vitest";
import { SqliteSchemaFixture } from "../../__tests__/sqlite-schema-fixture.js";
import { openRestoreRuntime } from "../../backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../backup/restore-runtime-client.js";
import { acquireCleanupRunLease, releaseCleanupRunLease } from "../cleanup-run-lease.js";

let scaffold: SqliteSchemaFixture | undefined;
afterAll(() => scaffold?.dispose());

it.each(["WAL", "DELETE"] as const)(
	"releases only the owned cleanup token in an autocommit statement (%s)",
	async (mode) => {
		const directory = mkdtempSync(join(tmpdir(), "native-cleanup-release-"));
		const path = join(directory, "fixture.db");
		let runtime: Awaited<ReturnType<typeof openRestoreRuntime>> | undefined;
		let client: ReturnType<typeof createRuntimePrismaClient> | undefined;
		let competingWriter: Database.Database | undefined;
		try {
			if (!scaffold) {
				scaffold = new SqliteSchemaFixture();
				scaffold.initialize();
			}
			scaffold.copyTo(path);
			const storage = new Database(path);
			try {
				expect(storage.pragma("journal_mode=" + mode, { simple: true })).toBe(mode.toLowerCase());
			} finally {
				storage.close();
			}
			runtime = await openRestoreRuntime({ databaseUrl: "file:" + path, onUnavailable() {} });
			await runtime.bindDestination("fixture-installation");
			await runtime.activate();
			const owner = runtime;
			client = createRuntimePrismaClient(owner);
			const prisma = client.prisma;
			await owner.runOperation(async () => {
				await prisma.user.create({ data: { id: "owner", username: "fixture-owner" } });
				await prisma.libraryCleanupConfig.create({
					data: { id: "config", userId: "owner", enabled: true },
				});
			});
			const token = await owner.runOperation(() =>
				acquireCleanupRunLease(prisma, "owner", "config"),
			);
			expect(token).toEqual(expect.any(String));
			if (token === null) throw new Error("Synthetic lease not acquired");

			const releaseTransactionState: boolean[] = [];
			const prepare = Database.prototype.prepare;
			vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
				this: Database.Database,
				sql: string,
			) {
				const database = this;
				const statement = prepare.call(database, sql);
				if (
					database.name !== path ||
					!/^\s*UPDATE\b/i.test(sql) ||
					!/library_cleanup_configs/i.test(sql)
				)
					return statement;
				const wrap = (target: object): object =>
					new Proxy(target, {
						get(obj, key) {
							const fn = Reflect.get(obj, key);
							if ((key === "all" || key === "get" || key === "run") && typeof fn === "function") {
								return (...args: unknown[]) => {
									if (competingWriter?.inTransaction) competingWriter.exec("COMMIT");
									releaseTransactionState.push(database.inTransaction);
									return Reflect.apply(fn, obj, args);
								};
							}
							if ((key === "bind" || key === "raw") && typeof fn === "function")
								return (...args: unknown[]) => wrap(Reflect.apply(fn, obj, args));
							return typeof fn === "function" ? fn.bind(obj) : fn;
						},
					});
				return wrap(statement) as typeof statement;
			});
			const release = (userId: string, witness: string) =>
				owner.runOperation(() => releaseCleanupRunLease(prisma, userId, "config", witness));
			await expect(release("different-owner", token)).resolves.toBe(false);
			await expect(release("owner", "different-token")).resolves.toBe(false);
			const before = await owner.runOperation(() =>
				prisma.libraryCleanupConfig.findUnique({ where: { id: "config" } }),
			);
			expect(before).toMatchObject({ userId: "owner", enabled: true, runClaimToken: token });
			if (mode === "WAL") {
				competingWriter = new Database(path, { timeout: 0 });
				competingWriter.exec("BEGIN IMMEDIATE");
				competingWriter
					.prepare("UPDATE User SET username = ? WHERE id = ?")
					.run("fixture-owner-updated", "owner");
			}
			await expect(release("owner", token)).resolves.toBe(true);
			if (competingWriter) {
				expect(competingWriter.inTransaction).toBe(false);
				expect(
					await owner.runOperation(() => prisma.user.findUnique({ where: { id: "owner" } })),
				).toMatchObject({ username: "fixture-owner-updated" });
			}
			const after = await owner.runOperation(() =>
				prisma.libraryCleanupConfig.findUnique({ where: { id: "config" } }),
			);
			expect(after).toMatchObject({
				userId: "owner",
				enabled: true,
				runClaimToken: null,
				runClaimedAt: null,
			});
			expect(releaseTransactionState).toEqual([false, false, false]);
		} finally {
			vi.restoreAllMocks();
			competingWriter?.close();
			await client?.close();
			await runtime?.close();
			rmSync(directory, { recursive: true, force: true });
		}
	},
	15_000,
);
