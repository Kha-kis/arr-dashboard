import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { provisionSqliteRestoreRuntimeSchema } from "./restore-runtime-sqlite-enrollment.js";
import {
	type RuntimeSchemaCatalog,
	type RuntimeSchemaForeignKey,
	type RuntimeSchemaIndex,
	type RuntimeSchemaPlanningCatalog,
	type RuntimeSchemaPlanningTable,
	RuntimeSchemaPlanError,
} from "./runtime-schema-catalog.js";
import {
	createRuntimeSchemaMigrationReceipt,
	parseRuntimeSchemaMigrationReceipt,
} from "./runtime-schema-receipt.js";
import {
	loadRuntimeSchemaRegistry,
	prepareRuntimeSchemaExecution,
	readRuntimeSchemaRegistryTargets,
} from "./runtime-schema-registry.js";
import {
	applySqliteOidcPredecessorMigration,
	prepareSqliteOidcPredecessorMigration,
} from "./runtime-schema-sqlite-oidc-migration.js";
import {
	parseRuntimeSchemaStartupSettings,
	RuntimeSchemaStartupError,
	type RuntimeSchemaStartupSettings,
} from "./runtime-schema-startup.js";
import { timeSqliteStartupPhase, timeSqliteStartupPhaseAsync } from "./runtime-schema-timing.js";
import { applySqliteRuntimeDates, planSqliteRuntimeDates } from "./runtime-sqlite-datetime.js";

type SchemaObject = { type: string; name: string; tbl_name: string; sql: string | null };
type Column = {
	cid: number;
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
	pk: number;
	hidden: number;
};
type Index = { name: string; unique: number; origin: string; partial: number };
type IndexColumn = {
	seqno: number;
	cid: number;
	name: string | null;
	desc: number;
	coll: string;
	key: number;
};
type ForeignKey = {
	id: number;
	seq: number;
	table: string;
	from: string;
	to: string | null;
	on_update: string;
	on_delete: string;
	match: string;
};

function unavailable(): never {
	throw new RuntimeSchemaPlanError("unknown-schema-state");
}

// Read-only identifiers are quoted; they never become registered DDL atoms.
function identifier(value: string): string {
	if (!value || value.includes("\0")) unavailable();
	return `"${value.replaceAll('"', '""')}"`;
}

/** SQL words outside literals, quoted identifiers and comments, with source offsets. */
function words(sql: string): { value: string; offset: number }[] {
	const result: { value: string; offset: number }[] = [];
	for (let offset = 0; offset < sql.length; ) {
		const char = sql[offset]!;
		if (sql.startsWith("--", offset)) {
			const end = sql.indexOf("\n", offset + 2);
			offset = end < 0 ? sql.length : end + 1;
		} else if (sql.startsWith("/*", offset)) {
			const end = sql.indexOf("*/", offset + 2);
			if (end < 0) unavailable();
			offset = end + 2;
		} else if (["'", '"', "`", "["].includes(char)) {
			const close = char === "[" ? "]" : char;
			let ended = false;
			for (offset++; offset < sql.length; offset++) {
				if (sql[offset] !== close) continue;
				if (close !== "]" && sql[offset + 1] === close) {
					offset++;
					continue;
				}
				offset++;
				ended = true;
				break;
			}
			if (!ended) unavailable();
		} else if (/[a-z_]/i.test(char)) {
			const start = offset++;
			while (offset < sql.length && /[a-z0-9_$]/i.test(sql[offset]!)) offset++;
			result.push({ value: sql.slice(start, offset).toUpperCase(), offset: start });
		} else offset++;
	}
	return result;
}

function normalizedDefault(value: string | null): string | null {
	if (value === null) return null;
	let result = value.trim();
	// SQLite's catalog retains optional enclosing parentheses on defaults.
	while (result.startsWith("(") && result.endsWith(")")) {
		let depth = 0;
		let quoted = false;
		let encloses = true;
		for (let position = 0; position < result.length; position++) {
			if (result[position] === "'") {
				if (quoted && result[position + 1] === "'") {
					position++;
					continue;
				}
				quoted = !quoted;
			} else if (!quoted) {
				if (result[position] === "(") depth++;
				if (result[position] === ")") depth--;
				if (depth === 0 && position < result.length - 1) {
					encloses = false;
					break;
				}
			}
		}
		if (!encloses || quoted || depth !== 0) break;
		result = result.slice(1, -1).trim();
	}
	if (/^(TRUE|FALSE|NULL|CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME)$/i.test(result))
		return result.toUpperCase();
	return result;
}

/** Native catalog projection only; ownership and schema writing are separate. */
export function readSqliteRuntimeSchemaCatalog(
	database: Database.Database,
	targetTableNames: readonly string[],
	targetIndexes: readonly Readonly<{ name: string; tableName: string }>[] = [],
): RuntimeSchemaCatalog {
	return readSqliteRuntimeSchemaProjection(database, targetTableNames, targetIndexes, false);
}

