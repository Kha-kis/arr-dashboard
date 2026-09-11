import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../generated/prisma/client.js";
import { createRecoverableSqliteAdapter } from "../sqlite-adapter.js";

type SqliteAdapter = Awaited<ReturnType<PrismaBetterSqlite3["connect"]>>;
type SqlQuery = Parameters<SqliteAdapter["executeRaw"]>[0];

const query = (sql: string, args: unknown[] = []): SqlQuery => ({
	sql,
	args,
	argTypes: args.map((arg) => ({
		scalarType: typeof arg === "number" ? "int" : "string",
		arity: "scalar",
	})),
});

const directories: string[] = [];
const databases: Database.Database[] = [];
const adapters: SqliteAdapter[] = [];
const clients: PrismaClient[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const client of clients.splice(0)) {
		await client.$disconnect().catch(() => undefined);
	}
	for (const adapter of adapters.splice(0)) {
		await adapter.dispose().catch(() => undefined);
	}
	for (const database of databases.splice(0)) {
		if (database.open) database.close();
	}
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createDatabase(): { directory: string; databasePath: string } {
	const directory = mkdtempSync(join(tmpdir(), "sqlite-adapter-"));
	const databasePath = join(directory, "adapter.db");
	const database = new Database(databasePath);
	database.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
	database.close();
	directories.push(directory);
	return { directory, databasePath };
}

async function connect(databasePath: string, timeout = 0): Promise<SqliteAdapter> {
	const adapter = createRecoverableSqliteAdapter({ url: databasePath, timeout });
	const connection = await adapter.connect();
	adapters.push(connection);
	return connection;
}

