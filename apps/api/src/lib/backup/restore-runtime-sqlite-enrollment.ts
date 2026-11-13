import {
	chmodSync,
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { SqliteDateCompatibilityError } from "../sqlite-datetime.js";
import {
	acquireSqliteRestoreRuntimeOwnership,
	type SqliteRestoreRuntimeOwnership,
} from "./restore-runtime-sqlite.js";
import {
	resolveSqliteRestoreStorage,
	type SqliteRestoreStorage,
} from "./restore-runtime-sqlite-storage.js";
import {
	createInitialRestoreRuntimeRecord,
	parseRestoreRuntimeRecord,
	prepareRestoreRuntimeStartingRecord,
	type RestoreRuntimeRecord,
} from "./restore-runtime-state.js";
import {
	RuntimeSchemaStartupError,
	type RuntimeSchemaStartupSettings,
} from "./runtime-schema-startup.js";
import { timeSqliteStartupPhase } from "./runtime-schema-timing.js";
import { applySqliteStartupCacheHint } from "./runtime-sqlite-startup-cache.js";

export class SqliteRestoreRuntimeEnrollmentError extends Error {
	readonly statusCode = 503;
	constructor() {
		super("SQLite Restore runtime enrollment is unavailable");
		this.name = "SqliteRestoreRuntimeEnrollmentError";
	}
}
export type SqliteRestoreRuntimeEnrollment = Readonly<{
	storage: SqliteRestoreStorage;
	ownership: SqliteRestoreRuntimeOwnership;
}>;
export type SqliteRestoreRuntimeStartup = Readonly<{ runtimeEpoch: string }>;

const COLUMNS = [
	"id",
	"protocolVersion",
	"databaseDevice",
	"databaseInode",
	"directoryDevice",
	"directoryInode",
	"coordinationDevice",
	"coordinationInode",
	"ownerDevice",
	"ownerInode",
	"operationsDevice",
	"operationsInode",
] as const;
type Binding = Record<(typeof COLUMNS)[number], string | number>;

const RUNTIME_COLUMNS = [
	"id",
	"protocolVersion",
	"phase",
	"runtimeEpoch",
	"ownerBackendPid",
	"activeRestoreId",
	"lastCommittedRestoreId",
	"lastCommittedAt",
	"destinationInstallationId",
] as const;

function initialStartupRecord(
	startup: SqliteRestoreRuntimeStartup,
): Readonly<RestoreRuntimeRecord> {
	// Reject accessors/extra fields before touching storage. Capture only the
	// caller's canonical epoch; none of its later mutations become authority.
	if (typeof startup !== "object" || startup === null)
		throw new SqliteRestoreRuntimeEnrollmentError();
	const prototype = Object.getPrototypeOf(startup);
	const descriptor = Object.getOwnPropertyDescriptor(startup, "runtimeEpoch");
	if (
		(prototype !== Object.prototype && prototype !== null) ||
		Reflect.ownKeys(startup).length !== 1 ||
		!descriptor ||
		!("value" in descriptor)
	)
		throw new SqliteRestoreRuntimeEnrollmentError();
	return createInitialRestoreRuntimeRecord({
		runtimeEpoch: descriptor.value,
		ownerBackendPid: null,
	});
}

function writeStartingJournal(
	main: Database.Database,
	initial: Readonly<RestoreRuntimeRecord>,
	firstEnrollment: boolean,
): void {
	const rows = main
		.prepare(`SELECT ${RUNTIME_COLUMNS.join(", ")} FROM RestoreRuntimeControl LIMIT 2`)
		.all() as Record<string, unknown>[];
	if (firstEnrollment) {
		if (rows.length !== 0) throw new SqliteRestoreRuntimeEnrollmentError();
		main
			.prepare(`INSERT INTO RestoreRuntimeControl (${RUNTIME_COLUMNS.join(", ")})
			VALUES (${RUNTIME_COLUMNS.map((column) => `@${column}`).join(", ")})`)
			.run(initial);
		return;
	}
	if (rows.length !== 1) throw new SqliteRestoreRuntimeEnrollmentError();
	const raw = rows[0]!;
	const prior = parseSqliteRestoreRuntimeRecord(raw);
	const next = prepareRestoreRuntimeStartingRecord(prior, {
		runtimeEpoch: initial.runtimeEpoch!,
		ownerBackendPid: null,
	});
	const result = main
		.prepare(`UPDATE RestoreRuntimeControl
		SET phase = 'starting', runtimeEpoch = @nextEpoch, ownerBackendPid = NULL, activeRestoreId = NULL
		WHERE ${RUNTIME_COLUMNS.map((column) => `${column} IS @${column}`).join(" AND ")}`)
		.run({ ...raw, nextEpoch: next.runtimeEpoch });
	if (result.changes !== 1) throw new SqliteRestoreRuntimeEnrollmentError();
}

/** Normalize native storage evidence without rewriting its historical value. */
export function parseSqliteRestoreRuntimeRecord(
	value: Record<string, unknown>,
): Readonly<RestoreRuntimeRecord> {
	let timestamp = value.lastCommittedAt;
	if (typeof timestamp === "number") {
		if (!Number.isSafeInteger(timestamp)) throw new SqliteRestoreRuntimeEnrollmentError();
		timestamp = new Date(timestamp);
	} else if (typeof timestamp === "string" && timestamp.endsWith("+00:00")) {
		// The installed Prisma SQLite adapter writes UTC ISO with this suffix.
		// Normalize only the evidence projection; retain the original stored value.
		timestamp = `${timestamp.slice(0, -6)}Z`;
	}
	const prior = parseRestoreRuntimeRecord({
		...value,
		lastCommittedAt: timestamp,
	});
	// PostgreSQL's backend identity never belongs to a SQLite destination.
	if (prior.ownerBackendPid !== null) throw new SqliteRestoreRuntimeEnrollmentError();
	return prior;
}

function captureBinding(storage: SqliteRestoreStorage): Binding {
	storage.assertUnchanged();
	const result: Binding = { id: 1, protocolVersion: 1 } as Binding;
	for (const [prefix, path] of [
		["database", storage.databasePath],
		["directory", storage.directoryPath],
		["coordination", storage.coordinationDirectoryPath],
		["owner", join(storage.coordinationDirectoryPath, "owner.sqlite3")],
		["operations", join(storage.coordinationDirectoryPath, "operations.sqlite3")],
	] as const) {
		const stat = lstatSync(path, { bigint: true });
		result[`${prefix}Device`] = String(stat.dev);
		result[`${prefix}Inode`] = String(stat.ino);
	}
	storage.assertUnchanged();
	return result;
}

function assertBinding(storage: SqliteRestoreStorage, binding: Binding): void {
	const current = captureBinding(storage);
	if (COLUMNS.some((field) => binding[field] !== current[field])) {
		throw new SqliteRestoreRuntimeEnrollmentError();
	}
}

/** Actual native connection projection; this validation grants no ownership. */
export function assertSqliteRestoreRuntimeBindingRecord(
	storage: SqliteRestoreStorage,
	value: Record<string, unknown>,
): void {
	const current = captureBinding(storage);
	if (
		Reflect.ownKeys(value).length !== COLUMNS.length ||
		COLUMNS.some((field) => value[field] !== current[field])
	) {
		throw new SqliteRestoreRuntimeEnrollmentError();
	}
}

/** The actual control connection must still hold native participation. */
export function assertSqliteRestoreRuntimeStorageBinding(
	main: Database.Database,
	storage: SqliteRestoreStorage,
): void {
	const rows = main
		.prepare(`SELECT ${COLUMNS.join(", ")} FROM SqliteRestoreStorageBinding LIMIT 2`)
		.all() as Binding[];
	if (rows.length !== 1) throw new SqliteRestoreRuntimeEnrollmentError();
	assertBinding(storage, rows[0]!);
}

function createCoordination(storage: SqliteRestoreStorage): void {
	// Never adopt even a complete orphan: another process could hold its files.
	// Main writer serialization and this fresh private directory establish the
	// known-new namespace; no raw database descriptor is opened or closed.
	mkdirSync(storage.coordinationDirectoryPath, { mode: 0o700 });
	for (const [name, table] of [
		["owner.sqlite3", "RestoreOwnerCoordination"],
		["operations.sqlite3", "RestoreOperationCoordination"],
	] as const) {
		const path = join(storage.coordinationDirectoryPath, name);
		const db = new Database(path, { timeout: 0 });
		try {
			chmodSync(path, 0o600);
			if (db.pragma("journal_mode = DELETE", { simple: true }) !== "delete") {
				throw new SqliteRestoreRuntimeEnrollmentError();
			}
			db.pragma("synchronous = FULL");
			db.exec(`BEGIN IMMEDIATE;
				CREATE TABLE ${table} (id INTEGER PRIMARY KEY, protocolVersion INTEGER NOT NULL);
				INSERT INTO ${table} VALUES (1, 1);
				COMMIT`);
		} finally {
			db.close();
		}
	}
}

/**
 * Controlled cold bootstrap only: all old application actors must be stopped.
 * Returns exclusion, NOT a running epoch or permission for application work.
 * Never invoke in ordinary connection creation or silently repair prior state.
 */
export async function enrollSqliteRestoreRuntimeStorage(
	databaseUrl: string,
	startup?: SqliteRestoreRuntimeStartup,
): Promise<SqliteRestoreRuntimeEnrollment> {
	let main: Database.Database | undefined;
	let ownership: SqliteRestoreRuntimeOwnership | undefined;
	try {
		const initial = startup === undefined ? undefined : initialStartupRecord(startup);
		const storage = resolveSqliteRestoreStorage(databaseUrl);
		main = new Database(storage.databasePath, { fileMustExist: true, timeout: 0 });
		main.pragma("synchronous = FULL");
		main.exec("BEGIN IMMEDIATE");
		storage.assertUnchanged();
		const rows = main
			.prepare(`SELECT ${COLUMNS.join(", ")} FROM SqliteRestoreStorageBinding LIMIT 2`)
			.all() as Binding[];
		let binding: Binding;
		if (rows.length === 0) {
			if (main.prepare("SELECT id FROM RestoreRuntimeControl LIMIT 1").get()) {
				throw new SqliteRestoreRuntimeEnrollmentError();
			}
			createCoordination(storage);
			binding = captureBinding(storage);
		} else {
			if (rows.length !== 1) throw new SqliteRestoreRuntimeEnrollmentError();
			binding = rows[0]!;
			assertBinding(storage, binding);
		}
		// Acquisition validates private metadata and SQLite protocol. Retain both
		// native locks beyond the main transaction; COMMIT is not an owner grant.
		ownership = await acquireSqliteRestoreRuntimeOwnership(`file:${storage.databasePath}`);
		if (!(await ownership.tryAcquireExclusive())) {
			throw new SqliteRestoreRuntimeEnrollmentError();
		}
		assertBinding(storage, binding);
		if (rows.length === 0) {
			main
				.prepare(`INSERT INTO SqliteRestoreStorageBinding (${COLUMNS.join(", ")})
				VALUES (${COLUMNS.map((field) => `@${field}`).join(", ")})`)
				.run(binding);
		}
		// First journal and original binding share this same actual main commit.
		// Reconciliation also runs under the retained native owner/exclusion.
		if (initial) writeStartingJournal(main, initial, rows.length === 0);
		main.exec("COMMIT");
		main.close();
		main = undefined;
		await ownership.assertOwned();
		assertBinding(storage, binding);
		return Object.freeze({ storage, ownership });
	} catch {
		try {
			if (main?.inTransaction) main.exec("ROLLBACK");
		} catch {
			/* No authority escapes. */
		}
		try {
			if (main?.open) main.close();
		} catch {
			/* Retain generic failure. */
		}
		try {
			await ownership?.close();
		} catch {
			/* A failed close grants no capability. */
		}
		// Deliberately retain newly created unanchored coordination. A subsequent
		// bootstrap must refuse it instead of creating a second lock universe.
		throw new SqliteRestoreRuntimeEnrollmentError();
	}
}

function absent(path: string): boolean {
	try {
		lstatSync(path);
		return false;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
			return true;
		throw error;
	}
}

/** Create only a known-new file; never raw-open/close an existing SQLite file. */
function createMissingSchemaFile(
	databaseUrl: string,
): Readonly<{ path: string; device: bigint; inode: bigint }> | undefined {
	if (
		typeof databaseUrl !== "string" ||
		!databaseUrl.startsWith("file:") ||
		/\p{Cc}/u.test(databaseUrl)
	)
		throw new RuntimeSchemaStartupError();
	const raw = databaseUrl.slice(5).trim();
	if (!raw || raw === ":memory:" || /^[a-z][a-z0-9+.-]*:/i.test(raw))
		throw new RuntimeSchemaStartupError();
	const alias = resolve(raw);
	if (!absent(alias)) return undefined;
	const path = join(realpathSync(dirname(alias)), basename(alias));
	if (!absent(`${path}.arr-restore-runtime`)) throw new RuntimeSchemaStartupError();
	const descriptor = openSync(
		path,
		constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		const stat = fstatSync(descriptor, { bigint: true });
		if (!stat.isFile() || stat.nlink !== 1n) throw new RuntimeSchemaStartupError();
		return Object.freeze({ path, device: stat.dev, inode: stat.ino });
	} finally {
		closeSync(descriptor);
	}
}

function assertMainDescriptor(storage: SqliteRestoreStorage, main: Database.Database): void {
	storage.assertUnchanged();
	if (!main.open || main.name !== storage.databasePath) throw new RuntimeSchemaStartupError();
	const expected = lstatSync(storage.databasePath, { bigint: true });
	let matches = 0;
	for (const name of readdirSync("/proc/self/fd")) {
		if (!/^\d+$/.test(name)) continue;
		const descriptor = `/proc/self/fd/${name}`;
		try {
			const target = readlinkSync(descriptor);
			if (target !== storage.databasePath && target !== `${storage.databasePath} (deleted)`)
				continue;
			const actual = statSync(descriptor, { bigint: true });
			if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino)
				throw new RuntimeSchemaStartupError();
			matches++;
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
				continue;
			throw error;
		}
	}
	if (matches !== 1) throw new RuntimeSchemaStartupError();
	storage.assertUnchanged();
}

