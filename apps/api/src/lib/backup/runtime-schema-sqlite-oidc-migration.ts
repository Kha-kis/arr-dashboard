import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
	type RuntimeSchemaCatalog,
	type RuntimeSchemaPlanningCatalog,
	type RuntimeSchemaPlanningTable,
	RuntimeSchemaPlanError,
	type RuntimeSchemaRegistry,
	type RuntimeSchemaTable,
	validateRuntimeSchemaCatalog,
} from "./runtime-schema-catalog.js";
import { prepareSqliteOidcPredecessorReplacement } from "./runtime-schema-registry.js";

const tableName = "oidc_providers";
const replacementName = "ArrOidcProviderSchemaMigration";
const migrationId = "sqlite-oidc-providers-rowid-to-autoincrement-v1";
const columns = [
	"id",
	"displayName",
	"clientId",
	"encryptedClientSecret",
	"clientSecretIv",
	"issuer",
	"redirectUri",
	"scopes",
	"enabled",
	"createdAt",
	"updatedAt",
] as const;
const columnList = columns.map((name) => `"${name}"`).join(",");

export type SqliteOidcPredecessorPlan = Readonly<{
	migrationId: string;
	postCatalog: RuntimeSchemaCatalog | RuntimeSchemaPlanningCatalog;
}>;
type SchemaObject = { type: string; name: string; tbl_name: string; sql: string | null };
type Token = { value: string; literal: boolean; quoted?: boolean };
type Evidence = { digest: string; rows: number };
type Sealed = {
	main: Database.Database;
	registry: Readonly<RuntimeSchemaRegistry>;
	target: RuntimeSchemaTable;
	replacement: ReturnType<typeof prepareSqliteOidcPredecessorReplacement>;
	schemaDigest: string;
	values: Evidence;
	consumed: boolean;
};
const plans = new WeakMap<SqliteOidcPredecessorPlan, Sealed>();

function refuse(): never {
	throw new RuntimeSchemaPlanError("incompatible-schema");
}
function transaction(main: Database.Database): void {
	if (
		!main.open ||
		main.readonly ||
		!main.inTransaction ||
		main.pragma("foreign_keys", { simple: true }) !== 1
	)
		refuse();
}
function freeze<T>(value: T): Readonly<T> {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}
function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Recognition only. Quoted identifiers retain dependency identity; literals do not. */
function tokens(sql: string, dependencyContext = false): Token[] {
	const result: Token[] = [];
	for (let offset = 0; offset < sql.length; ) {
		const char = sql[offset]!;
		if (/\s/.test(char)) {
			offset++;
			continue;
		}
		if (sql.startsWith("--", offset)) {
			const end = sql.indexOf("\n", offset + 2);
			offset = end < 0 ? sql.length : end + 1;
			continue;
		}
		if (sql.startsWith("/*", offset)) {
			const end = sql.indexOf("*/", offset + 2);
			if (end < 0) refuse();
			offset = end + 2;
			continue;
		}
		if (["'", '"', "`", "["].includes(char)) {
			const close = char === "[" ? "]" : char;
			let value = "",
				ended = false;
			for (offset++; offset < sql.length; offset++) {
				if (sql[offset] !== close) {
					value += sql[offset];
					continue;
				}
				if (close !== "]" && sql[offset + 1] === close) {
					value += close;
					offset++;
					continue;
				}
				offset++;
				ended = true;
				break;
			}
			if (!ended) refuse();
			const token: Token = {
				value: char === "'" ? value : value.toUpperCase(),
				literal: char === "'",
			};
			// Preserve the existing normalized shape for tableShape equality.
			if (dependencyContext) token.quoted = true;
			result.push(token);
			continue;
		}
		const word = /^[\p{L}\p{N}_$]+/u.exec(sql.slice(offset));
		if (word) {
			result.push({ value: word[0].toUpperCase(), literal: false });
			offset += word[0].length;
		} else {
			if (char === "\0") refuse();
			result.push({ value: char, literal: false });
			offset++;
		}
	}
	if (result.at(-1)?.value === ";" && (!dependencyContext || !result.at(-1)?.quoted)) result.pop();
	return result;
}
function objects(main: Database.Database, schema: "main" | "temp"): SchemaObject[] {
	return main
		.prepare(`SELECT type,name,tbl_name,sql FROM ${schema}.sqlite_schema ORDER BY type,name`)
		.all() as SchemaObject[];
}
function schemaEvidence(main: Database.Database): {
	main: SchemaObject[];
	temp: SchemaObject[];
	digest: string;
} {
	const native = objects(main, "main"),
		temporary = objects(main, "temp");
	return {
		main: native,
		temp: temporary,
		digest: digest([
			native,
			temporary,
			main.pragma("main.schema_version", { simple: true }),
			main.pragma("temp.schema_version", { simple: true }),
		]),
	};
}

