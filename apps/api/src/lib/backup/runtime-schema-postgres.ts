import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import {
	parsePostgresRuntimeUrl,
	selectPostgresRuntimeNamespace,
} from "./restore-runtime-postgres-namespace.js";
import {
	RESTORE_POSTGRES_LOCK_NAMESPACE,
	RESTORE_POSTGRES_OPERATION_LOCK,
	RESTORE_POSTGRES_OWNER_LOCK,
} from "./restore-runtime-postgres.js";
import {
	createInitialRestoreRuntimeRecord,
	parseRestoreRuntimeRecord,
	prepareRestoreRuntimeStartingRecord,
} from "./restore-runtime-state.js";
import {
	type RuntimeSchemaCatalog,
	type RuntimeSchemaForeignKey,
	type RuntimeSchemaIndex,
	RuntimeSchemaPlanError,
	type RuntimeSchemaTable,
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
	parseRuntimeSchemaStartupSettings,
	RuntimeSchemaStartupError,
	type RuntimeSchemaStartupSettings,
} from "./runtime-schema-startup.js";

export type RuntimeSchemaPostgresEnum = Readonly<{ name: string; values: readonly string[] }>;
export type RuntimeSchemaPostgresCatalogRead = Readonly<{
	namespace: string;
	catalog: RuntimeSchemaCatalog;
	missingEnums: readonly string[];
}>;

type Boundary = {
	pid: number;
	namespace: string | null;
	namespaces: string[];
	started: string;
	snapshot: boolean;
};
type Relation = {
	id: string;
	name: string;
	kind: string;
	rls: boolean;
	force_rls: boolean;
	partition: boolean;
	subclass: boolean;
	persistence: string;
};
type Column = {
	table_name: string;
	position: number;
	name: string;
	type: string;
	type_name: string;
	type_namespace: string;
	type_kind: string;
	nullable: boolean;
	default_value: string | null;
	identity: string;
	generated: string;
	collation: number;
	non_default_collation: boolean;
	enum_labels: string[];
};
type Constraint = {
	table_name: string;
	kind: string;
	deferred: boolean;
	deferrable: boolean;
	validated: boolean;
	local: boolean;
	ancestors: number;
	columns: number[] | null;
	parent: string | null;
	parent_namespace: string | null;
	parent_columns: number[] | null;
	delete_action: string;
	update_action: string;
	match: string;
	delete_columns: number[] | null;
};
type Index = {
	table_name: string;
	name: string;
	unique: boolean;
	primary: boolean;
	valid: boolean;
	ready: boolean;
	live: boolean;
	immediate: boolean;
	exclusion: boolean;
	nulls_not_distinct: boolean;
	key_count: number;
	total_count: number;
	keys: number[];
	options: number[];
	collations: number[];
	default_opclasses: boolean[];
	method: string;
	expression: boolean;
	predicate: string | null;
};

function unavailable(): never {
	throw new RuntimeSchemaPlanError("unknown-schema-state");
}

function identifier(value: string): string {
	if (!value || value.includes("\0")) unavailable();
	return `"${value.replaceAll('"', '""')}"`;
}

const boundarySql = `SELECT pg_catalog.pg_backend_pid() AS pid,
	pg_catalog.current_schema() AS namespace, pg_catalog.current_schemas(false)::text[] AS namespaces,
	pg_catalog.transaction_timestamp()::text AS started,
	pg_catalog.transaction_timestamp() <> pg_catalog.statement_timestamp() AS snapshot`;

