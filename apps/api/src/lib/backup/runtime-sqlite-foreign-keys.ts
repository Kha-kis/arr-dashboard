import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { RuntimeSchemaStartupError } from "./runtime-schema-startup.js";

const table = "ArrForeignKeyValidation";
const prefix = "arr_fk_validation_";
const stateSql = `CREATE TABLE "${table}" (
	id INTEGER NOT NULL PRIMARY KEY,
	protocolVersion INTEGER NOT NULL,
	bindingDigest TEXT NOT NULL,
	sqliteVersion TEXT NOT NULL,
	schemaDigest TEXT NOT NULL,
	schemaCookie INTEGER NOT NULL,
	dirty INTEGER NOT NULL
)`;
type SchemaObject = { type: string; name: string; tbl_name: string; sql: string | null };
type State = {
	id: number;
	protocolVersion: number;
	bindingDigest: string;
	sqliteVersion: string;
	schemaDigest: string;
	schemaCookie: number;
	dirty: number;
};
const actions = ["INSERT", "UPDATE", "DELETE"] as const;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const fold = (value: string) => value.replace(/[A-Z]/g, (char) => char.toLowerCase());
function refuse(): never {
	throw new RuntimeSchemaStartupError();
}
function requireWriter(main: Database.Database) {
	if (
		!main.open ||
		main.readonly ||
		!main.inTransaction ||
		main.pragma("foreign_keys", { simple: true }) !== 1 ||
		main.pragma("defer_foreign_keys", { simple: true }) !== 0
	)
		refuse();
}
function trigger(
	target: string,
	action: (typeof actions)[number],
	name = `${prefix}${hash([target, action])}`,
) {
	const sql = `CREATE TRIGGER ${quote(name)} BEFORE ${action} ON ${quote(target)}
	WHEN (SELECT foreign_keys FROM main.pragma_foreign_keys())<>1
		OR (SELECT defer_foreign_keys FROM main.pragma_defer_foreign_keys())<>0
	BEGIN
		UPDATE "${table}" SET dirty=1 WHERE id=1 AND protocolVersion=1 AND dirty IN (0,1);
		SELECT CASE WHEN changes()=1 THEN 0 ELSE RAISE(ABORT,'Foreign key validation unavailable') END;
	END`;
	return { type: "trigger", name, tbl_name: target, sql };
}
/** Exact generated SQL only; other validation protocols must not bless arbitrary triggers. */
export function isSqliteForeignKeyValidationTrigger(object: SchemaObject): boolean {
	return (
		new RegExp(`^${prefix}[0-9a-f]{64}$`).test(object.name) &&
		actions.some((action) => hash(object) === hash(trigger(object.tbl_name, action, object.name)))
	);
}
function cookie(main: Database.Database): number {
	const value = main.pragma("main.schema_version", { simple: true });
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 0xffffffff)
		refuse();
	return value;
}
function schema(main: Database.Database): SchemaObject[] {
	return main
		.prepare("SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name")
		.all() as SchemaObject[];
}
function state(main: Database.Database, objects: SchemaObject[]): State | undefined {
	const owned = objects.filter((object) => object.name === table || object.tbl_name === table);
	if (!owned.length) return undefined;
	if (
		owned.length !== 1 ||
		hash(owned[0]) !== hash({ type: "table", name: table, tbl_name: table, sql: stateSql })
	)
		refuse();
	const rows = main.prepare(`SELECT * FROM main."${table}" LIMIT 2`).all() as State[];
	const row = rows[0];
	if (
		rows.length !== 1 ||
		!row ||
		row.id !== 1 ||
		row.protocolVersion !== 1 ||
		![0, 1].includes(row.dirty) ||
		!/^[0-9a-f]{64}$/.test(row.bindingDigest) ||
		!/^[0-9a-f]{64}$/.test(row.schemaDigest) ||
		typeof row.sqliteVersion !== "string" ||
		!/^\d+\.\d+\.\d+$/.test(row.sqliteVersion) ||
		!Number.isSafeInteger(row.schemaCookie) ||
		row.schemaCookie < 0 ||
		row.schemaCookie > 0xffffffff
	)
		refuse();
	return row;
}

/** Call only inside the existing exclusive, descriptor-bound startup transaction.
 * Enforced writes preserve a validated FK graph. Unenforced/deferred writes
 * invalidate its proof transactionally; schema changes also force full validation.
 * This is not a physical integrity check or restore authorization.
 */