/** SQLite accepts single quotes for table names in these identifier positions. */
function singleQuotedTableReference(sql: readonly Token[], index: number): boolean {
	const keyword = (position: number, names: readonly string[]) =>
		!!sql[position] &&
		!sql[position]!.literal &&
		!sql[position]!.quoted &&
		names.includes(sql[position]!.value);
	const introducers = ["FROM", "JOIN", "UPDATE", "INTO"];
	let position = index - 1;
	// Grouped table factors, including nested parentheses, retain table context.
	while (keyword(position, ["("])) position--;
	if (keyword(position, [".", ...introducers])) return true;
	if (
		keyword(position, ["ABORT", "FAIL", "IGNORE", "REPLACE", "ROLLBACK"]) &&
		keyword(position - 1, ["OR"]) &&
		keyword(position - 2, ["UPDATE"])
	)
		return true;
	if (!keyword(position, [","])) return false;
	// A comma may separate FROM factors or scalar values. Walk only this scope;
	// function arguments/SELECT expressions are literals, ambiguous joins refuse.
	let depth = 0;
	for (position--; position >= 0; position--) {
		if (sql[position]!.literal || sql[position]!.quoted) continue;
		const word = sql[position]!.value;
		if (word === ")") {
			depth++;
			continue;
		}
		if (word === "(") {
			if (depth > 0) {
				depth--;
				continue;
			}
			while (keyword(position - 1, ["("])) position--;
			return keyword(position - 1, introducers);
		}
		if (depth > 0) continue;
		if ([...introducers, "ON", "USING"].includes(word)) return true;
		if (
			[
				"SELECT",
				"WHERE",
				"HAVING",
				"SET",
				"VALUES",
				"RETURNING",
				"ORDER",
				"GROUP",
				"LIMIT",
				"WINDOW",
				"WHEN",
				"THEN",
				"ELSE",
			].includes(word)
		)
			return false;
		if (word === ";") break;
	}
	// No provable expression context for a matching comma-delimited name.
	return true;
}
function dependencies(main: Database.Database, schema: ReturnType<typeof schemaEvidence>): void {
	for (const [namespace, entries] of [
		["main", schema.main],
		["temp", schema.temp],
	] as const) {
		for (const object of entries) {
			if (object.type === "table") {
				const keys = main
					.prepare(`SELECT "table" FROM pragma_foreign_key_list(?, '${namespace}')`)
					.all(object.name) as { table: string }[];
				if (
					keys.some(
						(key) =>
							key.table.toLowerCase() === tableName ||
							key.table.toLowerCase() === replacementName.toLowerCase(),
					)
				)
					refuse();
			}
			if (object.type !== "view" && object.type !== "trigger") continue;
			if (
				!object.sql ||
				[tableName, replacementName.toLowerCase()].includes(object.tbl_name.toLowerCase())
			)
				refuse();
			const parsed = tokens(object.sql, true);
			if (
				parsed.some(
					(token, index) =>
						[tableName.toUpperCase(), replacementName.toUpperCase()].includes(
							token.value.toUpperCase(),
						) &&
						(!token.literal || singleQuotedTableReference(parsed, index)),
				)
			)
				refuse();
		}
	}
}