function normalizeDefault(column: Column): string | null {
	if (column.default_value === null) return null;
	let value = column.default_value.trim();
	if (/^\([+-]?(?:\d+(?:\.\d*)?|\.\d+)\)$/.test(value)) value = value.slice(1, -1);
	const literal = value.match(/^('(?:[^']|'')*'|[+-]?(?:\d+(?:\.\d*)?|\.\d+)|true|false)::(.+)$/i);
	if (literal) {
		const cast = literal[2]!;
		const expected = column.type_kind === "e" ? identifier(column.type_name) : column.type;
		if (
			cast === expected ||
			(column.type_kind === "e" && cast === `${identifier(column.type_namespace)}.${expected}`)
		)
			value =
				["integer", "smallint", "bigint"].includes(column.type) && /^'[+-]?\d+'$/.test(literal[1]!)
					? BigInt(literal[1]!.slice(1, -1)).toString()
					: literal[1]!;
	}
	if (/^(TRUE|FALSE|CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME)$/i.test(value))
		return value.toUpperCase();
	return value;
}

function boundaryValid(value: Boundary | undefined): value is Boundary & { namespace: string } {
	return (
		value !== undefined &&
		Number.isSafeInteger(value.pid) &&
		value.pid > 0 &&
		typeof value.namespace === "string" &&
		value.namespace.length > 0 &&
		Array.isArray(value.namespaces) &&
		value.namespaces.length === 1 &&
		value.namespaces[0] === value.namespace &&
		typeof value.started === "string" &&
		value.started.length > 0 &&
		value.snapshot === true
	);
}

