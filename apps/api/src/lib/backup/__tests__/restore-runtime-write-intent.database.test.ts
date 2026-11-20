import { chmodSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getRestoreRuntimeClientContext,
	openRestoreRuntime,
	type RestoreRuntime,
} from "../restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../restore-runtime-client.js";

describe("opt-in guarded SQLite transaction write intent", () => {
	let directory: string;
	let path: string;
	let writer: Database.Database;
	let runtime: RestoreRuntime;
	let client: ReturnType<typeof createRuntimePrismaClient>;
	let losses: number;

	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), "arr-runtime-write-intent-"));
		chmodSync(directory, 0o700);
		path = join(directory, "main.sqlite");
		writer = new Database(path, { timeout: 0 });
		chmodSync(path, 0o600);
		writer.pragma("journal_mode=WAL");
		writer.exec(`CREATE TABLE RestoreRuntimeControl (
			id INTEGER PRIMARY KEY, protocolVersion INTEGER NOT NULL, phase TEXT NOT NULL,
			runtimeEpoch TEXT, ownerBackendPid INTEGER, activeRestoreId TEXT,
			lastCommittedRestoreId TEXT, lastCommittedAt DATETIME, destinationInstallationId TEXT);
			CREATE TABLE SqliteRestoreStorageBinding (
			id INTEGER PRIMARY KEY, protocolVersion INTEGER NOT NULL,
			databaseDevice TEXT NOT NULL, databaseInode TEXT NOT NULL,
			directoryDevice TEXT NOT NULL, directoryInode TEXT NOT NULL,
			coordinationDevice TEXT NOT NULL, coordinationInode TEXT NOT NULL,
			ownerDevice TEXT NOT NULL, ownerInode TEXT NOT NULL,
			operationsDevice TEXT NOT NULL, operationsInode TEXT NOT NULL);
			CREATE TABLE IntentProbe(id INTEGER PRIMARY KEY,value INTEGER NOT NULL);
			INSERT INTO IntentProbe VALUES(1,0),(2,0);
			CREATE TABLE IntentTrigger(value INTEGER);
			CREATE TRIGGER intent_control_update AFTER UPDATE ON RestoreRuntimeControl
			BEGIN INSERT INTO IntentTrigger VALUES(1); END;`);
		losses = 0;
		runtime = await openRestoreRuntime({
			databaseUrl: `file:${path}`,
			onUnavailable: () => {
				losses += 1;
			},
		});
		await runtime.bindDestination("synthetic-destination");
		await runtime.activate();
		writer.exec("DELETE FROM IntentTrigger");
		client = createRuntimePrismaClient(runtime, { sqliteTransactionIntent: "write" });
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		if (writer?.inTransaction) writer.exec("ROLLBACK");
		await client?.close();
		await runtime?.close();
		writer?.close();
		if (directory) rmSync(directory, { recursive: true, force: true });
	});

	function controlRows() {
		return [
			writer.prepare("SELECT * FROM RestoreRuntimeControl").all(),
			writer.prepare("SELECT * FROM SqliteRestoreStorageBinding").all(),
		];
	}

	// Removing/moving reservation after the guard makes this real WAL write fail
	// with SQLITE_BUSY_SNAPSHOT. The interceptor only schedules native competition.
	it("reserves before the guard snapshot so a competing commit cannot stale application writes", async () => {
		const before = controlRows();
		let attempts = 0;
		let blocked = 0;
		const nativeErrors: string[] = [];
		let application: Database.Database | undefined;
		const prepare = Database.prototype.prepare;
		vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
			this: Database.Database,
			sql,
		) {
			const statement = prepare.call(this, sql);
			if (this.name === path && sql === "BEGIN") application = this;
			if (this.name === path && sql === "UPDATE IntentProbe SET value=7 WHERE id=1") {
				const run = statement.run;
				statement.run = function (...args: unknown[]) {
					try {
						return Reflect.apply(run, this, args);
					} catch (error) {
						if (error instanceof Database.SqliteError) nativeErrors.push(error.code);
						throw error;
					}
				};
			}
			if (
				this === application &&
				this.inTransaction &&
				sql.includes("FROM SqliteRestoreStorageBinding")
			) {
				const all = statement.all;
				statement.all = function (...args: unknown[]) {
					const rows = Reflect.apply(all, this, args);
					attempts += 1;
					try {
						writer.exec("BEGIN IMMEDIATE;UPDATE IntentProbe SET value=value+1 WHERE id=2;COMMIT");
					} catch (error) {
						if (writer.inTransaction) writer.exec("ROLLBACK");
						if (!(error instanceof Database.SqliteError) || error.code !== "SQLITE_BUSY")
							throw error;
						blocked += 1;
					}
					return rows;
				};
			}
			return statement;
		});
		await runtime.runOperation(async () => {
			const committed = await client.prisma
				.$transaction(async (tx) => {
					await tx.$executeRawUnsafe("UPDATE IntentProbe SET value=7 WHERE id=1");
					// WAL readers keep their previous committed view while the writer is held.
					expect(writer.prepare("SELECT value FROM IntentProbe WHERE id=1").get()).toEqual({
						value: 0,
					});
				})
				.then(
					() => true,
					() => false,
				);
			expect({ committed, nativeErrors }).toEqual({ committed: true, nativeErrors: [] });
		});
		expect(attempts).toBeGreaterThanOrEqual(3);
		expect(blocked).toBe(attempts);
		expect(writer.prepare("SELECT * FROM IntentProbe ORDER BY id").all()).toEqual([
			{ id: 1, value: 7 },
			{ id: 2, value: 0 },
		]);
		expect(controlRows()).toEqual(before);
		expect(writer.prepare("SELECT * FROM IntentTrigger").all()).toEqual([]);
		expect(losses).toBe(0);
	});

	// A global reservation would block the competing writer in this read-only
	// default transaction, which intentionally keeps its deferred WAL snapshot.
	it("keeps default read-only transactions deferred while another WAL writer commits", async () => {
		await client.close();
		client = createRuntimePrismaClient(runtime);
		const before = controlRows();
		await runtime.runOperation(async () => {
			await client.prisma.$transaction(async (tx) => {
				writer.exec("BEGIN IMMEDIATE;UPDATE IntentProbe SET value=1 WHERE id=1;COMMIT");
				expect(await tx.$queryRawUnsafe("SELECT value FROM IntentProbe WHERE id=1")).toEqual([
					{ value: 0 },
				]);
			});
		});
		expect(writer.prepare("SELECT value FROM IntentProbe WHERE id=1").get()).toEqual({ value: 1 });
		expect(controlRows()).toEqual(before);
		expect(losses).toBe(0);
	});

	// Opt-in applies to transactions, not standalone reads on the same client.
	it("allows standalone opt-in reads while an unrelated writer is reserved", async () => {
		await runtime.runOperation(async () => {
			await client.prisma.$connect();
			writer.exec("BEGIN IMMEDIATE;UPDATE IntentProbe SET value=1 WHERE id=1");
			try {
				expect(
					await client.prisma.$queryRawUnsafe("SELECT value FROM IntentProbe WHERE id=1"),
				).toEqual([{ value: 0 }]);
			} finally {
				writer.exec("ROLLBACK");
			}
		});
		expect(losses).toBe(0);
	});

	// Failure to reserve must release BOTH the native transaction and adapter
	// mutex, retaining the normal finite native busy timeout and original error.
	it("bounds competing-writer refusal before the callback and reuses the driver after confirmed rollback", async () => {
		let armed = true,
			began = false,
			callback = false;
		let application: Database.Database | undefined;
		let nativeCode: string | undefined;
		const prepare = Database.prototype.prepare;
		vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
			this: Database.Database,
			sql,
		) {
			const statement = prepare.call(this, sql);
			if (this.name === path && sql === "BEGIN") {
				application = this;
				const run = statement.run;
				statement.run = function (...args: unknown[]) {
					const value = Reflect.apply(run, this, args);
					if (armed) {
						armed = false;
						began = true;
						writer.exec("BEGIN IMMEDIATE");
					}
					return value;
				};
			}
			if (this === application && sql === 'UPDATE "RestoreRuntimeControl" SET "id"="id" WHERE 0') {
				const run = statement.run;
				statement.run = function (...args: unknown[]) {
					try {
						return Reflect.apply(run, this, args);
					} catch (error) {
						if (error instanceof Database.SqliteError) nativeCode = error.code;
						throw error;
					}
				};
			}
			return statement;
		});
		await runtime.runOperation(async () => {
			await client.prisma.$connect();
			const started = performance.now();
			await expect(
				client.prisma.$transaction(
					async (tx) => {
						callback = true;
						await tx.$executeRawUnsafe("UPDATE IntentProbe SET value=7 WHERE id=1");
						// The real adapter maps SQLITE_BUSY to SocketTimeout; Prisma surfaces
						// that original reservation refusal as "Operation has timed out".
					},
					// Keep Prisma's transaction-start deadline beyond the adapter budget;
					// default maxWait cancellation has its own real regression coverage.
					{ timeout: 20_000, maxWait: 20_000 },
				),
			).rejects.toThrow("Operation has timed out");
			expect(performance.now() - started).toBeLessThan(10_000);
			expect(began).toBe(true);
			expect(callback).toBe(false);
			expect(nativeCode).toBe("SQLITE_BUSY");
			expect(application?.inTransaction).toBe(false);
			writer.exec("ROLLBACK");
			await client.prisma.$transaction(async (tx) => {
				await tx.$executeRawUnsafe("UPDATE IntentProbe SET value=7 WHERE id=1");
			});
		});
		expect(writer.prepare("SELECT value FROM IntentProbe WHERE id=1").get()).toEqual({ value: 7 });
		expect(losses).toBe(0);
	}, 15_000);

	// The reservation is not admission. Corrupt a real guard row only inside
	// the admitted native transaction and prove it is rolled back before exposure.
	it.each(["journal", "binding"] as const)(
		"rejects %s loss after reservation without exposing a callback or retaining its writer",
		async (kind) => {
			const before = controlRows();
			let changed = false,
				callback = false;
			let application: Database.Database | undefined;
			const prepare = Database.prototype.prepare;
			vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
				this: Database.Database,
				sql,
			) {
				const statement = prepare.call(this, sql);
				if (this.name === path && sql === 'UPDATE "RestoreRuntimeControl" SET "id"="id" WHERE 0') {
					const db = this,
						run = statement.run;
					application = db;
					statement.run = function (...args: unknown[]) {
						const value = Reflect.apply(run, this, args);
						if (!changed) {
							changed = true;
							db.exec(
								kind === "journal"
									? "UPDATE RestoreRuntimeControl SET phase='invalid'"
									: "DELETE FROM SqliteRestoreStorageBinding",
							);
						}
						return value;
					};
				}
				return statement;
			});
			await runtime.runOperation(async () => {
				await expect(
					client.prisma.$transaction(async (tx) => {
						callback = true;
						await tx.$executeRawUnsafe("UPDATE IntentProbe SET value=7 WHERE id=1");
					}),
				).rejects.toThrow("Restore runtime admission is unavailable.");
			});
			expect(changed).toBe(true);
			expect(callback).toBe(false);
			expect(application?.inTransaction).toBe(false);
			expect(controlRows()).toEqual(before);
			expect(writer.prepare("SELECT value FROM IntentProbe WHERE id=1").get()).toEqual({
				value: 0,
			});
			writer.exec("BEGIN IMMEDIATE;ROLLBACK");
			expect(losses).toBe(1);
			await expect(runtime.runOperation(() => true)).rejects.toMatchObject({ statusCode: 503 });
		},
	);

	// An ownership loss in the native BEGIN-to-reservation gap must still fail
	// the unchanged guard and release the writer without entering application code.
	it("fences actual native ownership loss immediately after BEGIN", async () => {
		const coordination = `${path}.arr-restore-runtime`;
		let changed = false,
			callback = false;
		let application: Database.Database | undefined;
		const prepare = Database.prototype.prepare;
		vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
			this: Database.Database,
			sql,
		) {
			const statement = prepare.call(this, sql);
			if (this.name === path && sql === "BEGIN") {
				application = this;
				const run = statement.run;
				statement.run = function (...args: unknown[]) {
					const value = Reflect.apply(run, this, args);
					if (!changed) {
						changed = true;
						renameSync(
							join(coordination, "operations.sqlite3"),
							join(coordination, "retained-operations.sqlite3"),
						);
					}
					return value;
				};
			}
			return statement;
		});
		await runtime.runOperation(async () => {
			await expect(
				client.prisma.$transaction(async (tx) => {
					callback = true;
					await tx.$executeRawUnsafe("UPDATE IntentProbe SET value=7 WHERE id=1");
				}),
			).rejects.toThrow("Restore runtime admission is unavailable.");
		});
		expect(changed).toBe(true);
		expect(callback).toBe(false);
		expect(application?.inTransaction).toBe(false);
		expect(writer.prepare("SELECT value FROM IntentProbe WHERE id=1").get()).toEqual({ value: 0 });
		expect(losses).toBe(1);
		writer.exec("BEGIN IMMEDIATE;ROLLBACK");
	});

	// A revoked runtime ticket is fenced synchronously before even the zero-row
	// native reservation. No application SQL may follow that loan's invalidation.
	it("rejects a revoked ticket before reservation or application writes", async () => {
		let revoked = false,
			callback = false,
			reservations = 0;
		const context = getRestoreRuntimeClientContext(runtime);
		const prepare = Database.prototype.prepare;
		vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
			this: Database.Database,
			sql,
		) {
			const statement = prepare.call(this, sql);
			if (this.name === path && sql === 'UPDATE "RestoreRuntimeControl" SET "id"="id" WHERE 0')
				reservations += 1;
			if (this.name === path && sql === "BEGIN") {
				const run = statement.run;
				statement.run = function (...args: unknown[]) {
					const value = Reflect.apply(run, this, args);
					if (!revoked) {
						revoked = true;
						context.unavailable("native-owner-unavailable");
					}
					return value;
				};
			}
			return statement;
		});
		await runtime.runOperation(async () => {
			await expect(
				client.prisma.$transaction(async () => {
					callback = true;
				}),
			).rejects.toThrow("Restore runtime admission is unavailable.");
		});
		expect(revoked).toBe(true);
		expect(callback).toBe(false);
		expect(reservations).toBe(0);
		expect(losses).toBe(1);
		writer.exec("BEGIN IMMEDIATE;ROLLBACK");
	});

	// If rollback itself cannot be confirmed, retain the first admission error,
	// physically close the driver and fail subsequent work closed.
	it.each(["write", "default"] as const)(
		"preserves the %s failure contract and closes the driver when native rollback is uncertain",
		async (mode) => {
			if (mode === "default") {
				await client.close();
				client = createRuntimePrismaClient(runtime);
			}
			let callback = false,
				changed = false;
			let application: Database.Database | undefined;
			const prepare = Database.prototype.prepare;
			vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
				this: Database.Database,
				sql,
			) {
				if (this === application && sql === "ROLLBACK")
					throw new Error("Synthetic uncertain native rollback");
				const statement = prepare.call(this, sql);
				if (this.name === path && sql === "BEGIN") {
					application = this;
					const db = this,
						run = statement.run;
					statement.run = function (...args: unknown[]) {
						const value = Reflect.apply(run, this, args);
						if (!changed) {
							changed = true;
							db.exec("UPDATE RestoreRuntimeControl SET phase='invalid'");
						}
						return value;
					};
				}
				return statement;
			});
			await runtime.runOperation(async () => {
				await expect(
					client.prisma.$transaction(async () => {
						callback = true;
					}),
				).rejects.toThrow(
					mode === "write"
						? "Restore runtime admission is unavailable."
						: "Synthetic uncertain native rollback",
				);
			});
			expect(changed).toBe(true);
			expect(callback).toBe(false);
			expect(application?.open).toBe(false);
			expect(losses).toBe(1);
			await expect(
				runtime.runOperation(() => client.prisma.$queryRawUnsafe("SELECT 1")),
			).rejects.toMatchObject({ statusCode: 503 });
			writer.exec("BEGIN IMMEDIATE;ROLLBACK");
		},
	);
});
