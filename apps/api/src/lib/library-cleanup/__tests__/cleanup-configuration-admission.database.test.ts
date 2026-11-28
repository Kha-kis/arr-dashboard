import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it, vi } from "vitest";
import { SqliteSchemaFixture } from "../../__tests__/sqlite-schema-fixture.js";
import { openRestoreRuntime } from "../../backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../backup/restore-runtime-client.js";
import { withCleanupTopologyMutationLease } from "../cleanup-executor.js";

let schemaFixture: SqliteSchemaFixture | undefined;
afterAll(() => schemaFixture?.dispose());

describe("cleanup configuration SQLite admission", () => {
	it.each(["DELETE", "WAL"] as const)(
		"creates the config without pinning the competing %s writer",
		async (mode) => {
			const directory = mkdtempSync(join(tmpdir(), "cleanup-config-admission-"));
			const dbPath = join(directory, "fixture.db");
			const commitSignal = join(directory, "config-read-observed");
			const commitAcknowledged = join(directory, "writer-committed");
			const commitWait = new Int32Array(new SharedArrayBuffer(4));
			let runtime: Awaited<ReturnType<typeof openRestoreRuntime>> | undefined;
			let native: ReturnType<typeof createRuntimePrismaClient> | undefined;
			let holder: ReturnType<typeof spawn> | undefined;
			let holderExit: ReturnType<typeof once> | undefined;
			try {
				if (!schemaFixture) {
					schemaFixture = new SqliteSchemaFixture();
					schemaFixture.initialize();
				}
				schemaFixture.copyTo(dbPath);
				const setup = new Database(dbPath);
				expect(setup.pragma("journal_mode=" + mode, { simple: true })).toBe(mode.toLowerCase());
				setup.close();
				runtime = await openRestoreRuntime({ databaseUrl: `file:${dbPath}`, onUnavailable() {} });
				await runtime.bindDestination("synthetic-installation");
				await runtime.activate();
				native = createRuntimePrismaClient(runtime);
				const prisma = native.prisma;
				await runtime.runOperation(() =>
					prisma.user.create({ data: { id: "owner", username: "synthetic-owner" } }),
				);
				const journal = new Database(dbPath, { readonly: true });
				expect(journal.pragma("journal_mode", { simple: true })).toBe(mode.toLowerCase());
				journal.close();

				const modulePath = createRequire(import.meta.url).resolve("better-sqlite3");
				const holderProgram = [
					"const Database = require(process.argv[1]);",
					"const fs = require('node:fs');",
					"const [db, signal, acknowledged] = process.argv.slice(2);",
					"const connection = new Database(db, { timeout: 6000 });",
					"connection.exec('BEGIN IMMEDIATE');",
					"connection.prepare('UPDATE User SET username = ? WHERE id = ?').run('writer-updated-owner', 'owner');",
					"console.log('READY');",
					"const deadline = Date.now() + 4000;",
					"const timer = setInterval(() => {",
					"  if (!fs.existsSync(signal)) {",
					"    if (Date.now() < deadline) return;",
					"    clearInterval(timer);",
					"    connection.exec('ROLLBACK');",
					"    connection.close();",
					"    process.exitCode = 1;",
					"    return;",
					"  }",
					"  clearInterval(timer);",
					"  console.log('COMMIT_ATTEMPT');",
					"  connection.exec('COMMIT');",
					"  fs.writeFileSync(acknowledged, 'committed');",
					"  console.log('COMMITTED');",
					"  connection.close();",
					"}, 2);",
				].join("\n");
				holder = spawn(
					process.execPath,
					["-e", holderProgram, modulePath, dbPath, commitSignal, commitAcknowledged],
					{ stdio: ["ignore", "pipe", "pipe"] },
				);
				holderExit = once(holder, "exit");
				let holderOutput = "";
				holder.stdout?.on("data", (chunk: Buffer) => {
					holderOutput += chunk.toString();
				});
				const holderReady = new Promise<void>((resolve, reject) => {
					holder!.stdout?.on("data", (chunk: Buffer) => {
						if (chunk.toString().includes("READY")) resolve();
					});
					holder!.once("error", reject);
					holder!.once("exit", (code) =>
						reject(new Error(`Writer exited before readiness: ${code}`)),
					);
				});
				await holderReady;

				let configReadObserved = false;
				const configInsertTransactions: boolean[] = [];
				const prepare = Database.prototype.prepare;
				vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
					this: Database.Database,
					sql: string,
				) {
					const database = this;
					const statement = prepare.call(database, sql);
					const readsConfig = /\bSELECT\b/i.test(sql) && /library_cleanup_configs/i.test(sql);
					const insertsConfig = /^\s*INSERT\b/i.test(sql) && /library_cleanup_configs/i.test(sql);
					if (database.name !== dbPath || (!readsConfig && !insertsConfig)) return statement;
					const wrap = (target: object): object =>
						new Proxy(target, {
							get(obj, key) {
								const value = Reflect.get(obj, key);
								if (
									(key === "all" || key === "get" || key === "run") &&
									typeof value === "function"
								) {
									return (...args: unknown[]) => {
										const inTransaction = database.inTransaction;
										const result = Reflect.apply(value, obj, args);
										if (insertsConfig) configInsertTransactions.push(inTransaction);
										if (readsConfig && !configReadObserved) {
											configReadObserved = true;
											writeFileSync(commitSignal, "release");
											// Hold this SQLite boundary until the independent writer commits.
											// A deferred DELETE reader would block that commit. Waiting also
											// keeps the next Restore guard read outside the commit window.
											const deadline = performance.now() + 2_000;
											while (!existsSync(commitAcknowledged)) {
												const remaining = deadline - performance.now();
												if (remaining <= 0) {
													throw new Error(
														"Competing writer could not commit after the config read",
													);
												}
												Atomics.wait(commitWait, 0, 0, Math.min(2, remaining));
											}
										}
										return result;
									};
								}
								if ((key === "bind" || key === "raw") && typeof value === "function") {
									return (...args: unknown[]) => wrap(Reflect.apply(value, obj, args));
								}
								return typeof value === "function" ? value.bind(obj) : value;
							},
						});
					return wrap(statement) as typeof statement;
				});

				let entered = false;
				const admission = runtime.runOperation(() =>
					withCleanupTopologyMutationLease(
						{ prisma, log: { warn: vi.fn(), error: vi.fn() } as never },
						"owner",
						async () => {
							entered = true;
							return "admitted";
						},
					),
				);
				const result = await admission.then(
					(value) => ({ ok: true as const, value }),
					(error: unknown) => ({ ok: false as const, error }),
				);
				const [exitCode] = await holderExit;
				expect(exitCode).toBe(0);
				expect(holderOutput).toContain("COMMIT_ATTEMPT");
				expect(holderOutput).toContain("COMMITTED");
				expect(configReadObserved).toBe(true);
				expect(result).toMatchObject({ ok: true, value: "admitted" });
				expect(entered).toBe(true);
				expect(configInsertTransactions).toEqual([false]);
				expect(
					(await runtime.runOperation(() => prisma.user.findUnique({ where: { id: "owner" } })))
						?.username,
				).toBe("writer-updated-owner");
				const config = await runtime.runOperation(() =>
					prisma.libraryCleanupConfig.findUnique({ where: { userId: "owner" } }),
				);
				expect(config).toMatchObject({ userId: "owner", runClaimToken: null });
			} finally {
				vi.restoreAllMocks();
				holder?.kill();
				await holderExit?.catch(() => undefined);
				await native?.close();
				await runtime?.close();
				rmSync(directory, { recursive: true, force: true });
			}
		},
		15_000,
	);
});