/** Catalog evidence only; it does not own a backend, grant authority or execute DDL. */
export async function readPostgresRuntimeSchemaCatalog(
	client: Client,
	targetTables: readonly string[],
	expectedEnums: readonly RuntimeSchemaPostgresEnum[] = [],
	targetIndexes: readonly string[] = [],
): Promise<RuntimeSchemaPostgresCatalogRead> {
	try {
		const first = (await client.query<Boundary>(boundarySql)).rows[0];
		if (!boundaryValid(first)) unavailable();
		const namespace = first.namespace;
		const relations = (
			await client.query<Relation>(
				`SELECT c.oid::text AS id,c.relname AS name,c.relkind AS kind,
			c.relrowsecurity AS rls,c.relforcerowsecurity AS force_rls,c.relispartition AS partition,
			c.relhassubclass AS subclass,c.relpersistence AS persistence FROM pg_catalog.pg_class c
			JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 ORDER BY c.relname`,
				[namespace],
			)
		).rows;
		const temporary = (
			await client.query<{ name: string }>(
				"SELECT relname AS name FROM pg_catalog.pg_class WHERE relnamespace=pg_catalog.pg_my_temp_schema()",
			)
		).rows;
		for (const [targets, kind] of [
			[targetTables, "r"],
			[targetIndexes, "i"],
		] as const) {
			for (const name of targets) {
				identifier(name);
				if (
					temporary.some((relation) => relation.name === name) ||
					relations.some((relation) => relation.name === name && relation.kind !== kind)
				)
					unavailable();
			}
		}
		const nativeTypes = (
			await client.query<{ name: string; kind: string; values: string[] }>(
				`SELECT t.typname AS name,t.typtype AS kind,
				ARRAY(SELECT e.enumlabel::text FROM pg_catalog.pg_enum e WHERE e.enumtypid=t.oid ORDER BY e.enumsortorder) AS values
			FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=$1`,
				[namespace],
			)
		).rows;
		const missingEnums: string[] = [];
		const seenEnums = new Set<string>();
		for (const expected of expectedEnums) {
			identifier(expected.name);
			if (
				seenEnums.has(expected.name) ||
				!Array.isArray(expected.values) ||
				expected.values.length === 0 ||
				new Set(expected.values).size !== expected.values.length ||
				expected.values.some((value) => typeof value !== "string" || !value || value.includes("\0"))
			)
				unavailable();
			seenEnums.add(expected.name);
			const actual = nativeTypes.find((type) => type.name === expected.name);
			if (!actual) missingEnums.push(expected.name);
			else if (
				actual.kind !== "e" ||
				JSON.stringify(actual.values) !== JSON.stringify(expected.values)
			)
				unavailable();
		}
		const nativeTables = relations.filter((relation) => relation.kind === "r");
		if (
			relations.some((relation) => relation.kind === "p") ||
			nativeTables.some(
				(table) =>
					table.rls ||
					table.force_rls ||
					table.partition ||
					table.subclass ||
					table.persistence !== "p",
			)
		)
			unavailable();
		const columns = (
			await client.query<Column>(
				`SELECT c.relname AS table_name,a.attnum AS position,a.attname AS name,
			pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,t.typname AS type_name,tn.nspname AS type_namespace,
			t.typtype AS type_kind,NOT a.attnotnull AS nullable,pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_value,
			a.attidentity AS identity,a.attgenerated AS generated,a.attcollation AS collation,
			a.attcollation<>t.typcollation AS non_default_collation,
				ARRAY(SELECT e.enumlabel::text FROM pg_catalog.pg_enum e WHERE e.enumtypid=t.oid ORDER BY e.enumsortorder) AS enum_labels
			FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
			JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_type t ON t.oid=a.atttypid
			JOIN pg_catalog.pg_namespace tn ON tn.oid=t.typnamespace
			LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
			WHERE n.nspname=$1 AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`,
				[namespace],
			)
		).rows;
		if (
			columns.some(
				(column) =>
					column.generated !== "" ||
					column.non_default_collation ||
					!(
						(column.type_kind === "b" && column.type_namespace === "pg_catalog") ||
						(column.type_kind === "e" &&
							column.type_namespace === namespace &&
							column.enum_labels.length > 0)
					) ||
					!["", "a", "d"].includes(column.identity),
			)
		)
			unavailable();
		const constraints = (
			await client.query<Constraint>(
				`SELECT c.relname AS table_name,k.contype AS kind,
			k.condeferred AS deferred,k.condeferrable AS deferrable,k.convalidated AS validated,k.conislocal AS local,k.coninhcount AS ancestors,
			k.conkey AS columns,p.relname AS parent,pn.nspname AS parent_namespace,k.confkey AS parent_columns,
			k.confdeltype AS delete_action,k.confupdtype AS update_action,k.confmatchtype AS match,k.confdelsetcols AS delete_columns
			FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid
			JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
			LEFT JOIN pg_catalog.pg_class p ON p.oid=k.confrelid LEFT JOIN pg_catalog.pg_namespace pn ON pn.oid=p.relnamespace
			WHERE n.nspname=$1 ORDER BY c.relname,k.oid`,
				[namespace],
			)
		).rows;
		if (
			constraints.some(
				(constraint) =>
					!["p", "u", "f"].includes(constraint.kind) ||
					constraint.deferred ||
					constraint.deferrable ||
					!constraint.validated ||
					!constraint.local ||
					constraint.ancestors !== 0,
			)
		)
			unavailable();
		const nativeIndexes = (
			await client.query<Index>(
				`SELECT c.relname AS table_name,ic.relname AS name,i.indisunique AS unique,
			i.indisprimary AS primary,i.indisvalid AS valid,i.indisready AS ready,i.indislive AS live,i.indimmediate AS immediate,
			i.indisexclusion AS exclusion,i.indnullsnotdistinct AS nulls_not_distinct,i.indnkeyatts AS key_count,i.indnatts AS total_count,
			i.indkey::smallint[] AS keys,i.indoption::smallint[] AS options,i.indcollation::oid[] AS collations,
			ARRAY(SELECT o.opcdefault FROM unnest(i.indclass::oid[]) WITH ORDINALITY x(id,position)
				JOIN pg_catalog.pg_opclass o ON o.oid=x.id ORDER BY x.position) AS default_opclasses,
			am.amname AS method,i.indexprs IS NOT NULL AS expression,pg_catalog.pg_get_expr(i.indpred,i.indrelid) AS predicate
			FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indrelid JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid
			JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_am am ON am.oid=ic.relam
			WHERE n.nspname=$1 ORDER BY c.relname,ic.relname`,
				[namespace],
			)
		).rows;
		const action = (value: string): string => {
			const result = (
				{ a: "NO ACTION", r: "RESTRICT", c: "CASCADE", n: "SET NULL", d: "SET DEFAULT" } as Record<
					string,
					string
				>
			)[value];
			return result ?? unavailable();
		};
		const columnNames = (table: string, positions: number[] | null): string[] => {
			if (!positions || positions.length === 0) unavailable();
			return positions.map(
				(position) =>
					columns.find((column) => column.table_name === table && column.position === position)
						?.name ?? unavailable(),
			);
		};
		const tables: RuntimeSchemaTable[] = [];
		for (const table of nativeTables) {
			const fields = columns.filter((column) => column.table_name === table.name);
			if (fields.length === 0) unavailable();
			const primary = constraints.filter(
				(constraint) => constraint.table_name === table.name && constraint.kind === "p",
			);
			if (primary.length > 1) unavailable();
			const indexes: RuntimeSchemaIndex[] = [];
			for (const index of nativeIndexes.filter((index) => index.table_name === table.name)) {
				if (
					!index.valid ||
					!index.ready ||
					!index.live ||
					!index.immediate ||
					index.exclusion ||
					index.nulls_not_distinct ||
					index.expression ||
					index.method !== "btree" ||
					index.key_count !== index.total_count ||
					index.keys.length !== index.key_count ||
					index.options.length !== index.key_count ||
					index.collations.length !== index.key_count ||
					index.default_opclasses.length !== index.key_count ||
					index.options.some((option) => option !== 0) ||
					index.default_opclasses.some((value) => value !== true) ||
					index.keys.some(
						(position, ordinal) =>
							fields.find((column) => column.position === position)?.collation !==
							Number(index.collations[ordinal]),
					)
				)
					unavailable();
				if (!index.primary)
					indexes.push({
						name: index.name,
						unique: index.unique,
						columns: columnNames(table.name, index.keys),
						predicate: index.predicate,
						valid: true,
					});
			}
			const foreignKeys: RuntimeSchemaForeignKey[] = [];
			for (const constraint of constraints.filter(
				(constraint) => constraint.table_name === table.name && constraint.kind === "f",
			)) {
				if (
					constraint.parent_namespace !== namespace ||
					!constraint.parent ||
					constraint.match !== "s" ||
					constraint.delete_columns !== null
				)
					unavailable();
				foreignKeys.push({
					columns: columnNames(table.name, constraint.columns),
					targetTable: constraint.parent,
					targetColumns: columnNames(constraint.parent, constraint.parent_columns),
					onDelete: action(constraint.delete_action),
					onUpdate: action(constraint.update_action),
				});
			}
			const count = (
				await client.query<{ count: string }>(
					`SELECT COUNT(*)::text AS count FROM ${identifier(namespace)}.${identifier(table.name)}`,
				)
			).rows[0]?.count;
			if (
				typeof count !== "string" ||
				!/^\d+$/.test(count) ||
				BigInt(count) > BigInt(Number.MAX_SAFE_INTEGER)
			)
				unavailable();
			tables.push({
				name: table.name,
				columns: fields.map((column) => ({
					name: column.name,
					type:
						(column.type_kind === "e"
							? `ENUM:${JSON.stringify([column.type_name, column.enum_labels])}`
							: column.type.toUpperCase()) +
						(column.identity ? `;IDENTITY:${column.identity}` : ""),
					nullable: column.nullable,
					defaultValue: normalizeDefault(column),
				})),
				primaryKey: primary.length ? columnNames(table.name, primary[0]!.columns) : [],
				indexes,
				foreignKeys,
				rowCount: Number(count),
			});
		}
		const last = (await client.query<Boundary>(boundarySql)).rows[0];
		if (
			!boundaryValid(last) ||
			last.pid !== first.pid ||
			last.namespace !== namespace ||
			last.started !== first.started
		)
			unavailable();
		return Object.freeze({
			namespace,
			catalog: { provider: "postgresql" as const, tables },
			missingEnums: Object.freeze(missingEnums),
		});
	} catch {
		return unavailable();
	}
}