/** Fixed complete grammar checked against the loaded public target, never executable SQL. */
function tableShape(
	main: Database.Database,
	name: typeof tableName | typeof replacementName,
	target: RuntimeSchemaTable,
	legacy: boolean,
): void {
	const entries = objects(main, "main").filter(
		(object) => object.name.toLowerCase() === name.toLowerCase(),
	);
	if (
		entries.length !== 1 ||
		entries[0]!.name !== name ||
		entries[0]!.type !== "table" ||
		!entries[0]!.sql
	)
		refuse();
	const expected = `CREATE TABLE "${name}" (${target.columns
		.map((column) => {
			const key = column.name === "id" ? ` PRIMARY KEY${legacy ? "" : " AUTOINCREMENT"}` : "";
			return `"${column.name}" ${column.type.split(";")[0]}${column.nullable ? "" : " NOT NULL"}${key}${column.defaultValue === null ? "" : ` DEFAULT ${column.defaultValue}`}`;
		})
		.join(",")})`;
	if (JSON.stringify(tokens(entries[0]!.sql!)) !== JSON.stringify(tokens(expected))) refuse();
	const fields = main
		.prepare("SELECT * FROM pragma_table_xinfo(?, 'main') ORDER BY cid")
		.all(name) as { name: string; type: string; notnull: number; pk: number; hidden: number }[];
	if (
		fields.length !== target.columns.length ||
		fields.some((field, index) => {
			const column = target.columns[index]!;
			return (
				field.name !== column.name ||
				field.type.toUpperCase() !== column.type.split(";")[0] ||
				field.notnull !== (column.nullable ? 0 : 1) ||
				field.pk !== (column.name === "id" ? 1 : 0) ||
				field.hidden !== 0
			);
		}) ||
		main.prepare("SELECT * FROM pragma_index_list(?, 'main')").all(name).length ||
		main.prepare("SELECT * FROM pragma_foreign_key_list(?, 'main')").all(name).length
	)
		refuse();
}

/** Read TEXT as bytes, integers as bigint and REAL as IEEE754; never coerce rows in JS. */
function values(
	main: Database.Database,
	name: typeof tableName | typeof replacementName,
): Evidence {
	const select = columns
		.map(
			(column) =>
				`typeof("${column}"),CASE WHEN typeof("${column}") IN ('text','blob') THEN CAST("${column}" AS BLOB) ELSE "${column}" END`,
		)
		.join(",");
	const hash = createHash("sha256");
	let rows = 0;
	for (const row of main
		.prepare(`SELECT ${select} FROM main."${name}" ORDER BY "id"`)
		.raw()
		.safeIntegers()
		.iterate() as Iterable<unknown[]>) {
		hash.update("row;");
		for (let index = 0; index < row.length; index += 2) {
			const type = row[index],
				value = row[index + 1];
			let bytes: Buffer;
			if (type === "null" && value === null) bytes = Buffer.alloc(0);
			else if (type === "integer" && typeof value === "bigint")
				bytes = Buffer.from(value.toString());
			else if (type === "real" && typeof value === "number" && Number.isFinite(value)) {
				bytes = Buffer.alloc(8);
				bytes.writeDoubleBE(value);
			} else if ((type === "text" || type === "blob") && Buffer.isBuffer(value)) bytes = value;
			else return refuse();
			hash.update(`${type}:${bytes.length}:`).update(bytes).update(";");
		}
		rows++;
		if (!Number.isSafeInteger(rows)) refuse();
	}
	return { rows, digest: hash.digest("hex") };
}
function sameValues(
	main: Database.Database,
	name: typeof tableName | typeof replacementName,
	expected: Evidence,
): void {
	const current = values(main, name);
	if (current.rows !== expected.rows || current.digest !== expected.digest) refuse();
}

