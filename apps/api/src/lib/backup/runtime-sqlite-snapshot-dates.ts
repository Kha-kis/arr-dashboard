import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
	encodeCanonicalSqliteDateForStartup,
	SqliteDateCompatibilityError,
} from "../sqlite-datetime.js";

const stateTable = "ArrSnapshotDateValidation";
const dirtyTable = "ArrSnapshotDateDirty";
const snapshotTable = "session_snapshots";
const capacity = 100_000;
const maxGeneration = Number.MAX_SAFE_INTEGER;
const triggerNames = [
	"arr_snapshot_dates_insert",
	"arr_snapshot_dates_update",
	"arr_snapshot_dates_delete",
] as const;
const stateSql = `CREATE TABLE "${stateTable}" (
	id INTEGER NOT NULL PRIMARY KEY,
	protocolVersion INTEGER NOT NULL,
	projectionDigest TEXT NOT NULL,
	schemaDigest TEXT NOT NULL,
	schemaCookie INTEGER NOT NULL,
	generation INTEGER NOT NULL,
	dirtyCount INTEGER NOT NULL,
	fullScanRequired INTEGER NOT NULL
)`;
const dirtySql = `CREATE TABLE "${dirtyTable}" (id TEXT NOT NULL PRIMARY KEY)`;
const triggerGuard = `
	SELECT CASE WHEN (SELECT COUNT(*) FROM "${stateTable}")=1 AND
		(SELECT COUNT(*) FROM "${stateTable}" WHERE id=1 AND protocolVersion=1
			AND typeof(generation)='integer' AND generation>=0 AND generation<${maxGeneration}
			AND typeof(dirtyCount)='integer' AND dirtyCount>=0 AND dirtyCount<=${capacity}
			AND fullScanRequired IN (0,1))=1
		THEN 0 ELSE RAISE(ABORT,'Snapshot date tracking unavailable') END;
	UPDATE "${stateTable}" SET generation=generation+1 WHERE id=1;`;
const removeOldKey = `
	DELETE FROM "${dirtyTable}" WHERE id=OLD.id;
	UPDATE "${stateTable}" SET dirtyCount=dirtyCount-changes() WHERE id=1;`;
const recordNewKey = `
	INSERT INTO "${dirtyTable}"(id)
		SELECT NEW.id WHERE (SELECT fullScanRequired=0 AND dirtyCount<${capacity} FROM "${stateTable}" WHERE id=1)
			AND NOT EXISTS(SELECT 1 FROM "${dirtyTable}" WHERE id=NEW.id);
	UPDATE "${stateTable}" SET dirtyCount=dirtyCount+changes() WHERE id=1;
	UPDATE "${stateTable}" SET fullScanRequired=1 WHERE id=1 AND fullScanRequired=0
		AND NOT EXISTS(SELECT 1 FROM "${dirtyTable}" WHERE id=NEW.id);`;
const triggerSql = [
	`CREATE TRIGGER "${triggerNames[0]}" AFTER INSERT ON "${snapshotTable}" BEGIN ${triggerGuard}${recordNewKey} END`,
	`CREATE TRIGGER "${triggerNames[1]}" AFTER UPDATE OF id,capturedAt ON "${snapshotTable}" BEGIN ${triggerGuard}${removeOldKey}${recordNewKey} END`,
	`CREATE TRIGGER "${triggerNames[2]}" AFTER DELETE ON "${snapshotTable}" BEGIN ${triggerGuard}${removeOldKey} END`,
] as const;

type State = {
	id: number;
	protocolVersion: number;
	projectionDigest: string;
	schemaDigest: string;
	schemaCookie: number;
	generation: number;
	dirtyCount: number;
	fullScanRequired: number;
};
type ReadState = { state: State; schemaDigest: string; schemaCookie: number; keys: string[] };
export type SqliteSnapshotDatePlan = Readonly<{ rowsInspected: number }>;
const plans = new WeakMap<
	SqliteSnapshotDatePlan,
	{ main: Database.Database; before: ReadState; valuesDigest: string }