describe("recoverable SQLite adapter", () => {
	it("rolls back a busy COMMIT before releasing the mutex for a waiting transaction", async () => {
		const { databasePath } = createDatabase();
		const reader = new Database(databasePath, { timeout: 0 });
		databases.push(reader);
		reader.exec("BEGIN");
		reader.prepare("SELECT * FROM records").all();

		const connection = await connect(databasePath);
		const first = await connection.startTransaction();
		await first.executeRaw(query("INSERT INTO records(value) VALUES (?)", ["discarded"]));
		const waiting = connection.startTransaction();

		let commitError: unknown;
		try {
			await first.executeRaw(query("COMMIT"));
		} catch (error) {
			commitError = error;
		}
		expect(commitError).toMatchObject({ cause: { originalCode: "SQLITE_BUSY" } });

		const second = await waiting;
		await first.rollback();
		reader.exec("ROLLBACK");
		await second.executeRaw(query("INSERT INTO records(value) VALUES (?)", ["kept"]));
		await second.executeRaw(query("COMMIT"));
		await second.commit();

		const external = new Database(databasePath, { timeout: 0 });
		databases.push(external);
		expect(external.prepare("SELECT value FROM records").all()).toEqual([{ value: "kept" }]);
	});

	it("keeps ordinary commit and rollback behavior unchanged", async () => {
		const { databasePath } = createDatabase();
		const connection = await connect(databasePath);

		const committed = await connection.startTransaction();
		await committed.executeRaw(query("INSERT INTO records(value) VALUES (?)", ["committed"]));
		await committed.executeRaw(query("COMMIT"));
		await committed.commit();

		const rolledBack = await connection.startTransaction();
		await rolledBack.executeRaw(query("INSERT INTO records(value) VALUES (?)", ["discarded"]));
		await rolledBack.executeRaw(query("ROLLBACK"));
		await rolledBack.rollback();

		const external = new Database(databasePath);
		databases.push(external);
		expect(external.prepare("SELECT value FROM records").all()).toEqual([{ value: "committed" }]);
	});

	it("rejects a pending transaction when the driver is disposed", async () => {
		const { databasePath } = createDatabase();
		const connection = await connect(databasePath);
		await connection.startTransaction();
		const pending = connection.startTransaction();

		await connection.dispose();
		await expect(pending).rejects.toThrow("SQLite driver is unavailable");
	});

	it("recovers the real Prisma interactive transaction engine after a busy COMMIT", async () => {
		const { databasePath } = createDatabase();
		const client = new PrismaClient({
			adapter: createRecoverableSqliteAdapter({ url: databasePath, timeout: 0 }),
		});
		clients.push(client);
		await client.$connect();
		const reader = new Database(databasePath, { timeout: 0 });
		databases.push(reader);
		reader.exec("BEGIN");
		reader.prepare("SELECT * FROM records").all();

		let firstWriteStarted!: () => void;
		const firstWriteReady = new Promise<void>((resolve) => {
			firstWriteStarted = resolve;
		});
		const first = Promise.resolve(
			client.$transaction(async (transaction) => {
				await transaction.$executeRawUnsafe("INSERT INTO records(value) VALUES (?)", "discarded");
				firstWriteStarted();
			}),
		);
		await firstWriteReady;

		let secondCallbackStarted!: () => void;
		const secondCallbackReady = new Promise<void>((resolve) => {
			secondCallbackStarted = resolve;
		});
		let allowSecondWrite!: () => void;
		const secondWriteGate = new Promise<void>((resolve) => {
			allowSecondWrite = resolve;
		});
		const second = Promise.resolve(
			client.$transaction(async (transaction) => {
				secondCallbackStarted();
				await secondWriteGate;
				await transaction.$executeRawUnsafe("INSERT INTO records(value) VALUES (?)", "kept");
			}),
		);

		const firstError = await first.then(
			() => undefined,
			(error) => error,
		);
		expect(firstError).toMatchObject({ cause: { originalCode: "SQLITE_BUSY" } });
		await secondCallbackReady;

		reader.exec("ROLLBACK");
		allowSecondWrite();
		await second;
		await client.$disconnect();
		clients.splice(clients.indexOf(client), 1);

		const external = new Database(databasePath, { timeout: 0 });
		databases.push(external);
		expect(external.prepare("SELECT value FROM records ORDER BY id").all()).toEqual([
			{ value: "kept" },
		]);
	});

	it("rejects a queued Prisma transaction promptly when recovery itself fails", async () => {
		const { databasePath } = createDatabase();
		const baseDriver = await new PrismaBetterSqlite3({ url: databasePath, timeout: 0 }).connect();
		const commitError = new Error("commit failed");
		const rollbackError = new Error("rollback failed");
		const rawStartTransaction = baseDriver.startTransaction.bind(baseDriver);
		vi.spyOn(baseDriver, "startTransaction").mockImplementation(async (isolationLevel) => {
			const rawTransaction = await rawStartTransaction(isolationLevel);
			const rawExecuteRaw = rawTransaction.executeRaw.bind(rawTransaction);
			vi.spyOn(rawTransaction, "executeRaw").mockImplementation(async (statement) => {
				if (statement.sql === "COMMIT") throw commitError;
				if (statement.sql === "ROLLBACK") throw rollbackError;
				return rawExecuteRaw(statement);
			});
			return rawTransaction;
		});
		vi.spyOn(PrismaBetterSqlite3.prototype, "connect").mockResolvedValue(baseDriver);

		const client = new PrismaClient({
			adapter: createRecoverableSqliteAdapter({ url: databasePath, timeout: 0 }),
		});
		clients.push(client);
		await client.$connect();
		let secondCallbackRan = false;
		const first = Promise.resolve(
			client.$transaction(async (transaction) => {
				await transaction.$executeRawUnsafe("INSERT INTO records(value) VALUES (?)", "discarded");
			}),
		);
		const second = Promise.resolve(
			client.$transaction(async (transaction) => {
				secondCallbackRan = true;
				await transaction.$executeRawUnsafe("INSERT INTO records(value) VALUES (?)", "unsafe");
			}),
		);

		const startedAt = Date.now();
		const firstError = await first.then(
			() => undefined,
			(error) => error,
		);
		expect(firstError).toBeDefined();
		await expect(second).rejects.toBeDefined();
		expect(Date.now() - startedAt).toBeLessThan(1_000);
		expect(secondCallbackRan).toBe(false);

		const external = new Database(databasePath, { timeout: 0 });
		databases.push(external);
		expect(external.prepare("SELECT value FROM records").all()).toEqual([]);
	});

	it("poisons and disposes the driver when recovery rollback fails", async () => {
		const { databasePath } = createDatabase();
		const baseDriver = await new PrismaBetterSqlite3({ url: databasePath, timeout: 0 }).connect();
		const rawTransaction = await baseDriver.startTransaction();
		const commitError = new Error("commit failed");
		const rollbackError = new Error("rollback failed");
		const rawExecuteRaw = rawTransaction.executeRaw.bind(rawTransaction);
		vi.spyOn(rawTransaction, "executeRaw").mockImplementation(async (statement) => {
			if (statement.sql === "COMMIT") throw commitError;
			if (statement.sql === "ROLLBACK") throw rollbackError;
			return rawExecuteRaw(statement);
		});
		const rawRollback = vi.spyOn(rawTransaction, "rollback");
		const rawStartTransaction = vi
			.spyOn(baseDriver, "startTransaction")
			.mockResolvedValue(rawTransaction);
		const rawDispose = vi.spyOn(baseDriver, "dispose");
		vi.spyOn(PrismaBetterSqlite3.prototype, "connect").mockResolvedValue(baseDriver);

		const connection = await connect(databasePath);
		const transaction = await connection.startTransaction();
		await expect(transaction.executeRaw(query("COMMIT"))).rejects.toBe(commitError);
		expect(rawRollback).not.toHaveBeenCalled();
		expect(rawStartTransaction).toHaveBeenCalledTimes(1);
		expect(rawDispose).toHaveBeenCalledTimes(1);
		await expect(connection.queryRaw(query("SELECT 1"))).rejects.toThrow(
			"SQLite driver is unavailable",
		);
		await connection.dispose();
		expect(rawDispose).toHaveBeenCalledTimes(1);
	});

	it("poisons the driver when transaction cleanup release fails after COMMIT", async () => {
		const { databasePath } = createDatabase();
		const baseDriver = await new PrismaBetterSqlite3({ url: databasePath, timeout: 0 }).connect();
		const rawTransaction = await baseDriver.startTransaction();
		const cleanupError = new Error("mutex release failed");
		vi.spyOn(rawTransaction, "commit").mockRejectedValue(cleanupError);
		vi.spyOn(baseDriver, "startTransaction").mockResolvedValue(rawTransaction);
		const rawDispose = vi.spyOn(baseDriver, "dispose");
		vi.spyOn(PrismaBetterSqlite3.prototype, "connect").mockResolvedValue(baseDriver);

		const connection = await connect(databasePath);
		const transaction = await connection.startTransaction();
		await transaction.executeRaw(query("COMMIT"));
		await expect(transaction.commit()).rejects.toBe(cleanupError);
		expect(rawDispose).toHaveBeenCalledTimes(1);
		await expect(connection.executeRaw(query("SELECT 1"))).rejects.toThrow(
			"SQLite driver is unavailable",
		);
	});
});
