import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../generated/prisma/client.js";
import { createRecoverableSqliteAdapter, type SqliteStatementFence } from "../sqlite-adapter.js";

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
	it("honors a shorter fenced busy budget without losing native lock provenance", async () => {
		const { databasePath } = createDatabase();
		const writer = new Database(databasePath, { timeout: 0 });
		databases.push(writer);
		const fences = new WeakMap<SqlQuery, SqliteStatementFence>();
		const connection = await createRecoverableSqliteAdapter(
			{ url: databasePath, timeout: 0 },
			undefined,
			undefined,
			fences,
		).connect();
		adapters.push(connection);
		writer.exec("BEGIN IMMEDIATE");
		const statement = query("INSERT INTO records(value) VALUES('never-written')");
		fences.set(statement, { async revalidate() {}, assert() {}, busyRetryMs: 20 });
		const started = performance.now();
		await expect(connection.executeRaw(statement)).rejects.toMatchObject({
			name: "DriverAdapterError",
			cause: { originalCode: "SQLITE_BUSY" },
		});
		expect(performance.now() - started).toBeLessThan(1_000);
		writer.exec("ROLLBACK");
		expect(writer.prepare("SELECT * FROM records").all()).toEqual([]);
		await connection.executeRaw(query("INSERT INTO records(value) VALUES('later')"));
		expect(writer.prepare("SELECT value FROM records").all()).toEqual([{ value: "later" }]);
	}, 10_000);
	it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 5_001])(
		"refuses invalid internal busy budget %s before SQL",
		async (busyRetryMs) => {
			const { databasePath } = createDatabase();
			const fences = new WeakMap<SqlQuery, SqliteStatementFence>();
			const connection = await createRecoverableSqliteAdapter(
				{ url: databasePath, timeout: 0 },
				undefined,
				undefined,
				fences,
			).connect();
			adapters.push(connection);
			const statement = query("INSERT INTO records(value) VALUES('never-written')");
			fences.set(statement, { async revalidate() {}, assert() {}, busyRetryMs });
			await expect(connection.executeRaw(statement)).rejects.toThrow(
				"Invalid internal SQLite busy retry budget",
			);
			expect(await connection.queryRaw(query("SELECT value FROM records"))).toMatchObject({
				rows: [],
			});
		},
	);
	it.each(["revalidate", "assert"] as const)(
		"preserves primary busy only for its exact closed transaction during %s",
		async (boundary) => {
			const { databasePath } = createDatabase();
			const writer = new Database(databasePath, { timeout: 0 });
			databases.push(writer);
			const fences = new WeakMap<SqlQuery, SqliteStatementFence>();
			const connection = await createRecoverableSqliteAdapter(
				{ url: databasePath, timeout: 0 },
				undefined,
				undefined,
				fences,
			).connect();
			adapters.push(connection);
			writer.exec("BEGIN IMMEDIATE");
			const closed = new Error("Synthetic exact transaction lifetime");
			let revalidated = false;
			const statement = query("INSERT INTO records(value) VALUES('never-written')");
			fences.set(statement, {
				async revalidate() {
					revalidated = true;
					if (boundary === "revalidate") throw closed;
				},
				assert() {
					if (boundary === "assert" && revalidated) throw closed;
				},
				isClosedTransactionError: (error) => error === closed,
			});
			await expect(connection.executeRaw(statement)).rejects.toMatchObject({
				name: "DriverAdapterError",
				cause: { originalCode: "SQLITE_BUSY" },
			});
			writer.exec("ROLLBACK");
			expect(writer.prepare("SELECT * FROM records").all()).toEqual([]);
		},
	);
	it.each([
		"no-busy",
		"other-transaction",
		"ownership",
		"ticket",
		"binding",
		"cancellation",
		"cleanup",
		"poison",
	])("propagates %s denial without busy substitution or later SQL", async (boundary) => {
		const { databasePath } = createDatabase();
		const writer = new Database(databasePath, { timeout: 0 });
		databases.push(writer);
		const fences = new WeakMap<SqlQuery, SqliteStatementFence>();
		const connection = await createRecoverableSqliteAdapter(
			{ url: databasePath, timeout: 0 },
			undefined,
			undefined,
			fences,
		).connect();
		adapters.push(connection);
		const closed = new Error("Synthetic exact transaction lifetime"),
			denied = boundary === "no-busy" ? closed : new Error("Synthetic independent guard denial");
		const statement = query("INSERT INTO records(value) VALUES('never-written')");
		fences.set(statement, {
			async revalidate() {
				throw denied;
			},
			assert() {
				if (boundary === "no-busy") throw denied;
			},
			isClosedTransactionError: (error) => error === closed,
		});
		if (boundary !== "no-busy") writer.exec("BEGIN IMMEDIATE");
		await expect(connection.executeRaw(statement)).rejects.toBe(denied);
		if (writer.inTransaction) writer.exec("ROLLBACK");
		expect(writer.prepare("SELECT * FROM records").all()).toEqual([]);
	});
	it("does not roll back a reused native transaction after an earlier busy COMMIT loses its lifetime", async () => {
		const { databasePath } = createDatabase();
		const reader = new Database(databasePath, { timeout: 0 });
		databases.push(reader);
		reader.exec("BEGIN");
		reader.prepare("SELECT * FROM records").all();
		const fences = new WeakMap<SqlQuery, { revalidate(): Promise<void>; assert(): void }>();
		const connection = await createRecoverableSqliteAdapter(
			{ url: databasePath, timeout: 0 },
			undefined,
			undefined,
			fences,
		).connect();
		adapters.push(connection);
		const first = await connection.startTransaction();
		await first.executeRaw(query("INSERT INTO records(value) VALUES('discarded')"));
		const commit = query("COMMIT");
		let notifyWaiting!: () => void, resume!: () => void;
		const waiting = new Promise<void>((resolve) => {
			notifyWaiting = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const ended = new Error("Original transaction ended");
		fences.set(commit, {
			async revalidate() {
				notifyWaiting();
				await gate;
				throw ended;
			},
			assert() {},
		});
		const pending = first.executeRaw(commit).then(
			() => undefined,
			(error) => error,
		);
		await waiting;
		await first.executeRaw(query("ROLLBACK"));
		await first.rollback();
		reader.exec("ROLLBACK");
		const second = await connection.startTransaction();
		await second.executeRaw(query("INSERT INTO records(value) VALUES('kept')"));
		resume();
		expect(await pending).toBe(ended);
		await second.executeRaw(query("COMMIT"));
		await second.commit();
		expect(reader.prepare("SELECT value FROM records").all()).toEqual([{ value: "kept" }]);
	});

	it("waits below COMMIT recovery until a real DELETE-mode reader releases, without replaying its write", async () => {
		const { databasePath } = createDatabase();
		const reader = new Database(databasePath, { timeout: 0 });
		databases.push(reader);
		reader.exec("BEGIN");
		reader.prepare("SELECT * FROM records").all();
		const fences = new WeakMap<SqlQuery, { revalidate(): Promise<void>; assert(): void }>();
		const connection = await createRecoverableSqliteAdapter(
			{ url: databasePath, timeout: 0 },
			undefined,
			undefined,
			fences,
		).connect();
		adapters.push(connection);
		const transaction = await connection.startTransaction();
		await transaction.executeRaw(query("INSERT INTO records(value) VALUES ('once')"));
		const commit = query("COMMIT");
		const native = Reflect.get(connection, "client") as Database.Database;
		let revalidations = 0;
		fences.set(commit, {
			async revalidate() {
				revalidations++;
				expect(native.inTransaction).toBe(true);
			},
			assert() {
				expect(native.open && native.inTransaction).toBe(true);
			},
		});
		const release = setTimeout(() => reader.exec("ROLLBACK"), 40);
		try {
			await transaction.executeRaw(commit);
			await transaction.commit();
		} finally {
			clearTimeout(release);
			if (reader.inTransaction) reader.exec("ROLLBACK");
		}
		expect(revalidations).toBeGreaterThan(0);
		expect(reader.prepare("SELECT * FROM records").all()).toEqual([{ id: 1, value: "once" }]);
	});

	it("bounds yielding busy COMMIT before confirmed rollback and releases its mutex for real reuse", async () => {
		const { databasePath } = createDatabase();
		const reader = new Database(databasePath, { timeout: 0 });
		databases.push(reader);
		reader.exec("BEGIN");
		reader.prepare("SELECT * FROM records").all();
		const fences = new WeakMap<SqlQuery, { revalidate(): Promise<void>; assert(): void }>();
		const connection = await createRecoverableSqliteAdapter(
			{ url: databasePath, timeout: 0 },
			undefined,
			undefined,
			fences,
		).connect();
		adapters.push(connection);
		const first = await connection.startTransaction();
		await first.executeRaw(query("INSERT INTO records(value) VALUES ('discarded')"));
		const waiting = connection.startTransaction();
		const commit = query("COMMIT");
		fences.set(commit, { async revalidate() {}, assert() {} });
		let ticks = 0;
		const tick = setInterval(() => {
			ticks++;
		}, 10);
		const started = performance.now();
		try {
			await expect(first.executeRaw(commit)).rejects.toMatchObject({
				name: "DriverAdapterError",
				cause: { originalCode: "SQLITE_BUSY" },
			});
		} finally {
			clearInterval(tick);
		}
		expect(performance.now() - started).toBeGreaterThanOrEqual(4900);
		expect(performance.now() - started).toBeLessThan(6500);
		expect(ticks).toBeGreaterThan(10);
		const second = await waiting;
		await first.rollback();
		reader.exec("ROLLBACK");
		await second.executeRaw(query("INSERT INTO records(value) VALUES ('kept')"));
		await second.executeRaw(query("COMMIT"));
		await second.commit();
		expect(reader.prepare("SELECT value FROM records").all()).toEqual([{ value: "kept" }]);
	}, 15000);

	it("does not retry real WAL BUSY_SNAPSHOT or native constraint and SQL errors", async () => {
		const { databasePath } = createDatabase();
		const writer = new Database(databasePath, { timeout: 0 });
		databases.push(writer);
		writer.pragma("journal_mode=WAL");
		const fences = new WeakMap<SqlQuery, { revalidate(): Promise<void>; assert(): void }>();
		const connection = await createRecoverableSqliteAdapter(
			{ url: databasePath, timeout: 0 },
			undefined,
			undefined,
			fences,
		).connect();
		adapters.push(connection);
		const transaction = await connection.startTransaction();
		await transaction.queryRaw(query("SELECT * FROM records"));
		writer.exec("INSERT INTO records VALUES(1,'external')");
		let revalidations = 0;
		const fence = {
			async revalidate() {
				revalidations++;
			},
			assert() {},
		};
		const stale = query("INSERT INTO records VALUES(2,'stale')");
		fences.set(stale, fence);
		await expect(transaction.executeRaw(stale)).rejects.toMatchObject({
			code: "SQLITE_BUSY_SNAPSHOT",
		});
		await transaction.executeRaw(query("ROLLBACK"));
		await transaction.rollback();
		for (const [sql, code] of [
			["INSERT INTO records VALUES(1,'duplicate')", "SQLITE_CONSTRAINT_PRIMARYKEY"],
			["INSERT INTO missing VALUES(1)", "SQLITE_ERROR"],
		]) {
			const statement = query(sql!);
			fences.set(statement, fence);
			await expect(connection.executeRaw(statement)).rejects.toMatchObject({
				cause: { originalCode: code },
			});
		}
		expect(revalidations).toBe(0);
		const native = Reflect.get(connection, "client") as Database.Database;
		const cursor = native.prepare("SELECT * FROM records").iterate();
		cursor.next();
		const locked = query("DROP TABLE records");
		fences.set(locked, fence);
		try {
			// This supported native driver refuses a concurrent cursor before SQLite
			// can report LOCKED. Its real TypeError must not enter contention retry.
			await expect(connection.executeRaw(locked)).rejects.toBeInstanceOf(TypeError);
		} finally {
			cursor.return?.();
		}
		expect(revalidations).toBe(0);
		expect(writer.prepare("SELECT * FROM records").all()).toEqual([{ id: 1, value: "external" }]);
	});

	it("keeps the generic adapter's native contention policy unchanged", async () => {
		const { databasePath } = createDatabase();
		const connection = await createRecoverableSqliteAdapter({ url: databasePath }).connect();
		adapters.push(connection);
		const native = Reflect.get(connection, "client") as Database.Database;
		expect(Number(native.pragma("busy_timeout", { simple: true }))).toBe(5000);
	});

	it("poisons pending and future work if a yielding COMMIT cannot confirm native rollback", async () => {
		const { databasePath } = createDatabase();
		const reader = new Database(databasePath, { timeout: 0 });
		databases.push(reader);
		reader.exec("BEGIN");
		reader.prepare("SELECT * FROM records").all();
		const fences = new WeakMap<SqlQuery, { revalidate(): Promise<void>; assert(): void }>();
		let unavailable = 0;
		const connection = await createRecoverableSqliteAdapter(
			{ url: databasePath, timeout: 0 },
			undefined,
			() => {
				unavailable++;
			},
			fences,
		).connect();
		adapters.push(connection);
		const first = await connection.startTransaction();
		await first.executeRaw(query("INSERT INTO records(value) VALUES('discarded')"));
		const native = Reflect.get(connection, "client") as Database.Database;
		const commit = query("COMMIT");
		const fenceError = new Error("Synthetic native lifetime ended");
		fences.set(commit, {
			async revalidate() {
				native.close();
				throw fenceError;
			},
			assert() {},
		});
		const waiting = connection.startTransaction().then(
			() => true,
			() => false,
		);
		await expect(first.executeRaw(commit)).rejects.toBe(fenceError);
		expect(await waiting).toBe(false);
		expect(native.open).toBe(false);
		expect(unavailable).toBe(1);
		await expect(connection.executeRaw(query("SELECT 1"))).rejects.toThrow(
			"SQLite driver is unavailable",
		);
		reader.exec("ROLLBACK");
		expect(reader.prepare("SELECT * FROM records").all()).toEqual([]);
	});

	it.each([
		{
			name: "default canonical policy",
			options: undefined,
			stored: [
				"1969-12-31T23:59:59.999+00:00",
				"1970-01-01T00:00:00.000+00:00",
				"2024-01-01T00:00:00.123+00:00",
			],
		},
		{
			name: "explicit ISO policy",
			options: { timestampFormat: "iso8601" as const },
			stored: [
				"1969-12-31T23:59:59.999+00:00",
				"1970-01-01T00:00:00.000+00:00",
				"2024-01-01T00:00:00.123+00:00",
			],
		},
		{
			name: "supported caller epoch policy",
			options: { timestampFormat: "unixepoch-ms" as const },
			stored: [-1, 0, 1_704_067_200_123],
		},
	])("preserves exact bound dates and predicates with $name", async ({ options, stored }) => {
		const { databasePath } = createDatabase();
		const connection = await createRecoverableSqliteAdapter(
			{ url: databasePath, timeout: 0 },
			options,
		).connect();
		adapters.push(connection);
		await connection.executeRaw(
			query("CREATE TABLE date_records(id INTEGER PRIMARY KEY, happenedAt DATETIME NOT NULL)"),
		);
		for (const [index, value] of [-1, 0, 1_704_067_200_123].entries()) {
			await connection.executeRaw({
				sql: "INSERT INTO date_records(id,happenedAt) VALUES(?,?)",
				args: [index + 1, new Date(value)],
				argTypes: [
					{ scalarType: "int", arity: "scalar" },
					{ scalarType: "datetime", arity: "scalar" },
				],
			});
		}
		const external = new Database(databasePath);
		databases.push(external);
		expect(
			external.prepare("SELECT happenedAt FROM date_records ORDER BY id").pluck().all(),
		).toEqual(stored);
		const result = await connection.queryRaw({
			sql: "SELECT id FROM date_records WHERE happenedAt >= ? ORDER BY happenedAt",
			args: [new Date(0)],
			argTypes: [{ scalarType: "datetime", arity: "scalar" }],
		});
		expect(result.rows).toEqual([[2], [3]]);
	});

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