>();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function refuse(): never {
	throw new SqliteDateCompatibilityError();
}
function requireWriter(main: Database.Database) {
	if (
		!main.open ||
		main.readonly ||
		!main.inTransaction ||
		main.pragma("foreign_keys", { simple: true }) !== 1
	)
		refuse();
}
function requireDigest(digest: string) {
	if (!/^[0-9a-f]{64}$/.test(digest)) refuse();
}
function snapshotSchema(main: Database.Database): string {
	const objects = main
		.prepare(
			"SELECT type,name,tbl_name,sql FROM main.sqlite_schema WHERE tbl_name=? AND type IN ('table','index') ORDER BY type,name",
		)
		.all(snapshotTable);
	const table = objects.filter((row) => (row as { type: unknown; name: unknown }).type === "table");
	if (table.length !== 1) refuse();
	const columns = main.prepare('PRAGMA main.table_xinfo("session_snapshots")').all() as {
		name: string;
		type: string;
		notnull: number;
		pk: number;
		hidden: number;
	}[];
	const key = columns.find((column) => column.name === "id");
	const date = columns.find((column) => column.name === "capturedAt");
	if (
		key?.type !== "TEXT" ||
		key.notnull !== 1 ||
		key.pk !== 1 ||
		key.hidden !== 0 ||
		date?.type !== "DATETIME" ||
		date.notnull !== 1 ||
		date.hidden !== 0 ||
		columns.filter((column) => column.pk > 0).length !== 1
	)
		refuse();
	return hash(objects);
}

function schemaCookie(main: Database.Database): number {
	const value = main.pragma("main.schema_version", { simple: true });
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 0xffffffff)
		refuse();
	return value;
}

function readState(main: Database.Database): ReadState | undefined {
	requireWriter(main);
	const ownedNames = [stateTable, dirtyTable, ...triggerNames];
	const placeholders = ownedNames.map(() => "?").join(",");
	if (
		main
			.prepare(
				`SELECT 1 FROM temp.sqlite_schema WHERE name IN (${placeholders}) OR (type='trigger' AND tbl_name=?) LIMIT 1`,
			)
			.get(...ownedNames, snapshotTable)
	)
		refuse();
	const objects = main
		.prepare(
			`SELECT type,name,tbl_name,sql FROM main.sqlite_schema WHERE name IN (${placeholders}) OR tbl_name IN (?,?) ORDER BY name`,
		)
		.all(...ownedNames, stateTable, dirtyTable) as {
		type: string;
		name: string;
		tbl_name: string;
		sql: string | null;
	}[];
	if (!objects.length) return undefined;
	const expected = [
		{ type: "table", name: stateTable, tbl_name: stateTable, sql: stateSql },
		{ type: "table", name: dirtyTable, tbl_name: dirtyTable, sql: dirtySql },
		{
			type: "index",
			name: `sqlite_autoindex_${dirtyTable}_1`,
			tbl_name: dirtyTable,
			sql: null,
		},
		...triggerNames.map((name, index) => ({
			type: "trigger",
			name,
			tbl_name: snapshotTable,
			sql: triggerSql[index],
		})),
	].sort((a, b) => a.name.localeCompare(b.name));
	const sort = (rows: typeof expected) => [...rows].sort((a, b) => a.name.localeCompare(b.name));
	if (hash(sort(objects)) !== hash(expected)) refuse();
	const triggers = main
		.prepare(
			"SELECT name FROM main.sqlite_schema WHERE type='trigger' AND tbl_name=? ORDER BY name",
		)
		.pluck()
		.all(snapshotTable);
	if (hash(triggers) !== hash([...triggerNames].sort())) refuse();
	const rows = main.prepare(`SELECT * FROM main."${stateTable}" LIMIT 2`).all() as State[];
	const state = rows[0];
	if (
		rows.length !== 1 ||
		!state ||
		state.id !== 1 ||
		state.protocolVersion !== 1 ||
		!Number.isSafeInteger(state.generation) ||
		state.generation < 0 ||
		!Number.isSafeInteger(state.dirtyCount) ||
		state.dirtyCount < 0 ||
		state.dirtyCount > capacity ||
		!Number.isSafeInteger(state.schemaCookie) ||
		state.schemaCookie < 0 ||
		state.schemaCookie > 0xffffffff ||
		![0, 1].includes(state.fullScanRequired)
	)
		refuse();
	requireDigest(state.projectionDigest);
	requireDigest(state.schemaDigest);
	const keys = main
		.prepare(`SELECT id FROM main."${dirtyTable}" ORDER BY id LIMIT ${capacity + 1}`)
		.pluck()
		.all() as string[];
	if (
		keys.length !== state.dirtyCount ||
		keys.length > capacity ||
		keys.some((key) => typeof key !== "string")
	)
		refuse();
	return { state, keys, schemaDigest: snapshotSchema(main), schemaCookie: schemaCookie(main) };
}

