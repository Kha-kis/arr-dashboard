import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, expect, it, vi } from "vitest";
import { SqliteSchemaFixture } from "../../__tests__/sqlite-schema-fixture.js";
import { openRestoreRuntime } from "../../backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../backup/restore-runtime-client.js";
import { acquireCleanupRunLease, renewCleanupRunLease } from "../cleanup-run-lease.js";

let scaffold: SqliteSchemaFixture | undefined;
afterAll(() => scaffold?.dispose());

const attempts = [
	["WAL", "acquire"],
	["WAL", "renew"],
	["DELETE", "acquire"],
	["DELETE", "renew"],
] as const;

it.each(attempts)(
	"commits a competing writer before lease %s / %s and conserves both writes",
	async (mode, action) => {
		const directory = mkdtempSync(join(tmpdir(), "native-cleanup-write-"));
		const path = join(directory, "fixture.db");
		let runtime: Awaited<ReturnType<typeof openRestoreRuntime>> | undefined;
		let client: ReturnType<typeof createRuntimePrismaClient> | undefined;
		let writer: Database.Database | undefined;
		try {
			if (!scaffold) {
				scaffold = new SqliteSchemaFixture();
				scaffold.initialize();
			}
			scaffold.copyTo(path);
			writer = new Database(path, { timeout: 0 });
			expect(writer.pragma("journal_mode=" + mode, { simple: true })).toBe(mode.toLowerCase());
			runtime = await openRestoreRuntime({ databaseUrl: "file:" + path, onUnavailable() {} });
			await runtime.bindDestination("fixture-installation");
			await runtime.activate();
			const owner = runtime;
			client = createRuntimePrismaClient(owner);
			const prisma = client.prisma;
			const token = "synthetic-lease-token";
			const claimedAt = new Date("2026-10-01T12:00:00.000Z");
			const previousClaimedAt = new Date("2026-10-01T11:30:00.000Z");
			await owner.runOperation(async () => {
				await prisma.user.create({ data: { id: "owner", username: "fixture-owner" } });
				await prisma.libraryCleanupConfig.create({
					data: {
						id: "config",
						userId: "owner",
						enabled: true,
						runClaimToken: action === "renew" ? token : null,
						runClaimedAt: action === "renew" ? previousClaimedAt : null,
					},
				});
			});

			const attemptedWrites: Array<{ inTransaction: boolean; code: string }> = [];
			let writerCode: string | undefined;
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
									const inTransaction = database.inTransaction;
									if (writer?.inTransaction) {
										try {
											writer.exec("COMMIT");
											writerCode = "committed";
										} catch (error) {
											if (!(error instanceof Database.SqliteError) || error.code !== "SQLITE_BUSY")
												throw error;
											writerCode = error.code;
										}
									}
									try {
										const result = Reflect.apply(fn, obj, args);
										attemptedWrites.push({ inTransaction, code: "completed" });
										return result;
									} catch (error) {
										const code = error instanceof Database.SqliteError ? error.code : "unknown";
										attemptedWrites.push({ inTransaction, code });
										throw error;
									}
								};
							}
							if ((key === "bind" || key === "raw") && typeof fn === "function")
								return (...args: unknown[]) => wrap(Reflect.apply(fn, obj, args));
							return typeof fn === "function" ? fn.bind(obj) : fn;
						},
					});
				return wrap(statement) as typeof statement;
			});
			writer.exec("BEGIN IMMEDIATE");
			writer.prepare("UPDATE User SET username = ? WHERE id = ?").run("writer-preserved", "owner");

			const outcome = await owner
				.runOperation<string | boolean | null>(() =>
					action === "acquire"
						? acquireCleanupRunLease(prisma, "owner", "config", claimedAt, token)
						: renewCleanupRunLease(prisma, "owner", "config", token, claimedAt),
				)
				.then(
					(value) => ({ value }),
					(error: unknown) => ({
						error: error && typeof error === "object" && "code" in error ? error.code : "unknown",
					}),
				);
			expect({
				outcome,
				writerCode,
				writeCount: attemptedWrites.length,
				firstWrite: attemptedWrites[0],
			}).toEqual({
				outcome: { value: action === "acquire" ? token : true },
				writerCode: "committed",
				writeCount: 1,
				firstWrite: { inTransaction: false, code: "completed" },
			});
			expect(writer.inTransaction).toBe(false);
			expect(
				await owner.runOperation(() => prisma.user.findUnique({ where: { id: "owner" } })),
			).toMatchObject({ username: "writer-preserved" });
			expect(
				await owner.runOperation(() =>
					prisma.libraryCleanupConfig.findUnique({ where: { id: "config" } }),
				),
			).toMatchObject({
				userId: "owner",
				enabled: true,
				runClaimToken: token,
				runClaimedAt: claimedAt,
			});

			const exactExpiry = new Date("2026-10-01T14:00:00.000Z");
			const afterExpiry = new Date("2026-10-01T14:00:00.001Z");
			await owner.runOperation(async () => {
				expect(
					await acquireCleanupRunLease(prisma, "foreign-owner", "config", afterExpiry, "foreign"),
				).toBeNull();
				expect(
					await renewCleanupRunLease(prisma, "foreign-owner", "config", token, afterExpiry),
				).toBe(false);
				expect(
					await renewCleanupRunLease(prisma, "owner", "config", "wrong-token", afterExpiry),
				).toBe(false);
				expect(
					await acquireCleanupRunLease(prisma, "owner", "config", exactExpiry, "too-early"),
				).toBeNull();
				expect(
					await acquireCleanupRunLease(prisma, "owner", "config", afterExpiry, "replacement"),
				).toBe("replacement");
				expect(await renewCleanupRunLease(prisma, "owner", "config", token, afterExpiry)).toBe(
					false,
				);
				expect(
					await prisma.libraryCleanupConfig.findUnique({ where: { id: "config" } }),
				).toMatchObject({
					userId: "owner",
					runClaimToken: "replacement",
					runClaimedAt: afterExpiry,
				});
			});
		} finally {
			vi.restoreAllMocks();
			writer?.close();
			await client?.close();
			await runtime?.close();
			rmSync(directory, { recursive: true, force: true });
		}
	},
	15_000,
);