/** Transaction-bound planning evidence; OIDC retains exact conservation counts. */
export function readSqliteRuntimeSchemaPlanningCatalog(
	database: Database.Database,
	targetTableNames: readonly string[],
	targetIndexes: readonly Readonly<{ name: string; tableName: string }>[] = [],
): RuntimeSchemaPlanningCatalog {
	return readSqliteRuntimeSchemaProjection(database, targetTableNames, targetIndexes, true);
}

function readSqliteRuntimeSchemaProjection(
	database: Database.Database,
	targetTableNames: readonly string[],
	targetIndexes: readonly Readonly<{ name: string; tableName: string }>[],
	planning: false,
): RuntimeSchemaCatalog;
function readSqliteRuntimeSchemaProjection(
	database: Database.Database,
	targetTableNames: readonly string[],
	targetIndexes: readonly Readonly<{ name: string; tableName: string }>[],
	planning: true,
): RuntimeSchemaPlanningCatalog;
function readSqliteRuntimeSchemaProjection(
	database: Database.Database,
	targetTableNames: readonly string[],
	targetIndexes: readonly Readonly<{ name: string; tableName: string }>[],
	planning: boolean,
): RuntimeSchemaCatalog | RuntimeSchemaPlanningCatalog {
	try {
		if (!database.open || !database.inTransaction) unavailable();
		const objects = database
			.prepare("SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY name")
			.all() as SchemaObject[];
		const temporary = database
			.prepare("SELECT type,name,tbl_name,sql FROM temp.sqlite_schema")
			.all() as SchemaObject[];
		for (const target of targetTableNames) {
			identifier(target);
			if (temporary.some((object) => object.name.toLowerCase() === target.toLowerCase()))
				unavailable();
			if (
				objects.some(
					(object) =>
						object.name.toLowerCase() === target.toLowerCase() &&
						(object.name !== target || object.type !== "table"),
				)
			)
				unavailable();
		}
		for (const target of targetIndexes) {
			identifier(target.name);
			identifier(target.tableName);
			// Tables, views and indexes share a case-insensitive main namespace.
			// Triggers do not: a compatible custom trigger can use this same name.
			// Check before cold coordination is created, not only at CREATE INDEX.
			if (
				objects.some(
					(object) =>
						object.type !== "trigger" &&
						object.name.toLowerCase() === target.name.toLowerCase() &&
						(object.name !== target.name ||
							object.type !== "index" ||
							object.tbl_name !== target.tableName),
				)
			)
				unavailable();
		}
		const nativeTables = objects.filter(
			(object) => object.type === "table" && !object.name.startsWith("sqlite_"),
		);
		const columns = new Map<string, Column[]>();
		for (const table of nativeTables) {
			if (table.sql === null) unavailable();
			const tokens = words(table.sql);
			if (
				tokens.some((token) =>
					["CHECK", "COLLATE", "GENERATED", "DEFERRABLE", "VIRTUAL", "STRICT", "CONFLICT"].includes(
						token.value,
					),
				)
			)
				unavailable();
			const result = database
				.prepare("SELECT * FROM pragma_table_xinfo(?, 'main') ORDER BY cid")
				.all(table.name) as Column[];
			if (!result.length || result.some((column) => column.hidden !== 0 || !column.type.trim()))
				unavailable();
			columns.set(table.name, result);
		}
		const tables: RuntimeSchemaPlanningTable[] = [];
		for (const table of nativeTables) {
			const nativeColumns = columns.get(table.name)!;
			const primaryKey = nativeColumns
				.filter((column) => column.pk > 0)
				.sort((left, right) => left.pk - right.pk)
				.map((column) => column.name);
			const nativeIndexes = database
				.prepare("SELECT * FROM pragma_index_list(?, 'main')")
				.all(table.name) as Index[];
			const rowidAlias =
				primaryKey.length === 1 &&
				!nativeIndexes.some((index) => index.origin === "pk") &&
				nativeColumns.some(
					(column) => column.pk === 1 && column.type.trim().toUpperCase() === "INTEGER",
				);
			const indexes: RuntimeSchemaIndex[] = [];
			for (const index of nativeIndexes.sort((left, right) =>
				left.name.localeCompare(right.name),
			)) {
				const keys = (
					database
						.prepare("SELECT * FROM pragma_index_xinfo(?, 'main') ORDER BY seqno")
						.all(index.name) as IndexColumn[]
				).filter((key) => key.key === 1);
				if (
					!keys.length ||
					keys.some(
						(key) => key.cid < 0 || key.name === null || key.desc !== 0 || key.coll !== "BINARY",
					)
				)
					unavailable();
				if (index.origin === "pk") continue;
				let predicate: string | null = null;
				if (index.partial !== 0) {
					const sql = objects.find(
						(object) => object.type === "index" && object.name === index.name,
					)?.sql;
					if (!sql) unavailable();
					const where = words(sql).find((token) => token.value === "WHERE");
					if (!where) unavailable();
					predicate = sql
						.slice(where.offset + 5)
						.trim()
						.replace(/;\s*$/, "");
					if (!predicate) unavailable();
				}
				indexes.push({
					name: index.name,
					unique: index.unique === 1,
					columns: keys.map((key) => key.name!),
					predicate,
					valid: true,
				});
			}
			const foreignKeys: RuntimeSchemaForeignKey[] = [];
			const foreignRows = database
				.prepare("SELECT * FROM pragma_foreign_key_list(?, 'main') ORDER BY id,seq")
				.all(table.name) as ForeignKey[];
			for (const id of new Set(foreignRows.map((key) => key.id))) {
				const rows = foreignRows.filter((key) => key.id === id);
				const first = rows[0]!;
				const parent = nativeTables.find(
					(candidate) => candidate.name.toLowerCase() === first.table.toLowerCase(),
				);
				if (
					!parent ||
					rows.some(
						(row, position) =>
							row.seq !== position ||
							row.table !== first.table ||
							row.match !== "NONE" ||
							row.on_delete !== first.on_delete ||
							row.on_update !== first.on_update,
					)
				)
					unavailable();
				const parentKey = columns
					.get(parent.name)!
					.filter((column) => column.pk > 0)
					.sort((left, right) => left.pk - right.pk)
					.map((column) => column.name);
				const implicit = rows.every((row) => row.to === null);
				if (
					(implicit && parentKey.length !== rows.length) ||
					(!implicit && rows.some((row) => row.to === null))
				)
					unavailable();
				foreignKeys.push({
					columns: rows.map((row) => row.from),
					targetTable: parent.name,
					targetColumns: implicit ? parentKey : rows.map((row) => row.to!),
					onDelete: first.on_delete,
					onUpdate: first.on_update,
				});
			}
			let evidence: { rowCount: number } | { rowPresence: "empty" | "nonempty" };
			if (planning && table.name !== "oidc_providers") {
				const row = database
					.prepare(`SELECT 1 AS present FROM main.${identifier(table.name)} LIMIT 1`)
					.get() as { present: number } | undefined;
				if (row !== undefined && row.present !== 1) unavailable();
				evidence = { rowPresence: row === undefined ? "empty" : "nonempty" };
			} else {
				const count = database
					.prepare(`SELECT COUNT(*) AS count FROM main.${identifier(table.name)}`)
					.safeIntegers()
					.get() as { count: bigint };
				if (
					typeof count.count !== "bigint" ||
					count.count < 0n ||
					count.count > BigInt(Number.MAX_SAFE_INTEGER)
				)
					unavailable();
				evidence = { rowCount: Number(count.count) };
			}
			const autoincrement = words(table.sql!).some((token) => token.value === "AUTOINCREMENT");
			// Preserve allocator semantics in the native type, not merely declared INTEGER affinity.
			tables.push({
				name: table.name,
				columns: nativeColumns.map((column) => ({
					name: column.name,
					type:
						column.type.trim().toUpperCase() +
						(rowidAlias && column.pk === 1 ? `;ROWID${autoincrement ? ";AUTOINCREMENT" : ""}` : ""),
					nullable: column.notnull === 0 && !(rowidAlias && column.pk === 1),
					defaultValue: normalizedDefault(column.dflt_value),
				})),
				primaryKey,
				indexes,
				foreignKeys,
				...evidence,
			});
		}
		return { provider: "sqlite", tables };
	} catch {
		// Never expose raw database errors, identifiers, SQL or pretend unreadable rows are absent.
		return unavailable();
	}
}

