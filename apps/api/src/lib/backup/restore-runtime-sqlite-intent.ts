import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { assertSqliteRestoreCoordinatorProtocol } from "./restore-runtime-sqlite.js";
import {
	assertSqliteOpenedDescriptor,
	type SqliteRestoreStorage,
} from "./restore-runtime-sqlite-storage.js";
import { readSqliteRuntimeControlCreateSql } from "./runtime-schema-registry.js";
import { RuntimeSchemaStartupError } from "./runtime-schema-startup.js";
import { timeSqliteStartupPhase } from "./runtime-schema-timing.js";

const TABLE = "ArrSqliteEnrollmentIntent";
const INTENT_DDL =
	'CREATE TABLE "ArrSqliteEnrollmentIntent" ("id" INTEGER PRIMARY KEY, "payload" TEXT NOT NULL)';
const SENTINEL = "sqlite-enrollment-intent";
const coordinators = [
	{ file: "owner.sqlite3", table: "RestoreOwnerCoordination" },
	{ file: "operations.sqlite3", table: "RestoreOperationCoordination" },
] as const;

const stampSchema = z.tuple([z.string().regex(/^\d+$/), z.string().regex(/^\d+$/)]);
const intentSchema = z.strictObject({
	version: z.literal(1),
	attempt: z.uuid(),
	main: stampSchema,
	parent: stampSchema,
	objects: z.array(stampSchema).max(3),
	phase: z.enum(["preparing", "publishing"]),
});
type Stamp = z.infer<typeof stampSchema>;
type Intent = z.infer<typeof intentSchema>;
type Enrollment = { raw: string; intent: Intent };
type NativeFence = () => void;

export type ColdSqliteRefusal =
	| "runtime-journal"
	| "migration-receipt-table"
	| "data-format-receipt"
	| "coordination-path";
export class ColdSqliteEnrollmentError extends RuntimeSchemaStartupError {
	constructor(readonly refusal: ColdSqliteRefusal) {
		super();
	}
}

function refuse(): never {
	throw new RuntimeSchemaStartupError();
}

function sameStamp(left: Stamp, right: Stamp): boolean {
	return left[0] === right[0] && left[1] === right[1];
}

function identity(stat: { dev: bigint; ino: bigint }): Stamp {
	return [String(stat.dev), String(stat.ino)];
}

function pathAbsent(path: string): boolean {
	try {
		lstatSync(path);
		return false;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
			return true;
		throw error;
	}
}

function catalog(main: Database.Database, table: string) {
	return main
		.prepare(
			"SELECT type,name,tbl_name,sql FROM main.sqlite_schema WHERE name = ? COLLATE NOCASE OR tbl_name = ? COLLATE NOCASE LIMIT 3",
		)
		.all(table, table) as { type: string; name: string; tbl_name: string; sql: string | null }[];
}

function assertCatalog(main: Database.Database, name: string, sql: string, create: boolean) {
	const rows = catalog(main, name);
	if (rows.length === 0 && create) {
		main.exec(sql);
		return;
	}
	const [row] = rows;
	if (
		rows.length !== 1 ||
		row?.type !== "table" ||
		row.name !== name ||
		row.tbl_name !== name ||
		row.sql !== sql.replace(/;$/, "")
	)
		refuse();
}

function tablePresent(main: Database.Database, table: string): boolean {
	return (
		main.prepare("SELECT 1 FROM main.sqlite_schema WHERE name=? AND type='table'").get(table) !==
		undefined
	);
}

function assertNoPriorEnrollment(main: Database.Database, hasSentinel: boolean) {
	if (
		(tablePresent(main, "SqliteRestoreStorageBinding") &&
			main.prepare("SELECT 1 FROM main.SqliteRestoreStorageBinding LIMIT 1").get()) ||
		(!hasSentinel &&
			tablePresent(main, "RestoreRuntimeControl") &&
			main.prepare("SELECT 1 FROM main.RestoreRuntimeControl LIMIT 1").get())
	)
		throw new ColdSqliteEnrollmentError("runtime-journal");
	if (tablePresent(main, "ArrSchemaMigrationReceipt"))
		throw new ColdSqliteEnrollmentError("migration-receipt-table");
	if (
		tablePresent(main, "ArrRuntimeDataFormatReceipt") &&
		main.prepare("SELECT 1 FROM main.ArrRuntimeDataFormatReceipt LIMIT 1").get()
	)
		throw new ColdSqliteEnrollmentError("data-format-receipt");
}

function assertSentinel(main: Database.Database) {
	assertCatalog(main, "RestoreRuntimeControl", readSqliteRuntimeControlCreateSql(), false);
	const rows = main.prepare("SELECT * FROM main.RestoreRuntimeControl LIMIT 2").all();
	const row = rows[0] as Record<string, unknown> | undefined;
	if (
		rows.length !== 1 ||
		row?.id !== 1 ||
		row.protocolVersion !== 0 ||
		row.phase !== SENTINEL ||
		[
			"runtimeEpoch",
			"ownerBackendPid",
			"activeRestoreId",
			"lastCommittedRestoreId",
			"lastCommittedAt",
			"destinationInstallationId",
		].some((key) => row[key] !== null)
	)
		refuse();
}