/** Pure preflight. The startup workflow owns BEGIN through COMMIT, not this token. */
export function prepareSqliteOidcPredecessorMigration(
	main: Database.Database,
	registry: Readonly<RuntimeSchemaRegistry>,
	catalog: RuntimeSchemaCatalog | RuntimeSchemaPlanningCatalog,
): SqliteOidcPredecessorPlan | null {
	try {
		transaction(main);
		validateRuntimeSchemaCatalog(catalog);
		const replacement = prepareSqliteOidcPredecessorReplacement(registry);
		if (catalog.provider !== "sqlite" || replacement.tableName !== replacementName) refuse();
		const target = registry.tables.find(({ target }) => target.name === tableName)!.target;
		const actual = catalog.tables.find((table) => table.name === tableName);
		const schema = schemaEvidence(main);
		const native = schema.main.filter((object) => object.name.toLowerCase() === tableName);
		if (
			schema.temp.some((object) => object.name.toLowerCase() === tableName) ||
			native.some((object) => object.name !== tableName || object.type !== "table")
		)
			refuse();
		if (!actual) {
			if (native.length) refuse();
			return null;
		}
		// Presence cannot authorize OIDC conservation, even on the canonical early-return path.
		const count = Object.getOwnPropertyDescriptor(actual, "rowCount");
		if (
			Object.hasOwn(actual, "rowPresence") ||
			!count ||
			!("value" in count) ||
			!Number.isSafeInteger(count.value) ||
			count.value < 0
		)
			refuse();
		if (
			actual.columns.find((column) => column.name === "id")?.type === "INTEGER;ROWID;AUTOINCREMENT"
		)
			return null;
		const predecessor = {
			...target,
			columns: target.columns.map((column) =>
				column.name === "id" ? { ...column, type: "INTEGER;ROWID" } : column,
			),
			rowCount: actual.rowCount,
		};
		if (
			JSON.stringify(actual) !== JSON.stringify(predecessor) ||
			JSON.stringify(target.columns.map((column) => column.name)) !== JSON.stringify(columns)
		)
			refuse();
		if (
			[...schema.main, ...schema.temp].some(
				(object) => object.name.toLowerCase() === replacementName.toLowerCase(),
			)
		)
			refuse();
		tableShape(main, tableName, target, true);
		dependencies(main, schema);
		const snapshot = values(main, tableName);
		if (snapshot.rows !== actual.rowCount) refuse();
		const postCatalog = freeze({
			provider: "sqlite" as const,
			tables: catalog.tables.map((table) =>
				table.name === tableName
					? { ...target, rowCount: actual.rowCount }
					: (JSON.parse(JSON.stringify(table)) as RuntimeSchemaPlanningTable),
			),
		});
		const plan = Object.freeze({ migrationId, postCatalog });
		plans.set(plan, {
			main,
			registry,
			target,
			replacement,
			schemaDigest: schema.digest,
			values: snapshot,
			consumed: false,
		});
		return plan;
	} catch {
		return refuse();
	}
}

/** Consume only sealed evidence and execute fixed DDL under the caller's native fence. */
export async function applySqliteOidcPredecessorMigration(
	main: Database.Database,
	plan: SqliteOidcPredecessorPlan,
	assertOwned: () => Promise<void>,
): Promise<void> {
	try {
		const sealed = plans.get(plan);
		if (!sealed || sealed.consumed || sealed.main !== main || typeof assertOwned !== "function")
			refuse();
		sealed.consumed = true;
		const unchanged = () => {
			transaction(main);
			if (schemaEvidence(main).digest !== sealed.schemaDigest) refuse();
			tableShape(main, tableName, sealed.target, true);
			sameValues(main, tableName, sealed.values);
		};
		unchanged();
		await assertOwned();
		unchanged();
		await sealed.replacement.execute((sql) => {
			main.exec(sql);
		});
		let checkpoint = schemaEvidence(main).digest;
		const checked = async (source: boolean, replacement: boolean) => {
			await assertOwned();
			transaction(main);
			const schema = schemaEvidence(main);
			if (schema.digest !== checkpoint) refuse();
			dependencies(main, schema);
			if (source) {
				tableShape(main, tableName, sealed.target, true);
				sameValues(main, tableName, sealed.values);
			}
			if (replacement) {
				tableShape(main, replacementName, sealed.target, false);
				sameValues(main, replacementName, sealed.values);
			}
		};
		// Verify the newly created destination before its explicit SQL-only copy.
		await checked(true, false);
		tableShape(main, replacementName, sealed.target, false);
		if (values(main, replacementName).rows !== 0) refuse();
		main.exec(
			`INSERT INTO main."${replacementName}" (${columnList}) SELECT ${columnList} FROM main."${tableName}"`,
		);
		checkpoint = schemaEvidence(main).digest;
		await checked(true, true);
		main.exec('DROP TABLE main."oidc_providers"');
		checkpoint = schemaEvidence(main).digest;
		await checked(false, true);
		main.exec('ALTER TABLE main."ArrOidcProviderSchemaMigration" RENAME TO "oidc_providers"');
		checkpoint = schemaEvidence(main).digest;
		await checked(false, false);
		tableShape(main, tableName, sealed.target, false);
		sameValues(main, tableName, sealed.values);
		if (
			[...objects(main, "main"), ...objects(main, "temp")].some(
				(object) => object.name.toLowerCase() === replacementName.toLowerCase(),
			)
		)
			refuse();
	} catch {
		return refuse();
	}
}