const runtimeColumns = [
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
const runtimeProjection = runtimeColumns
	.map((column) =>
		column === "lastCommittedAt"
			? `to_char("lastCommittedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastCommittedAt"`
			: identifier(column),
	)
	.join(", ");
type WriterBackend = Readonly<{ pid: number; started: string; database: string }>;

function nativeWriterUrl(databaseUrl: string): { connectionString: string; schema: string | null } {
	try {
		return parsePostgresRuntimeUrl(databaseUrl);
	} catch {
		throw new RuntimeSchemaStartupError();
	}
}

function writerClient(connectionString: string): Client {
	return new Client({
		connectionString,
		connectionTimeoutMillis: 5000,
		query_timeout: 6000,
		statement_timeout: 5000,
		lock_timeout: 4000,
		idle_in_transaction_session_timeout: 10000,
		application_name: "arr-dashboard-schema-startup",
		keepAlive: true,
	});
}

async function closeNativeClient(client: Client): Promise<void> {
	const timer = setTimeout(() => client.connection.stream.destroy(), 1000);
	try {
		await client.end();
	} finally {
		clearTimeout(timer);
	}
}

/** Local socket end is not proof that a timed-out DDL backend released its locks. */
async function observeWriterClosure(
	connectionString: string,
	backend: WriterBackend,
): Promise<void> {
	const observer = writerClient(connectionString);
	observer.on("error", () => {});
	try {
		await observer.connect();
		const deadline = performance.now() + 6000;
		for (;;) {
			const rows = (
				await observer.query<{ present: boolean }>(
					`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity WHERE pid=$1 AND backend_start=$2::timestamptz AND datid=$3::oid) AS present`,
					[backend.pid, backend.started, backend.database],
				)
			).rows;
			if (rows.length !== 1 || typeof rows[0]?.present !== "boolean")
				throw new RuntimeSchemaStartupError("closure-unverified");
			if (!rows[0].present) return;
			if (performance.now() >= deadline) throw new RuntimeSchemaStartupError("closure-unverified");
			await delay(25);
		}
	} catch {
		throw new RuntimeSchemaStartupError("closure-unverified");
	} finally {
		await closeNativeClient(observer);
	}
}

function strictProtocolShape(
	actual: RuntimeSchemaTable | undefined,
	target: RuntimeSchemaTable,
): void {
	if (!actual) return;
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

/** Explicit startup actor. Ordinary connection opening never initializes schemas. */
export async function synchronizePostgresRuntimeSchema(
	databaseUrl: string,
): Promise<RuntimeSchemaStartupSettings> {
	const configured = nativeWriterUrl(databaseUrl);
	const registry = loadRuntimeSchemaRegistry("postgresql");
	const targets = readRuntimeSchemaRegistryTargets(registry);
	const client = writerClient(configured.connectionString);
	let lost = false;
	client.on("error", () => {
		lost = true;
	});
	client.on("end", () => {
		lost = true;
	});
	let backend: WriterBackend | undefined;
	let began = false;
	let commitStarted = false;
	let commitAcknowledged = false;
	let settings: RuntimeSchemaStartupSettings | undefined;
	let failure: RuntimeSchemaStartupError | undefined;
	const assertOwnership = async () => {
		if (lost || !backend) throw new RuntimeSchemaStartupError();
		const proof = (
			await client.query<{ owned: boolean }>(
				`SELECT count(*)=2 AS owned FROM pg_catalog.pg_locks WHERE locktype='advisory' AND database=$1::oid AND pid=pg_catalog.pg_backend_pid() AND pid=$2 AND classid=$3::oid AND objid IN ($4::oid,$5::oid) AND objsubid=2 AND granted AND mode='ExclusiveLock'`,
				[
					backend.database,
					backend.pid,
					RESTORE_POSTGRES_LOCK_NAMESPACE,
					RESTORE_POSTGRES_OWNER_LOCK,
					RESTORE_POSTGRES_OPERATION_LOCK,
				],
			)
		).rows;
		if (lost || proof.length !== 1 || proof[0]?.owned !== true)
			throw new RuntimeSchemaStartupError();
	};
	try {
		await client.connect();
		await client.query("SET TIME ZONE 'UTC'");
		await client.query(
			"SET statement_timeout='5000ms'; SET lock_timeout='4000ms'; SET idle_in_transaction_session_timeout='10000ms'",
		);
		await selectPostgresRuntimeNamespace(client, configured.schema);
		const identity = (
			await client.query<WriterBackend>(
				`SELECT pid,backend_start::text AS started,datid::text AS database FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid()`,
			)
		).rows;
		if (
			identity.length !== 1 ||
			!Number.isSafeInteger(identity[0]?.pid) ||
			identity[0]!.pid < 1 ||
			typeof identity[0]?.started !== "string" ||
			typeof identity[0]?.database !== "string" ||
			!/^\d+$/.test(identity[0]!.database)
		)
			throw new RuntimeSchemaStartupError();
		backend = identity[0]!;
		const owner = (
			await client.query<{ acquired: boolean }>(
				"SELECT pg_catalog.pg_try_advisory_lock($1,$2) AS acquired",
				[RESTORE_POSTGRES_LOCK_NAMESPACE, RESTORE_POSTGRES_OWNER_LOCK],
			)
		).rows;
		if (owner[0]?.acquired !== true) throw new RuntimeSchemaStartupError();
		await client.query("BEGIN");
		began = true;
		const operation = (
			await client.query<{ acquired: boolean }>(
				"SELECT pg_catalog.pg_try_advisory_xact_lock($1,$2) AS acquired",
				[RESTORE_POSTGRES_LOCK_NAMESPACE, RESTORE_POSTGRES_OPERATION_LOCK],
			)
		).rows;
		if (operation[0]?.acquired !== true) throw new RuntimeSchemaStartupError();
		await assertOwnership();
		const read = () =>
			readPostgresRuntimeSchemaCatalog(client, targets.tables, targets.enums, targets.indexes);
		const before = await read();
		const prepared = prepareRuntimeSchemaExecution(registry, before.catalog, before.missingEnums);
		const control = before.catalog.tables.find((table) => table.name === "RestoreRuntimeControl");
		const receiptTable = before.catalog.tables.find(
			(table) => table.name === "ArrSchemaMigrationReceipt",
		);
		for (const name of ["RestoreRuntimeControl", "ArrSchemaMigrationReceipt"])
			strictProtocolShape(
				before.catalog.tables.find((table) => table.name === name),
				registry.tables.find((definition) => definition.target.name === name)!.target,
			);
		if (!control && receiptTable) throw new RuntimeSchemaStartupError();
		// Protocol writes must not execute user triggers or silently rewrite evidence.
		const triggers = (
			await client.query<{ present: boolean }>(
				`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname IN ('RestoreRuntimeControl','ArrSchemaMigrationReceipt') AND NOT t.tgisinternal) AS present`,
				[before.namespace],
			)
		).rows;
		if (triggers[0]?.present !== false) throw new RuntimeSchemaStartupError();
		const priorRows = control
			? (await client.query(`SELECT ${runtimeProjection} FROM "RestoreRuntimeControl" LIMIT 2`))
					.rows
			: [];
		if (control && priorRows.length !== 1) throw new RuntimeSchemaStartupError();
		const startingRequest = { runtimeEpoch: randomUUID(), ownerBackendPid: backend.pid };
		const next = control
			? prepareRestoreRuntimeStartingRecord(
					parseRestoreRuntimeRecord(priorRows[0]),
					startingRequest,
				)
			: createInitialRestoreRuntimeRecord(startingRequest);
		if (receiptTable) {
			const prior = (
				await client.query<{ invalid: boolean }>(
					`SELECT EXISTS(SELECT 1 FROM "ArrSchemaMigrationReceipt" WHERE "protocolVersion"<>1 OR "registryVersion"<>1 OR provider<>'postgresql' OR id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR "targetDigest" !~ '^[0-9a-f]{64}$' OR "planDigest" !~ '^[0-9a-f]{64}$' OR NOT pg_catalog.isfinite("completedAt")) AS invalid`,
				)
			).rows;
			if (prior[0]?.invalid !== false) throw new RuntimeSchemaStartupError();
		}
		await prepared.execute(async (sql) => {
			await assertOwnership();
			await client.query(sql);
		});
		const after = await read();
		const post = prepareRuntimeSchemaExecution(registry, after.catalog, after.missingEnums);
		if (after.namespace !== before.namespace || post.statementCount !== 0)
			throw new RuntimeSchemaStartupError();
		const values = runtimeColumns.map((column) => next[column]);
		const changed = control
			? await client.query(
					`UPDATE "RestoreRuntimeControl" SET ${runtimeColumns.map((column, index) => `${identifier(column)}=$${index + 1}`).join(", ")} WHERE id=1`,
					values,
				)
			: await client.query(
					`INSERT INTO "RestoreRuntimeControl"(${runtimeColumns.map(identifier).join(", ")}) VALUES(${runtimeColumns.map((_, index) => `$${index + 1}`).join(", ")})`,
					values,
				);
		if (changed.rowCount !== 1) throw new RuntimeSchemaStartupError();
		const checked = (
			await client.query(`SELECT ${runtimeProjection} FROM "RestoreRuntimeControl" LIMIT 2`)
		).rows;
		if (
			checked.length !== 1 ||
			JSON.stringify(parseRestoreRuntimeRecord(checked[0])) !== JSON.stringify(next)
		)
			throw new RuntimeSchemaStartupError();
		settings = parseRuntimeSchemaStartupSettings(
			(
				await client.query(
					'SELECT id,"apiPort","webPort","listenAddress" FROM "system_settings" LIMIT 2',
				)
			).rows,
		);
		const receipt = createRuntimeSchemaMigrationReceipt(prepared);
		const saved = (
			await client.query(
				`INSERT INTO "ArrSchemaMigrationReceipt"(id,"protocolVersion","registryVersion",provider,"targetDigest","planDigest","completedAt") VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,"protocolVersion","registryVersion",provider,"targetDigest","planDigest",to_char("completedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "completedAt"`,
				[
					receipt.id,
					receipt.protocolVersion,
					receipt.registryVersion,
					receipt.provider,
					receipt.targetDigest,
					receipt.planDigest,
					receipt.completedAt,
				],
			)
		).rows;
		if (
			saved.length !== 1 ||
			JSON.stringify(parseRuntimeSchemaMigrationReceipt(saved[0])) !== JSON.stringify(receipt)
		)
			throw new RuntimeSchemaStartupError();
		await assertOwnership();
		commitStarted = true;
		await client.query("COMMIT");
		commitAcknowledged = true;
		began = false;
	} catch {
		failure = new RuntimeSchemaStartupError(
			commitStarted && !commitAcknowledged ? "commit-unknown" : "startup-unavailable",
		);
	} finally {
		try {
			if (began) await client.query("ROLLBACK");
		} catch {
			failure ??= new RuntimeSchemaStartupError();
		} finally {
			try {
				await closeNativeClient(client);
				if (backend) await observeWriterClosure(configured.connectionString, backend);
			} catch {
				failure ??= new RuntimeSchemaStartupError("closure-unverified");
			}
		}
	}
	if (failure) throw failure;
	if (!settings || !backend || !commitAcknowledged) throw new RuntimeSchemaStartupError();
	return settings;
}