export function hasSqliteEnrollmentIntent(main: Database.Database): boolean {
	return catalog(main, TABLE).length !== 0;
}

function readEnrollment(main: Database.Database): Enrollment {
	assertCatalog(main, TABLE, INTENT_DDL, false);
	const rows = main
		.prepare('SELECT "id", "payload" FROM main.ArrSqliteEnrollmentIntent LIMIT 2')
		.all();
	const row = rows[0] as { id?: unknown; payload?: unknown } | undefined;
	if (
		rows.length !== 1 ||
		row?.id !== 1 ||
		typeof row.payload !== "string" ||
		row.payload.length > 1024
	)
		refuse();
	const intent = intentSchema.parse(JSON.parse(row.payload));
	if (intent.phase === "publishing" && intent.objects.length !== 3) refuse();
	assertSentinel(main);
	return { raw: row.payload, intent };
}

function recordCheckpoint(main: Database.Database, current: Enrollment, next: Intent): string {
	const raw = JSON.stringify(next);
	const changed = main
		.prepare("UPDATE main.ArrSqliteEnrollmentIntent SET payload=? WHERE id=1 AND payload=?")
		.run(raw, current.raw);
	if (changed.changes !== 1) refuse();
	return raw;
}

function objectStamp(path: string, directory: boolean, device: string): Stamp {
	const stat = lstatSync(path, { bigint: true });
	const uid = process.geteuid?.();
	if (
		uid === undefined ||
		String(stat.dev) !== device ||
		stat.uid !== BigInt(uid) ||
		(directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n) ||
		(stat.mode & 0o777n) !== (directory ? 0o700n : 0o600n)
	)
		refuse();
	return identity(stat);
}