export function validateTrackedSqliteForeignKeys(
	main: Database.Database,
	storageIdentity: readonly (string | number)[],
	isApplicationTrigger: (object: SchemaObject) => boolean = () => false,
): "full" | "reused" {
	requireWriter(main);
	const objects = schema(main);
	const tables = objects.filter(
		(object) => object.type === "table" && !object.name.startsWith("sqlite_"),
	);
	const names = new Map(tables.map((object) => [fold(object.name), object.name]));
	const relevant = new Set<string>();
	for (const child of tables) {
		const keys = main.prepare(`PRAGMA main.foreign_key_list(${quote(child.name)})`).all() as {
			table: string;
		}[];
		for (const key of keys) {
			const parent = names.get(fold(key.table));
			if (!parent || parent === table || child.name === table) refuse();
			relevant.add(child.name);
			relevant.add(parent);
		}
	}
	const temp = main
		.prepare("SELECT type,name,tbl_name FROM temp.sqlite_schema")
		.all() as SchemaObject[];
	for (const object of [...objects, ...temp]) {
		if (["pragma_foreign_keys", "pragma_defer_foreign_keys"].includes(fold(object.name))) refuse();
	}
	if (
		temp.some(
			(object) =>
				object.name === table ||
				object.name.startsWith(prefix) ||
				relevant.has(names.get(fold(object.name)) ?? "") ||
				(object.type === "trigger" && relevant.has(names.get(fold(object.tbl_name)) ?? "")),
		)
	)
		refuse();
	const previous = state(main, objects);
	const installed = objects.filter((object) => object.name.startsWith(prefix));
	const unknownTriggers = objects.some(
		(object) =>
			object.type === "trigger" &&
			!isSqliteForeignKeyValidationTrigger(object) &&
			!isApplicationTrigger(object),
	);
	for (const object of installed) {
		if (
			!tables.some((target) => target.name === object.tbl_name) ||
			!isSqliteForeignKeyValidationTrigger(object)
		)
			refuse();
	}
	if (!previous && installed.length) refuse();
	const expected = [...relevant]
		.sort()
		.flatMap((target) => actions.map((action) => trigger(target, action)));
	const missing = expected.filter(
		(object) => !installed.some((actual) => hash(actual) === hash(object)),
	);
	const renamed = installed.filter(
		(object) => !actions.some((action) => hash(object) === hash(trigger(object.tbl_name, action))),
	);
	const bindingDigest = hash(storageIdentity);
	const sqliteVersion = main.prepare("SELECT sqlite_version()").pluck().get() as string;
	if (
		previous &&
		!unknownTriggers &&
		!missing.length &&
		!renamed.length &&
		previous.dirty === 0 &&
		previous.bindingDigest === bindingDigest &&
		previous.sqliteVersion === sqliteVersion &&
		previous.schemaCookie === cookie(main) &&
		previous.schemaDigest === hash(objects)
	)
		return "reused";
	// This remains the complete native check. No timeout or receipt can turn
	// an interrupted/failed scan into a baseline. The caller owns commit/rollback.
	if ((main.pragma("foreign_key_check") as unknown[]).length !== 0) refuse();
	requireWriter(main);
	// ALTER TABLE rewrites the ON target but retains trigger names. Retire only
	// exact recognized old-name definitions after the complete native check,
	// before installing canonical coverage: the old table name may be reused.
	// Exclusion remains held; no data writes occur between check and sealing.
	// Rollback restores the former tracking if any later step fails.
	for (const object of renamed) main.exec(`DROP TRIGGER main.${quote(object.name)}`);
	if (!previous) main.exec(stateSql);
	for (const object of missing) main.exec(object.sql);
	const values = [bindingDigest, sqliteVersion, hash(schema(main)), cookie(main)];
	if (previous) {
		if (
			main
				.prepare(
					`UPDATE main."${table}" SET bindingDigest=?,sqliteVersion=?,schemaDigest=?,schemaCookie=?,dirty=0 WHERE id=1`,
				)
				.run(...values).changes !== 1
		)
			refuse();
	} else {
		main
			.prepare(
				`INSERT INTO main."${table}"(id,protocolVersion,bindingDigest,sqliteVersion,schemaDigest,schemaCookie,dirty) VALUES(1,1,?,?,?,?,0)`,
			)
			.run(...values);
	}
	return "full";
}