export type SqliteRuntimeSchemaProvisioning<Plan> = Readonly<{
	preflight(main: Database.Database): Plan;
	apply(main: Database.Database, plan: Plan, assertOwned: () => Promise<void>): Promise<void>;
	finish(main: Database.Database, plan: Plan): RuntimeSchemaStartupSettings;
}>;

/**
 * Explicit pre-launch schema actor only. Its main descriptor owns the actual
 * transaction; original binding, startup journal, schema and receipt commit
 * together. This never admits ordinary application work or repairs an orphan.
 */
export async function provisionSqliteRestoreRuntimeSchema<Plan>(
	databaseUrl: string,
	startup: SqliteRestoreRuntimeStartup,
	operation: SqliteRuntimeSchemaProvisioning<Plan>,
): Promise<RuntimeSchemaStartupSettings> {
	let main: Database.Database | undefined;
	let ownership: SqliteRestoreRuntimeOwnership | undefined;
	let commitStarted = false;
	let commitAcknowledged = false;
	let result: RuntimeSchemaStartupSettings | undefined;
	let failure: RuntimeSchemaStartupError | undefined;
	try {
		const initial = initialStartupRecord(startup);
		const created = createMissingSchemaFile(databaseUrl);
		const storage = resolveSqliteRestoreStorage(databaseUrl);
		if (created) {
			const current = lstatSync(storage.databasePath, { bigint: true });
			if (
				created.path !== storage.databasePath ||
				created.device !== current.dev ||
				created.inode !== current.ino
			)
				throw new RuntimeSchemaStartupError();
		}
		main = new Database(storage.databasePath, { fileMustExist: true, timeout: 0 });
		const writer = main;
		assertMainDescriptor(storage, writer);
		applySqliteStartupCacheHint(writer);
		writer.pragma("foreign_keys=ON");
		writer.pragma("synchronous=FULL");
		const mode = writer.pragma("journal_mode", { simple: true });
		if (
			!["delete", "wal"].includes(String(mode)) ||
			writer.pragma("foreign_keys", { simple: true }) !== 1 ||
			writer.pragma("synchronous", { simple: true }) !== 2
		)
			throw new RuntimeSchemaStartupError();
		writer.exec("BEGIN EXCLUSIVE");
		assertMainDescriptor(storage, writer);
		// Complete read-only plan before any coordination creation/application DDL.
		const plan = operation.preflight(writer);
		const exists = (table: string) =>
			writer
				.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name=?")
				.get(table) !== undefined;
		const bindings = exists("SqliteRestoreStorageBinding")
			? (writer
					.prepare(`SELECT ${COLUMNS.join(", ")} FROM SqliteRestoreStorageBinding LIMIT 2`)
					.all() as Binding[])
			: [];
		const journals = exists("RestoreRuntimeControl")
			? (writer
					.prepare(`SELECT ${RUNTIME_COLUMNS.join(", ")} FROM RestoreRuntimeControl LIMIT 2`)
					.all() as Record<string, unknown>[])
			: [];
		const cold = bindings.length === 0;
		let binding: Binding;
		if (cold) {
			if (
				journals.length ||
				exists("ArrSchemaMigrationReceipt") ||
				(exists("ArrRuntimeDataFormatReceipt") &&
					writer.prepare("SELECT 1 FROM main.ArrRuntimeDataFormatReceipt LIMIT 1").get()) ||
				!absent(storage.coordinationDirectoryPath)
			)
				throw new RuntimeSchemaStartupError();
			createCoordination(storage);
			binding = captureBinding(storage);
		} else {
			if (bindings.length !== 1 || journals.length !== 1) throw new RuntimeSchemaStartupError();
			binding = bindings[0]!;
			assertBinding(storage, binding);
			parseSqliteRestoreRuntimeRecord(journals[0]!);
		}
		ownership = await acquireSqliteRestoreRuntimeOwnership(`file:${storage.databasePath}`);
		if (!(await ownership.tryAcquireExclusive())) throw new RuntimeSchemaStartupError();
		const owner = ownership;
		const assertOwned = async () => {
			await owner.assertOwned();
			if (!(await owner.tryAcquireExclusive()) || !writer.inTransaction)
				throw new RuntimeSchemaStartupError();
			assertMainDescriptor(storage, writer);
			assertBinding(storage, binding);
		};
		await assertOwned();
		await operation.apply(writer, plan, assertOwned);
		await assertOwned();
		if (cold)
			writer
				.prepare(
					`INSERT INTO SqliteRestoreStorageBinding (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map((field) => `@${field}`).join(", ")})`,
				)
				.run(binding);
		writeStartingJournal(writer, initial, cold);
		assertSqliteRestoreRuntimeStorageBinding(writer, storage);
		const after = writer
			.prepare(`SELECT ${RUNTIME_COLUMNS.join(", ")} FROM RestoreRuntimeControl LIMIT 2`)
			.all() as Record<string, unknown>[];
		if (after.length !== 1) throw new RuntimeSchemaStartupError();
		const record = parseSqliteRestoreRuntimeRecord(after[0]!);
		if (
			record.runtimeEpoch !== initial.runtimeEpoch ||
			record.phase !== "starting" ||
			record.activeRestoreId !== null
		)
			throw new RuntimeSchemaStartupError();
		result = operation.finish(writer, plan);
		await assertOwned();
		assertSqliteRestoreRuntimeStorageBinding(writer, storage);
		if (
			writer.pragma("foreign_keys", { simple: true }) !== 1 ||
			writer.pragma("synchronous", { simple: true }) !== 2 ||
			writer.pragma("journal_mode", { simple: true }) !== mode ||
			(
				timeSqliteStartupPhase("foreign-key-check", () =>
					writer.pragma("foreign_key_check"),
				) as unknown[]
			).length !== 0
		)
			throw new RuntimeSchemaStartupError();
		commitStarted = true;
		timeSqliteStartupPhase("commit", () => writer.exec("COMMIT"));
		commitAcknowledged = true;
	} catch (error) {
		failure = new RuntimeSchemaStartupError(
			commitStarted && !commitAcknowledged
				? "commit-unknown"
				: error instanceof SqliteDateCompatibilityError
					? "format-migration-required"
					: "startup-unavailable",
		);
	} finally {
		try {
			if (main?.inTransaction) main.exec("ROLLBACK");
		} catch {
			if (!failure || failure.category === "format-migration-required")
				failure = new RuntimeSchemaStartupError();
		}
		try {
			if (main?.open) main.close();
			if (main?.open && (!failure || failure.category === "format-migration-required"))
				failure = new RuntimeSchemaStartupError("closure-unverified");
		} catch {
			if (!failure || failure.category === "format-migration-required")
				failure = new RuntimeSchemaStartupError("closure-unverified");
		}
		try {
			await ownership?.close();
		} catch {
			if (!failure || failure.category === "format-migration-required")
				failure = new RuntimeSchemaStartupError("closure-unverified");
		}
	}
	if (failure) throw failure;
	if (!result || !commitAcknowledged) throw new RuntimeSchemaStartupError();
	return result;
}
