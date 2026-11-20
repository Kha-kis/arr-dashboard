import type Database from "better-sqlite3";
import { RuntimeSchemaStartupError } from "./runtime-schema-startup.js";

const maximumGroups = 100_000;
const indexedReferences = new Map([
	[
		"provider_native_inventory_stage_items",
		{ column: "passId", parent: "provider_native_inventory_passes" },
	],
	[
		"provider_native_inventory_seen_items",
		{ column: "passId", parent: "provider_native_inventory_passes" },
	],
	["qui_torrent_observations", { column: "userId", parent: "User" }],
]);
type Table = { name: string; sql: string | null };
type ForeignKey = { seq: number; table: string; from: string; to: string | null };
type Column = { name: string; type: string; pk: number; hidden: number };
type Index = { name: string; unique: number; origin: string; partial: number };
type IndexColumn = { name: string | null; cid: number; key: number; coll: string; desc: number };
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
function refuse(): never {
	throw new RuntimeSchemaStartupError();
}
function columns(main: Database.Database, name: string) {
	return main.pragma(`main.table_xinfo(${quote(name)})`) as Column[];
}
function indexes(main: Database.Database, name: string) {
	return main.pragma(`main.index_list(${quote(name)})`) as Index[];
}
function indexColumns(main: Database.Database, name: string) {
	return (main.pragma(`main.index_xinfo(${quote(name)})`) as IndexColumn[]).filter(
		(column) => column.key === 1,
	);
}
function binaryColumn(column: IndexColumn | undefined, name: string) {
	return column?.name === name && column.cid >= 0 && column.coll === "BINARY" && column.desc === 0;
}
function plainTable(table: Table) {
	// Decline unfamiliar collations and table implementations rather than
	// approximating their comparison/storage semantics. False positives fall back.
	return table.sql !== null && !/\b(COLLATE|VIRTUAL|WITHOUT)\b/i.test(table.sql);
}
function indexedQuery(
	main: Database.Database,
	table: Table,
	keys: ForeignKey[],
	tables: Table[],
): string | undefined {
	const reference = indexedReferences.get(table.name);
	if (!reference || keys.length !== 1 || !plainTable(table)) return;
	const key = keys[0]!;
	if (
		key.seq !== 0 ||
		key.from !== reference.column ||
		key.table !== reference.parent ||
		key.to !== "id"
	)
		return;
	const parent = tables.find((candidate) => candidate.name === reference.parent);
	if (!parent || !plainTable(parent)) return;
	const childColumn = columns(main, table.name).find((column) => column.name === reference.column);
	const parentColumns = columns(main, parent.name),
		parentColumn = parentColumns.find((column) => column.name === "id");
	if (
		childColumn?.type !== "TEXT" ||
		childColumn.hidden !== 0 ||
		parentColumn?.type !== "TEXT" ||
		parentColumn.hidden !== 0 ||
		parentColumn.pk !== 1 ||
		parentColumns.filter((column) => column.pk > 0).length !== 1
	)
		return;
	const parentIndex = indexes(main, parent.name).find((index) => {
		if (index.origin !== "pk" || index.unique !== 1 || index.partial !== 0) return false;
		const fields = indexColumns(main, index.name);
		return fields.length === 1 && binaryColumn(fields[0], "id");
	});
	const childIndex = indexes(main, table.name).find((index) => {
		if (index.partial !== 0) return false;
		const fields = indexColumns(main, index.name);
		return (
			binaryColumn(fields[0], reference.column) &&
			fields.every(
				(column) =>
					column.name !== null && column.cid >= 0 && column.coll === "BINARY" && column.desc === 0,
			)
		);
	});
	if (!parentIndex || !childIndex) return;
	const child = `main.${quote(table.name)} AS child INDEXED BY ${quote(childIndex.name)}`;
	const column = `child.${quote(reference.column)}`;
	return `WITH RECURSIVE reference_keys(value,ordinal) AS (
		SELECT (SELECT ${column} FROM ${child} WHERE ${column} IS NOT NULL ORDER BY ${column} LIMIT 1),1
		UNION ALL
		SELECT (SELECT ${column} FROM ${child} WHERE ${column}>+keys.value ORDER BY ${column} LIMIT 1),keys.ordinal+1
		FROM reference_keys AS keys WHERE keys.value IS NOT NULL AND keys.ordinal<=${maximumGroups}
	)
	SELECT CASE WHEN keys.ordinal>${maximumGroups} OR typeof(keys.value) NOT IN ('text','blob')
		THEN 'fallback' ELSE 'violation' END AS outcome
	FROM reference_keys AS keys
	WHERE keys.value IS NOT NULL AND (keys.ordinal>${maximumGroups}
		OR typeof(keys.value) NOT IN ('text','blob')
		OR NOT EXISTS(SELECT 1 FROM main.${quote(parent.name)} AS parent INDEXED BY ${quote(parentIndex.name)}
			WHERE parent.id=+keys.value)) LIMIT 1`;
}

/** Complete main-database FK validation under the caller's existing exclusive
 * startup transaction. Only proven scalar TEXT/BINARY shapes use covering key
 * seeks; every other FK table retains SQLite's native checker. No app data or
 * schema is changed, and a capped/unsupported traversal never proves validity.
 */
export function checkCompleteSqliteForeignKeys(main: Database.Database): void {
	if (
		!main.open ||
		main.readonly ||
		!main.inTransaction ||
		main.pragma("foreign_keys", { simple: true }) !== 1 ||
		main.pragma("defer_foreign_keys", { simple: true }) !== 0
	)
		refuse();
	const tables = main
		.prepare("SELECT name,sql FROM main.sqlite_schema WHERE type='table' ORDER BY name")
		.all() as Table[];
	for (const table of tables) {
		const keys = main.pragma(`main.foreign_key_list(${quote(table.name)})`) as ForeignKey[];
		if (!keys.length) continue;
		const query = indexedQuery(main, table, keys, tables);
		if (query) {
			// Keep keys inside SQLite: JS text decoding can change invalid UTF-8,
			// while SQL preserves the exact value, affinity and BINARY comparison.
			const result = main.prepare(query).get() as { outcome: string } | undefined;
			if (!result) continue;
			if (result.outcome !== "fallback") refuse();
		}
		if ((main.pragma(`main.foreign_key_check(${quote(table.name)})`) as unknown[]).length) refuse();
	}
}
