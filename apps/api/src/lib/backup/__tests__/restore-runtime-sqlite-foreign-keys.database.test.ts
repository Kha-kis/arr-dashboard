import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openRestoreRuntime, type RestoreRuntime } from "../restore-runtime-admission.js";
import {
	createRuntimePrismaClient,
	createRuntimeSessionMetadataPrismaClient,
} from "../restore-runtime-client.js";

describe.skipIf(process.platform !== "linux")("guarded SQLite foreign-key enforcement", () => {
	let directory: string;
	let path: string;
	let runtime: RestoreRuntime;
	let client: ReturnType<typeof createRuntimePrismaClient> | undefined;
	let losses: number;
	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), "arr-runtime-fk-"));
		chmodSync(directory, 0o700);
		path = join(directory, "main.db");
		const db = new Database(path);
		db.pragma("journal_mode=WAL");
		db.pragma("foreign_keys=ON");
		db.exec(`CREATE TABLE RestoreRuntimeControl (
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
			CREATE TABLE RuntimeFkParent(id INTEGER PRIMARY KEY);
			CREATE TABLE RuntimeFkChild(id INTEGER PRIMARY KEY,parentId INTEGER REFERENCES RuntimeFkParent(id));
			INSERT INTO RuntimeFkParent VALUES(1);
			INSERT INTO RuntimeFkChild VALUES(1,1);`);
		db.close();
		chmodSync(path, 0o600);
		losses = 0;
		runtime = await openRestoreRuntime({
			databaseUrl: `file:${path}`,
			onUnavailable: () => losses++,
		});
		await runtime.bindDestination("synthetic-destination");
		await runtime.activate();
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await client?.close();
		client = undefined;
		await runtime?.close();
		if (directory) rmSync(directory, { recursive: true, force: true });
	});
	function rows() {
		const db = new Database(path, { readonly: true });
		try {
			return db.prepare("SELECT id,parentId FROM RuntimeFkChild ORDER BY id").all();
		} finally {
			db.close();
		}
	}
	it.each([
		["ordinary", createRuntimePrismaClient],
		["session", createRuntimeSessionMetadataPrismaClient],
	] as const)("refuses cancelable deferred enforcement on %s", async (_, create) => {
		client = create(runtime);
		let modeAccepted = false;
		await expect(
			runtime.runOperation(() =>
				client!.prisma.$transaction(async (tx) => {
					await tx.$executeRawUnsafe("PRAGMA defer_foreign_keys=ON");
					modeAccepted = true;
					await tx.$executeRawUnsafe("INSERT INTO RuntimeFkChild VALUES(2,999)");
					await tx.$executeRawUnsafe("PRAGMA defer_foreign_keys=OFF");
				}),
			),
		).rejects.toThrow();
		expect(modeAccepted).toBe(false);
		expect(rows()).toEqual([{ id: 1, parentId: 1 }]);
		expect(losses).toBe(1);
	});
	it.each([
		["ordinary", createRuntimePrismaClient],
		["session", createRuntimeSessionMetadataPrismaClient],
	] as const)(
		"refuses a disabled FK mode before an orphan can persist on %s",
		async (_, create) => {
			client = create(runtime);
			await expect(
				runtime.runOperation(() =>
					client!.prisma.$queryRawUnsafe("SELECT COUNT(*) AS count FROM RuntimeFkChild"),
				),
			).resolves.toEqual([{ count: 1n }]);
			let disabledRejected = false;
			let orphanRejected = false;
			try {
				await runtime.runOperation(async () => {
					try {
						await client!.prisma.$executeRawUnsafe('PRAGMA /* native flag */ "foreign_keys"=OFF');
					} catch {
						disabledRejected = true;
					}
					try {
						await client!.prisma.$executeRawUnsafe("INSERT INTO RuntimeFkChild VALUES(2,999)");
					} catch {
						orphanRejected = true;
					}
				});
			} catch {
				// Detection may terminally revoke the current ordinary operation too.
			}
			expect(rows()).toEqual([{ id: 1, parentId: 1 }]);
			expect(disabledRejected).toBe(true);
			expect(orphanRejected).toBe(true);
			expect(losses).toBe(1);
			await expect(runtime.runOperation(() => 7)).rejects.toThrow();
		},
	);
	it.each([
		["ordinary", createRuntimePrismaClient],
		["session", createRuntimeSessionMetadataPrismaClient],
	] as const)(
		"retains valid commits and rolls back constraint failure on %s",
		async (_, create) => {
			client = create(runtime);
			await runtime.runOperation(async () => {
				await client!.prisma.$transaction(async (tx) => {
					await tx.$executeRawUnsafe("INSERT INTO RuntimeFkChild VALUES(2,1),(3,NULL)");
				});
				await expect(
					client!.prisma.$transaction(async (tx) => {
						await tx.$executeRawUnsafe("INSERT INTO RuntimeFkChild VALUES(4,1)");
						await tx.$executeRawUnsafe("INSERT INTO RuntimeFkChild VALUES(5,999)");
					}),
				).rejects.toThrow();
				expect(
					await client!.prisma.$queryRawUnsafe("SELECT COUNT(*) AS count FROM RuntimeFkChild"),
				).toEqual([{ count: 3n }]);
			});
			expect(rows()).toEqual([
				{ id: 1, parentId: 1 },
				{ id: 2, parentId: 1 },
				{ id: 3, parentId: null },
			]);
			expect(losses).toBe(0);
		},
	);
	it("rejects and physically closes a newly connected handle with FK mode disabled", async () => {
		const connect = PrismaBetterSqlite3.prototype.connect;
		let physical: Database.Database | undefined;
		vi.spyOn(PrismaBetterSqlite3.prototype, "connect").mockImplementation(async function (
			this: PrismaBetterSqlite3,
		) {
			const driver = await connect.call(this);
			physical = Reflect.get(driver, "client") as Database.Database;
			physical.pragma("foreign_keys=OFF");
			return driver;
		});
		client = createRuntimePrismaClient(runtime);
		await expect(runtime.runOperation(() => client!.prisma.$connect())).rejects.toThrow();
		expect(physical).toBeDefined();
		expect(physical!.open).toBe(false);
		expect(rows()).toEqual([{ id: 1, parentId: 1 }]);
		expect(losses).toBe(1);
	});
	it("fences an FK mode change after the awaited guard before the native insert", async () => {
		const connect = PrismaBetterSqlite3.prototype.connect;
		let armed = false;
		let disabled = false;
		vi.spyOn(PrismaBetterSqlite3.prototype, "connect").mockImplementation(async function (
			this: PrismaBetterSqlite3,
		) {
			const driver = await connect.call(this);
			const physical = Reflect.get(driver, "client") as Database.Database;
			const query = driver.queryRaw.bind(driver);
			vi.spyOn(driver, "queryRaw").mockImplementation(async (statement) => {
				const result = await query(statement);
				if (armed && statement.sql.includes("FROM SqliteRestoreStorageBinding")) {
					armed = false;
					queueMicrotask(() => {
						physical.pragma("foreign_keys=OFF");
						disabled = true;
					});
				}
				return result;
			});
			return driver;
		});
		client = createRuntimePrismaClient(runtime);
		await runtime.runOperation(() => client!.prisma.$connect());
		armed = true;
		await expect(
			runtime.runOperation(() =>
				client!.prisma.$executeRawUnsafe("INSERT INTO RuntimeFkChild VALUES(2,999)"),
			),
		).rejects.toThrow();
		expect(disabled).toBe(true);
		expect(rows()).toEqual([{ id: 1, parentId: 1 }]);
		expect(losses).toBe(1);
	});
	it("detects a mode-changing pragma even when queryRaw itself rejects it", async () => {
		client = createRuntimePrismaClient(runtime);
		await runtime.runOperation(() => client!.prisma.$connect());
		let orphanRejected = false;
		try {
			await runtime.runOperation(async () => {
				await expect(client!.prisma.$queryRawUnsafe("PRAGMA foreign_keys=OFF")).rejects.toThrow();
				try {
					await client!.prisma.$executeRawUnsafe("INSERT INTO RuntimeFkChild VALUES(2,999)");
				} catch {
					orphanRejected = true;
				}
			});
		} catch {
			// The mode violation also revokes the outer operation's admission.
		}
		expect(orphanRejected).toBe(true);
		expect(rows()).toEqual([{ id: 1, parentId: 1 }]);
		expect(losses).toBe(1);
	});
	it("rechecks FK enforcement before retrying an actual busy native statement", async () => {
		const sql = "INSERT INTO RuntimeFkChild VALUES(2,999)";
		const writer = new Database(path, { timeout: 0 });
		const connect = PrismaBetterSqlite3.prototype.connect;
		let busyObserved = false;
		let nativeCalls = 0;
		vi.spyOn(PrismaBetterSqlite3.prototype, "connect").mockImplementation(async function (
			this: PrismaBetterSqlite3,
		) {
			const driver = await connect.call(this);
			const physical = Reflect.get(driver, "client") as Database.Database;
			const execute = driver.executeRaw.bind(driver);
			vi.spyOn(driver, "executeRaw").mockImplementation(async (statement) => {
				if (statement.sql === sql) nativeCalls++;
				try {
					return await execute(statement);
				} catch (error) {
					const cause = error instanceof Error ? error.cause : undefined;
					if (
						statement.sql === sql &&
						cause &&
						typeof cause === "object" &&
						"originalCode" in cause &&
						cause.originalCode === "SQLITE_BUSY"
					) {
						busyObserved = true;
						writer.exec("ROLLBACK");
						physical.pragma("foreign_keys=OFF");
					}
					throw error;
				}
			});
			return driver;
		});
		try {
			client = createRuntimePrismaClient(runtime);
			await runtime.runOperation(() => client!.prisma.$connect());
			writer.exec("BEGIN IMMEDIATE");
			await expect(
				runtime.runOperation(() => client!.prisma.$executeRawUnsafe(sql)),
			).rejects.toThrow();
			expect(busyObserved).toBe(true);
			expect(nativeCalls).toBe(1);
			expect(rows()).toEqual([{ id: 1, parentId: 1 }]);
			expect(losses).toBe(1);
		} finally {
			if (writer.inTransaction) writer.exec("ROLLBACK");
			writer.close();
		}
	});
});