/** Explicit cold/schema writer; never called by ordinary client construction. */
export async function synchronizeSqliteRuntimeSchema(
	databaseUrl: string,
): Promise<RuntimeSchemaStartupSettings> {
	return timeSqliteStartupPhaseAsync("total", () =>
		synchronizeSqliteRuntimeSchemaPhases(databaseUrl),
	);
}

async function synchronizeSqliteRuntimeSchemaPhases(
	databaseUrl: string,
): Promise<RuntimeSchemaStartupSettings> {
	const registry = loadRuntimeSchemaRegistry("sqlite");
	const targets = readRuntimeSchemaRegistryTargets(registry);
	const indexes = registry.tables.flatMap(({ target }) =>
		target.indexes.map(({ name }) => ({ name, tableName: target.name })),
	);
	return provisionSqliteRestoreRuntimeSchema(
		databaseUrl,
		{ runtimeEpoch: randomUUID() },
		{
			preflight(main) {
				const catalog = timeSqliteStartupPhase("catalog-preflight", () =>
					readSqliteRuntimeSchemaPlanningCatalog(main, targets.tables, indexes),
				);
				const oidc = prepareSqliteOidcPredecessorMigration(main, registry, catalog);
				const execution = prepareRuntimeSchemaExecution(registry, oidc?.postCatalog ?? catalog);
				for (const name of [
					"RestoreRuntimeControl",
					"SqliteRestoreStorageBinding",
					"ArrSchemaMigrationReceipt",
					"ArrRuntimeDataFormatReceipt",
				]) {
					const actual = catalog.tables.find((table) => table.name === name);
					if (!actual) continue;
					const target = registry.tables.find(
						(definition) => definition.target.name === name,
					)!.target;
					if (
						actual.columns.length !== target.columns.length ||
						actual.indexes.length ||
						actual.foreignKeys.length ||
						JSON.stringify(actual.primaryKey) !== JSON.stringify(target.primaryKey) ||
						target.columns.some(
							(column) =>
								JSON.stringify(actual.columns.find((field) => field.name === column.name)) !==
								JSON.stringify(column),
						)
					)
						throw new RuntimeSchemaStartupError();
				}
				if (
					main
						.prepare(
							"SELECT 1 FROM sqlite_schema WHERE type='trigger' AND tbl_name IN ('RestoreRuntimeControl','SqliteRestoreStorageBinding','ArrSchemaMigrationReceipt') LIMIT 1",
						)
						.get()
				)
					throw new RuntimeSchemaStartupError();
				if (catalog.tables.some((table) => table.name === "ArrSchemaMigrationReceipt")) {
					for (const row of main
						.prepare(
							"SELECT id,protocolVersion,registryVersion,provider,targetDigest,planDigest,completedAt FROM ArrSchemaMigrationReceipt",
						)
						.iterate()) {
						const receipt = parseRuntimeSchemaMigrationReceipt(row);
						if (receipt.provider !== "sqlite" || receipt.registryVersion !== registry.version)
							throw new RuntimeSchemaStartupError();
					}
				}
				return {
					schema: execution,
					oidc,
					dates: timeSqliteStartupPhase("date-plan", () => planSqliteRuntimeDates(main, registry)),
				};
			},
			async apply(main, execution, assertOwned) {
				if (execution.oidc)
					await timeSqliteStartupPhaseAsync("oidc-migration", () =>
						applySqliteOidcPredecessorMigration(main, execution.oidc!, assertOwned),
					);
				await timeSqliteStartupPhaseAsync("schema-apply", () =>
					execution.schema.execute(async (sql) => {
						await assertOwned();
						main.exec(sql);
					}),
				);
				const post = timeSqliteStartupPhase("catalog-postflight", () =>
					readSqliteRuntimeSchemaPlanningCatalog(main, targets.tables, indexes),
				);
				if (prepareRuntimeSchemaExecution(registry, post).statementCount !== 0)
					throw new RuntimeSchemaStartupError();
				await timeSqliteStartupPhaseAsync("date-apply", () =>
					applySqliteRuntimeDates(main, execution.dates, assertOwned),
				);
			},
			finish(main, execution) {
				const settings = parseRuntimeSchemaStartupSettings(
					main
						.prepare("SELECT id,apiPort,webPort,listenAddress FROM system_settings LIMIT 2")
						.all() as Record<string, unknown>[],
				);
				const receipt = createRuntimeSchemaMigrationReceipt(
					execution.oidc
						? {
								...execution.schema,
								planDigest: createHash("sha256")
									.update(
										JSON.stringify({
											planDigest: execution.schema.planDigest,
											migrationId: execution.oidc.migrationId,
											target: "oidc_providers",
										}),
									)
									.digest("hex"),
							}
						: execution.schema,
				);
				const saved = main
					.prepare(
						"INSERT INTO ArrSchemaMigrationReceipt(id,protocolVersion,registryVersion,provider,targetDigest,planDigest,completedAt) VALUES(@id,@protocolVersion,@registryVersion,@provider,@targetDigest,@planDigest,@completedAt)",
					)
					.run(receipt);
				if (
					saved.changes !== 1 ||
					JSON.stringify(
						parseRuntimeSchemaMigrationReceipt(
							main
								.prepare(
									"SELECT id,protocolVersion,registryVersion,provider,targetDigest,planDigest,completedAt FROM ArrSchemaMigrationReceipt WHERE id=?",
								)
								.get(receipt.id),
						),
					) !== JSON.stringify(receipt)
				)
					throw new RuntimeSchemaStartupError();
				return settings;
			},
		},
	);
}