function validateChangedRows(main: Database.Database, keys: readonly string[]) {
	const digest = createHash("sha256");
	if (!keys.length) return { rowsInspected: 0, digest: digest.digest("hex") };
	const read = main.prepare('SELECT "capturedAt" FROM main."session_snapshots" WHERE "id" IS ?');
	let rowsInspected = 0;
	for (const key of keys) {
		const row = read.get(key) as { capturedAt: unknown } | undefined;
		if (!row || encodeCanonicalSqliteDateForStartup(row.capturedAt, false) !== row.capturedAt)
			refuse();
		rowsInspected++;
		digest.update(`${JSON.stringify([key, row.capturedAt])}\n`);
	}
	return { rowsInspected, digest: digest.digest("hex") };
}

/** A missing or outdated baseline requires the existing complete table scan. */
export function planTrackedSnapshotDates(
	main: Database.Database,
	projectionDigest: string,
): SqliteSnapshotDatePlan | undefined {
	requireWriter(main);
	requireDigest(projectionDigest);
	const before = readState(main);
	if (
		!before ||
		before.state.projectionDigest !== projectionDigest ||
		before.state.schemaDigest !== before.schemaDigest ||
		before.state.schemaCookie !== before.schemaCookie ||
		before.state.fullScanRequired !== 0
	)
		return undefined;
	const checked = validateChangedRows(main, before.keys);
	const plan = Object.freeze({ rowsInspected: checked.rowsInspected });
	plans.set(plan, { main, before, valuesDigest: checked.digest });
	return plan;
}

/** Apply inside the caller's native startup transaction; never commits or repairs. */
export function checkpointTrackedSnapshotDates(
	main: Database.Database,
	projectionDigest: string,
	plan?: SqliteSnapshotDatePlan,
): void {
	requireWriter(main);
	requireDigest(projectionDigest);
	let current = readState(main);
	if (plan) {
		const saved = plans.get(plan);
		if (!saved || saved.main !== main || !current || hash(current) !== hash(saved.before)) refuse();
		if (validateChangedRows(main, current.keys).digest !== saved.valuesDigest) refuse();
		plans.delete(plan);
	}
	if (!current) {
		// These protocol tables are native bookkeeping, created only after the
		// caller's full date scan. Exact object SQL is verified on every reuse.
		if (
			main
				.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='trigger' AND tbl_name=? LIMIT 1")
				.get(snapshotTable)
		)
			return;
		const schemaDigest = snapshotSchema(main);
		main.exec(stateSql);
		main.exec(dirtySql);
		for (const sql of triggerSql) main.exec(sql);
		main
			.prepare(
				`INSERT INTO main."${stateTable}"(id,protocolVersion,projectionDigest,schemaDigest,schemaCookie,generation,dirtyCount,fullScanRequired) VALUES(1,1,?,?,?,0,0,0)`,
			)
			.run(projectionDigest, schemaDigest, schemaCookie(main));
		current = readState(main);
		if (!current || current.state.projectionDigest !== projectionDigest) refuse();
		return;
	}
	const removed = main.prepare(`DELETE FROM main."${dirtyTable}"`).run().changes;
	if (removed !== current.keys.length) refuse();
	if (
		main
			.prepare(
				`UPDATE main."${stateTable}" SET projectionDigest=?,schemaDigest=?,schemaCookie=?,dirtyCount=0,fullScanRequired=0 WHERE id=1 AND generation=? AND dirtyCount=?`,
			)
			.run(
				projectionDigest,
				current.schemaDigest,
				current.schemaCookie,
				current.state.generation,
				current.state.dirtyCount,
			).changes !== 1
	)
		refuse();
	const completed = readState(main);
	if (
		!completed ||
		completed.keys.length ||
		completed.state.fullScanRequired !== 0 ||
		completed.state.projectionDigest !== projectionDigest ||
		completed.state.schemaDigest !== completed.schemaDigest ||
		completed.state.schemaCookie !== completed.schemaCookie
	)
		refuse();
}