function syncDirectory(path: string, expected: Stamp) {
	const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		if (!sameStamp(identity(fstatSync(fd, { bigint: true })), expected)) refuse();
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function assertObjects(storage: SqliteRestoreStorage, intent: Intent) {
	storage.assertUnchanged();
	if (
		!sameStamp(identity(lstatSync(storage.databasePath, { bigint: true })), intent.main) ||
		!sameStamp(identity(lstatSync(storage.directoryPath, { bigint: true })), intent.parent)
	)
		refuse();
	const [directory, owner, operations] = intent.objects;
	const path = storage.coordinationDirectoryPath;
	if (!directory) {
		if (!pathAbsent(path)) throw new ColdSqliteEnrollmentError("coordination-path");
		return;
	}
	if (!sameStamp(objectStamp(path, true, intent.parent[0]), directory)) refuse();
	const expected = coordinators
		.slice(0, intent.objects.length - 1)
		.map(({ file }) => file)
		.sort();
	const actual = readdirSync(path).sort();
	if (actual.length !== expected.length || actual.some((file, index) => file !== expected[index]))
		refuse();
	for (const [index, stamp] of [owner, operations].entries()) {
		if (
			stamp &&
			!sameStamp(objectStamp(join(path, coordinators[index]!.file), false, intent.parent[0]), stamp)
		)
			refuse();
	}
	storage.assertUnchanged();
}

function createCoordinator(
	path: string,
	table: (typeof coordinators)[number]["table"],
	device: string,
): Stamp {
	// O_EXCL is used only for a known-new file. Existing SQLite handles are never opened through fs.
	const fd = openSync(
		path,
		constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
		0o600,
	);
	let created: Stamp;
	try {
		created = identity(fstatSync(fd, { bigint: true }));
	} finally {
		closeSync(fd);
	}
	const db = new Database(path, { fileMustExist: true, timeout: 0 });
	try {
		assertSqliteOpenedDescriptor(path);
		if (!sameStamp(objectStamp(path, false, device), created)) refuse();
		if (db.pragma("journal_mode = DELETE", { simple: true }) !== "delete") refuse();
		db.pragma("synchronous = FULL");
		db.exec(
			`BEGIN IMMEDIATE; CREATE TABLE ${table} (id INTEGER PRIMARY KEY, protocolVersion INTEGER NOT NULL); INSERT INTO ${table} VALUES (1,1); COMMIT`,
		);
		assertSqliteRestoreCoordinatorProtocol(db, table);
	} finally {
		db.close();
	}
	if (!sameStamp(objectStamp(path, false, device), created)) refuse();
	return created;
}

function commitAndReacquire(main: Database.Database, assertWriter: NativeFence) {
	assertWriter();
	try {
		main.exec("COMMIT");
	} catch {
		throw new RuntimeSchemaStartupError("commit-unknown");
	}
	main.exec("BEGIN EXCLUSIVE");
	assertWriter();
}

function createIntent(main: Database.Database, storage: SqliteRestoreStorage): string {
	assertNoPriorEnrollment(main, false);
	if (!pathAbsent(storage.coordinationDirectoryPath))
		throw new ColdSqliteEnrollmentError("coordination-path");
	const intent: Intent = {
		version: 1,
		attempt: randomUUID(),
		main: identity(lstatSync(storage.databasePath, { bigint: true })),
		parent: identity(lstatSync(storage.directoryPath, { bigint: true })),
		objects: [],
		phase: "preparing",
	};
	assertObjects(storage, intent);
	syncDirectory(storage.directoryPath, intent.parent);
	assertCatalog(main, "RestoreRuntimeControl", readSqliteRuntimeControlCreateSql(), true);
	main
		.prepare("INSERT INTO main.RestoreRuntimeControl(id,protocolVersion,phase) VALUES(1,0,?)")
		.run(SENTINEL);
	main.exec(INTENT_DDL);
	const raw = JSON.stringify(intent);
	main.prepare("INSERT INTO main.ArrSqliteEnrollmentIntent(id,payload) VALUES(1,?)").run(raw);
	return raw;
}

/** This grants no runtime ownership. Only the schema actor can continue a prior durable attempt. */
export function prepareSqliteEnrollment(
	main: Database.Database,
	storage: SqliteRestoreStorage,
	assertWriter: NativeFence,
	resume: boolean,
): Enrollment {
	assertWriter();
	let expected: string | undefined;
	if (!hasSqliteEnrollmentIntent(main)) {
		expected = createIntent(main, storage);
		timeSqliteStartupPhase("enrollment-intent-commit", () =>
			commitAndReacquire(main, assertWriter),
		);
	} else if (!resume) refuse();

	for (;;) {
		const current = readEnrollment(main);
		if (
			(expected !== undefined && current.raw !== expected) ||
			current.intent.phase !== "preparing"
		)
			refuse();
		assertNoPriorEnrollment(main, true);
		assertObjects(storage, current.intent);
		const { objects, parent } = current.intent;
		if (objects.length === 3) return current;
		const directory = storage.coordinationDirectoryPath;
		const ownerPath = join(directory, coordinators[0].file);
		const owner =
			objects.length === 2
				? new Database(ownerPath, { fileMustExist: true, timeout: 0 })
				: undefined;
		try {
			if (owner) {
				assertSqliteOpenedDescriptor(ownerPath);
				owner.exec("BEGIN IMMEDIATE");
				assertSqliteRestoreCoordinatorProtocol(owner, coordinators[0].table);
				assertObjects(storage, current.intent);
			}
			const created = timeSqliteStartupPhase("coordination-enrollment", () => {
				if (objects.length === 0) {
					mkdirSync(directory, { mode: 0o700 });
					const stamp = objectStamp(directory, true, parent[0]);
					syncDirectory(storage.directoryPath, parent);
					return stamp;
				}
				const coordinator = coordinators[objects.length - 1]!;
				const stamp = createCoordinator(
					join(directory, coordinator.file),
					coordinator.table,
					parent[0],
				);
				syncDirectory(directory, objects[0]!);
				return stamp;
			});
			const next = { ...current.intent, objects: [...objects, created] };
			assertObjects(storage, next);
			timeSqliteStartupPhase("enrollment-object-checkpoint", () => {
				expected = recordCheckpoint(main, current, next);
				commitAndReacquire(main, assertWriter);
			});
		} finally {
			owner?.close();
		}
	}
}

/** Caller must retain both native owner and operations exclusion across this boundary. */
export function startSqliteEnrollmentPublication(
	main: Database.Database,
	storage: SqliteRestoreStorage,
	current: Enrollment,
	assertWriter: NativeFence,
): Enrollment {
	assertWriter();
	const observed = readEnrollment(main);
	if (
		observed.raw !== current.raw ||
		current.intent.objects.length !== 3 ||
		current.intent.phase !== "preparing"
	)
		refuse();
	assertObjects(storage, current.intent);
	const next = { ...current.intent, phase: "publishing" } as const;
	const expected = recordCheckpoint(main, current, next);
	commitAndReacquire(main, assertWriter);
	const retained = readEnrollment(main);
	if (expected !== retained.raw) refuse();
	assertNoPriorEnrollment(main, true);
	assertObjects(storage, retained.intent);
	return retained;
}

export function retireSqliteEnrollment(main: Database.Database, publishing: Enrollment) {
	if (
		!main.inTransaction ||
		readEnrollment(main).raw !== publishing.raw ||
		publishing.intent.phase !== "publishing"
	)
		refuse();
	const removed = main
		.prepare("DELETE FROM main.RestoreRuntimeControl WHERE id=1 AND protocolVersion=0 AND phase=?")
		.run(SENTINEL);
	if (removed.changes !== 1) refuse();
	main.exec('DROP TABLE main."ArrSqliteEnrollmentIntent"');
}
