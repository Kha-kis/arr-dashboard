import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { encodeCanonicalSqliteDate, SqliteDateCompatibilityError } from "../sqlite-datetime.js";
import type { RuntimeSchemaRegistry } from "./runtime-schema-catalog.js";

export const SQLITE_DATE_FORMAT_RECEIPT_SQL = `CREATE TABLE "ArrRuntimeDataFormatReceipt" (
	"id" INTEGER NOT NULL PRIMARY KEY,
	"formatVersion" INTEGER NOT NULL,
	"dateColumnsDigest" TEXT NOT NULL,
	"completedAt" TEXT NOT NULL,
	"normalizedValues" INTEGER NOT NULL
);`;

export type SqliteRuntimeDatePlan = Readonly<{
	formatVersion: 1;
	dateColumnsDigest: string;
	tableCount: number;
	rowsInspected: number;
	normalizedValues: number;
}>;
type Field = Readonly<{ name: string; nullable: boolean }>;
type Target = Readonly<{ name: string; keys: readonly string[]; dates: readonly Field[] }>;
type Snapshot = { digest: string; rows: number; changes: number; fields: readonly string[] };
type Receipt = {
	id: number;
	formatVersion: number;
	dateColumnsDigest: string;
	completedAt: string;
	normalizedValues: number;
};
type Sealed = {
	main: Database.Database;
	targets: readonly Target[];
	snapshots: Map<string, Snapshot>;
	receipt: Receipt | null;
	consumed: boolean;
};
type Column = {
	name: string;
	type: string;
	notnull: number;
	pk: number;
	hidden: number;
	dflt_value: string | null;
};
type Token = { value: string; quoted: boolean };
const plans = new WeakMap<SqliteRuntimeDatePlan, Sealed>();
const marker = "ArrRuntimeDataFormatReceipt";
const native = new Set([
	"RestoreRuntimeControl",
	"SqliteRestoreStorageBinding",
	"ArrSchemaMigrationReceipt",
	marker,
]);
// Exact date projections for additive Grab, Outbox and qUI observation schemas.
// A different future projection needs its own reviewed transition, not subset inference.
const DATE_SCHEMA_TRANSITIONS = [
	{
		predecessorDigest: "3da1d2a3f20b99398c59d5dd2e9e42c58c52b42fab85eec3f2b8a0ff8f48d13c",
		targetDigest: "b6e86495dde99cde0a3f93fddb35afabfbfed5b7f66afb0a14143c2306c0d798",
		newTables: ["SearchGrabAttempt", "SearchGrabClaim"],
	},
	{
		predecessorDigest: "b6e86495dde99cde0a3f93fddb35afabfbfed5b7f66afb0a14143c2306c0d798",
		targetDigest: "dfff1559e9d891f254c5c830d36ec7d8e188c5e342d1bdb840baa33437a555c1",
		newTables: ["NotificationOutboxEvent", "NotificationOutboxDelivery"],
	},
	{
		predecessorDigest: "3da1d2a3f20b99398c59d5dd2e9e42c58c52b42fab85eec3f2b8a0ff8f48d13c",
		targetDigest: "dfff1559e9d891f254c5c830d36ec7d8e188c5e342d1bdb840baa33437a555c1",
		newTables: [
			"SearchGrabAttempt",
			"SearchGrabClaim",
			"NotificationOutboxEvent",
			"NotificationOutboxDelivery",
		],
	},
	{
		predecessorDigest: "dfff1559e9d891f254c5c830d36ec7d8e188c5e342d1bdb840baa33437a555c1",
		targetDigest: "059526a07e5f503d51c02273353515471d0d4b6f3d65ffbb40b8e612d5fd0889",
		newTables: ["qui_observation_publications", "qui_torrent_observations"],
	},
	{
		predecessorDigest: "b6e86495dde99cde0a3f93fddb35afabfbfed5b7f66afb0a14143c2306c0d798",
		targetDigest: "059526a07e5f503d51c02273353515471d0d4b6f3d65ffbb40b8e612d5fd0889",
		newTables: [
			"NotificationOutboxEvent",
			"NotificationOutboxDelivery",
			"qui_observation_publications",
			"qui_torrent_observations",
		],
	},
	{
		predecessorDigest: "3da1d2a3f20b99398c59d5dd2e9e42c58c52b42fab85eec3f2b8a0ff8f48d13c",
		targetDigest: "059526a07e5f503d51c02273353515471d0d4b6f3d65ffbb40b8e612d5fd0889",
		newTables: [
			"SearchGrabAttempt",
			"SearchGrabClaim",
			"NotificationOutboxEvent",
			"NotificationOutboxDelivery",
			"qui_observation_publications",
			"qui_torrent_observations",
		],
	},
] as const;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const quote = (value: string) => {
	if (!value || value.includes("\0")) refuse();
	return `"${value.replaceAll('"', '""')}"`;
};
function refuse(): never {
	throw new SqliteDateCompatibilityError();
}
function requireTransaction(main: Database.Database) {
	if (
		!main.open ||
		main.readonly ||
		!main.inTransaction ||
		main.pragma("foreign_keys", { simple: true }) !== 1
	)
		refuse();
}
function canonical(value: unknown, nullable: boolean) {
	const result = encodeCanonicalSqliteDate(value, nullable);
	if (result !== null && !/^\d{4}-/.test(result)) refuse();
	return result;
}

/** Reuse pure encodings only; each table/pass still reads and hashes every row. */
function canonicalDateReader() {
	const required = new Map<string | number, string | null>();
	const optional = new Map<string | number, string | null>();
	return (value: unknown, nullable: boolean): string | null => {
		if (typeof value !== "string" && typeof value !== "number") return canonical(value, nullable);
		const cache = nullable ? optional : required;
		const found = cache.get(value);
		if (found !== undefined) return found;
		const result = canonical(value, nullable);
		if (cache.size === 256) cache.clear();
		cache.set(value, result);
		return result;
	};
}
function columns(main: Database.Database, name: string): Column[] {
	return main.prepare("SELECT * FROM pragma_table_xinfo(?, 'main')").all(name) as Column[];
}
function present(main: Database.Database, name: string) {
	const objects = main
		.prepare("SELECT name,type FROM main.sqlite_schema WHERE name=? COLLATE NOCASE")
		.all(name) as { name: string; type: string }[];
	if (objects.length === 0) return false;
	if (objects.length !== 1 || objects[0]!.name !== name || objects[0]!.type !== "table") refuse();
	return true;
}
function readReceipt(
	main: Database.Database,
	digest: string,
	predecessorDigests: readonly string[] = [],
): Receipt | null {
	if (!present(main, marker)) return null;
	const expected = [
		["id", "INTEGER"],
		["formatVersion", "INTEGER"],
		["dateColumnsDigest", "TEXT"],
		["completedAt", "TEXT"],
		["normalizedValues", "INTEGER"],
	];
	const actual = columns(main, marker);
	if (
		actual.length !== expected.length ||
		actual.some(
			(c, i) =>
				c.name !== expected[i]![0] ||
				c.type.toUpperCase() !== expected[i]![1] ||
				c.hidden !== 0 ||
				c.pk !== (i === 0 ? 1 : 0) ||
				(i !== 0 && c.notnull !== 1) ||
				c.dflt_value !== null,
		) ||
		main
			.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='trigger' AND tbl_name=? LIMIT 1")
			.get(marker) ||
		main
			.prepare("SELECT 1 FROM temp.sqlite_schema WHERE type='trigger' AND tbl_name=? LIMIT 1")
			.get(marker) ||
		main.prepare("SELECT * FROM pragma_index_list(?, 'main')").all(marker).length ||
		main.prepare("SELECT * FROM pragma_foreign_key_list(?, 'main')").all(marker).length
	)
		refuse();
	const rows = main.prepare(`SELECT * FROM main.${quote(marker)} LIMIT 2`).all() as Receipt[];
	if (!rows.length) return null;
	if (rows.length !== 1) refuse();
	const row = rows[0]!;
	if (
		row.id !== 1 ||
		row.formatVersion !== 1 ||
		(row.dateColumnsDigest !== digest && !predecessorDigests.includes(row.dateColumnsDigest)) ||
		!Number.isSafeInteger(row.normalizedValues) ||
		row.normalizedValues < 0 ||
		typeof row.completedAt !== "string" ||
		canonical(row.completedAt, false) !== row.completedAt
	)
		refuse();
	return row;
}

/** Header-only recognition. Unknown syntax is refusal, never permission to write. */
function* triggerTokens(sql: string): Generator<Token> {
	let offset = 0;
	while (offset < sql.length) {
		if (offset > 8192) refuse();
		if (/\s/.test(sql[offset]!)) {
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
		const first = sql[offset]!;
		if (['"', "'", "`", "["].includes(first)) {
			const end = first === "[" ? "]" : first;
			let value = "",
				closed = false;
			offset++;
			while (offset < sql.length) {
				const c = sql[offset++]!;
				if (c !== end) {
					value += c;
					continue;
				}
				if (end !== "]" && sql[offset] === end) {
					value += end;
					offset++;
					continue;
				}
				closed = true;
				break;
			}
			if (!closed) refuse();
			yield { value, quoted: true };
			continue;
		}
		const word = /^[\p{L}_$][\p{L}\p{N}_$]*/u.exec(sql.slice(offset));
		if (word) {
			offset += word[0].length;
			yield { value: word[0], quoted: false };
			continue;
		}
		if (first === "." || first === ",") {
			offset++;
			yield { value: first, quoted: false };
			continue;
		}
		refuse();
	}
}
function triggerAffectsDates(sql: string, table: Target): boolean {
	const iterator = triggerTokens(sql);
	let token = iterator.next().value as Token | undefined;
	const keyword = (value: string) =>
		!!token && !token.quoted && token.value.toUpperCase() === value;
	const next = () => {
		token = iterator.next().value as Token | undefined;
	};
	const requireWord = (value: string) => {
		if (!keyword(value)) refuse();
		next();
	};
	const name = () => {
		if (!token || (!token.quoted && !/^[\p{L}_$]/u.test(token.value))) refuse();
		const result = token.value;
		next();
		return result;
	};
	requireWord("CREATE");
	if (keyword("TEMP") || keyword("TEMPORARY")) next();
	requireWord("TRIGGER");
	if (keyword("IF")) {
		next();
		requireWord("NOT");
		requireWord("EXISTS");
	}
	name();
	if (token?.value === ".") {
		next();
		name();
	}
	if (keyword("BEFORE") || keyword("AFTER")) next();
	else if (keyword("INSTEAD")) {
		next();
		requireWord("OF");
	}
	if (keyword("INSERT") || keyword("DELETE")) return false;
	requireWord("UPDATE");
	let fields: string[] | null = null;
	if (keyword("OF")) {
		next();
		fields = [name()];
		while (token?.value === ",") {
			next();
			fields.push(name());
		}
	}
	requireWord("ON");
	let actual = name();
	if (token?.value === ".") {
		if (actual.toLowerCase() !== "main") refuse();
		next();
		actual = name();
	}
	if (actual.toLowerCase() !== table.name.toLowerCase()) refuse();
	return (
		fields === null ||
		fields.some((field) =>
			table.dates.some((date) => date.name.toLowerCase() === field.toLowerCase()),
		)
	);
}
function assertEffectsSafe(main: Database.Database, table: Target) {
	const triggers = main
		.prepare(
			"SELECT sql FROM main.sqlite_schema WHERE type='trigger' AND tbl_name=? UNION ALL SELECT sql FROM temp.sqlite_schema WHERE type='trigger' AND tbl_name=?",
		)
		.all(table.name, table.name) as { sql: string | null }[];
	for (const trigger of triggers)
		if (typeof trigger.sql !== "string" || triggerAffectsDates(trigger.sql, table)) refuse();
	if (table.keys.some((key) => table.dates.some((date) => date.name === key))) refuse();
	const names = main
		.prepare("SELECT name FROM main.sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'")
		.all() as { name: string }[];
	for (const { name } of names) {
		const keys = main.prepare("SELECT * FROM pragma_foreign_key_list(?, 'main')").all(name) as {
			table: string;
			from: string;
			to: string | null;
		}[];
		for (const key of keys)
			if (
				(name === table.name && table.dates.some((date) => date.name === key.from)) ||
				(key.table.toLowerCase() === table.name.toLowerCase() &&
					key.to !== null &&
					table.dates.some((date) => date.name.toLowerCase() === key.to!.toLowerCase()))
			)
				refuse();
	}
}
function selectedFields(main: Database.Database, table: Target, complete: boolean): string[] {
	if (!present(main, table.name)) {
		if (complete) refuse();
		return [];
	}
	const actual = columns(main, table.name);
	const keys = actual
		.filter((c) => c.pk > 0)
		.sort((a, b) => a.pk - b.pk)
		.map((c) => c.name);
	if (hash(keys) !== hash(table.keys) || !keys.length) refuse();
	for (const date of table.dates) {
		const field = actual.find((c) => c.name === date.name);
		if (!field) {
			if (complete) refuse();
			continue;
		}
		if (field.type.toUpperCase() !== "DATETIME" || field.hidden !== 0) refuse();
	}
	return table.dates.filter((d) => actual.some((c) => c.name === d.name)).map((d) => d.name);
}
function query(main: Database.Database, table: Target, fields: readonly string[]) {
	return main.prepare(
		`SELECT ${[...table.keys, ...fields].map(quote).join(",")} FROM main.${quote(table.name)} ORDER BY ${table.keys.map(quote).join(",")}`,
	);
}
function rowKeys(row: Record<string, unknown>, table: Target): unknown[] {
	return table.keys.map((key) => {
		const value = row[key];
		if (typeof value !== "string" && !(typeof value === "number" && Number.isSafeInteger(value)))
			refuse();
		return value;
	});
}
function scan(main: Database.Database, table: Target, fields: readonly string[]): Snapshot {
	const digest = createHash("sha256");
	const readDate = canonicalDateReader();
	let rows = 0,
		changes = 0;
	if (present(main, table.name))
		for (const raw of query(main, table, fields).iterate()) {
			const row = raw as Record<string, unknown>;
			rowKeys(row, table);
			for (const field of fields) {
				const value = readDate(row[field], table.dates.find((d) => d.name === field)!.nullable);
				if (value !== row[field]) changes++;
			}
			digest.update(`${JSON.stringify([...table.keys, ...fields].map((field) => row[field]))}\n`);
			rows++;
			if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(changes)) refuse();
		}
	return { digest: digest.digest("hex"), rows, changes, fields };
}

/** Validate all existing values without changing the transaction, schema or data. */
export function planSqliteRuntimeDates(
	main: Database.Database,
	registry: RuntimeSchemaRegistry,
): SqliteRuntimeDatePlan {
	try {
		requireTransaction(main);
		if (registry.provider !== "sqlite") refuse();
		const targets: Target[] = registry.tables
			.filter((t) => !native.has(t.target.name))
			.map(({ target }) => ({
				name: target.name,
				keys: [...target.primaryKey],
				dates: target.columns
					.filter((c) => c.type === "DATETIME")
					.map((c) => ({ name: c.name, nullable: c.nullable })),
			}))
			.filter((t) => t.dates.length)
			.sort((a, b) => a.name.localeCompare(b.name));
		const dateColumnsDigest = hash(targets);
		const predecessorDigests = DATE_SCHEMA_TRANSITIONS.filter(
			(transition) =>
				dateColumnsDigest === transition.targetDigest &&
				hash(
					targets.filter((table) => !transition.newTables.some((name) => name === table.name)),
				) === transition.predecessorDigest &&
				transition.newTables.every((name) => !present(main, name)),
		).map((transition) => transition.predecessorDigest);
		const receipt = readReceipt(main, dateColumnsDigest, predecessorDigests),
			snapshots = new Map<string, Snapshot>();
		let rowsInspected = 0,
			normalizedValues = 0;
		for (const table of targets) {
			const fields = selectedFields(main, table, false),
				s = scan(main, table, fields);
			snapshots.set(table.name, s);
			rowsInspected += s.rows;
			normalizedValues += s.changes;
			if (s.changes) assertEffectsSafe(main, table);
		}
		if (
			!Number.isSafeInteger(rowsInspected) ||
			!Number.isSafeInteger(normalizedValues) ||
			(receipt && normalizedValues)
		)
			refuse();
		const plan = Object.freeze({
			formatVersion: 1 as const,
			dateColumnsDigest,
			tableCount: targets.length,
			rowsInspected,
			normalizedValues,
		});
		plans.set(plan, { main, targets, snapshots, receipt, consumed: false });
		return plan;
	} catch (error) {
		if (error instanceof SqliteDateCompatibilityError) throw error;
		refuse();
	}
}

/** The caller owns rollback/commit and physical closure; this function never commits. */
export async function applySqliteRuntimeDates(
	main: Database.Database,
	plan: SqliteRuntimeDatePlan,
	assertOwned: () => Promise<void>,
): Promise<void> {
	try {
		const sealed = plans.get(plan);
		if (!sealed || sealed.main !== main || sealed.consumed) refuse();
		sealed.consumed = true;
		requireTransaction(main);
		await assertOwned();
		requireTransaction(main);
		const priorDigest = sealed.receipt?.dateColumnsDigest ?? plan.dateColumnsDigest;
		if (!present(main, marker) || hash(readReceipt(main, priorDigest)) !== hash(sealed.receipt))
			refuse();
		const version = () =>
			hash([
				main.pragma("main.schema_version", { simple: true }),
				main.pragma("temp.schema_version", { simple: true }),
			]);
		const schemaVersion = version();
		let changed = 0;
		for (const table of sealed.targets) {
			const readDate = canonicalDateReader();
			const fields = selectedFields(main, table, true),
				before = sealed.snapshots.get(table.name)!;
			if (before.changes) assertEffectsSafe(main, table);
			const digest = createHash("sha256");
			let rows = 0;
			const update = main.prepare(
				`UPDATE main.${quote(table.name)} SET ${fields.map((field) => `${quote(field)}=?`).join(",")} WHERE ${table.keys.map((key) => `${quote(key)} IS ?`).join(" AND ")}`,
			);
			const projection = [...table.keys, ...fields].map(quote).join(",");
			const keyProjection = table.keys.map(quote).join(",");
			const first = main.prepare(
				`SELECT ${projection} FROM main.${quote(table.name)} ORDER BY ${keyProjection} LIMIT 250`,
			);
			const more = main.prepare(
				`SELECT ${projection} FROM main.${quote(table.name)} WHERE (${keyProjection})>(${table.keys.map(() => "?").join(",")}) ORDER BY ${keyProjection} LIMIT 250`,
			);
			let page = first.all() as Record<string, unknown>[];
			while (page.length) {
				await assertOwned();
				requireTransaction(main);
				if (version() !== schemaVersion) refuse();
				for (const raw of page) {
					const row = raw as Record<string, unknown>,
						keys = rowKeys(row, table);
					digest.update(
						`${JSON.stringify([...table.keys, ...before.fields].map((field) => row[field]))}\n`,
					);
					rows++;
					const values = fields.map((field) =>
						readDate(row[field], table.dates.find((d) => d.name === field)!.nullable),
					);
					if (values.some((value, i) => value !== row[fields[i]!])) {
						if (sealed.receipt) refuse();
						if (update.run(...values, ...keys).changes !== 1) refuse();
						changed += values.filter((value, i) => value !== row[fields[i]!]).length;
					}
				}
				page = more.all(...rowKeys(page[page.length - 1]!, table)) as Record<string, unknown>[];
			}
			if (rows !== before.rows || digest.digest("hex") !== before.digest) refuse();
		}
		if (changed !== plan.normalizedValues) refuse();
		await assertOwned();
		requireTransaction(main);
		if (
			version() !== schemaVersion ||
			hash(readReceipt(main, priorDigest)) !== hash(sealed.receipt)
		)
			refuse();
		if (sealed.receipt && priorDigest !== plan.dateColumnsDigest) {
			const receipt = {
				...sealed.receipt,
				dateColumnsDigest: plan.dateColumnsDigest,
				completedAt: canonical(new Date().toISOString(), false)!,
			};
			if (
				main
					.prepare(
						`UPDATE main.${quote(marker)} SET dateColumnsDigest=@dateColumnsDigest,completedAt=@completedAt WHERE id=@id AND formatVersion=@formatVersion AND dateColumnsDigest=@predecessorDigest AND completedAt=@previousCompletedAt AND normalizedValues=@normalizedValues`,
					)
					.run({
						...receipt,
						predecessorDigest: priorDigest,
						previousCompletedAt: sealed.receipt.completedAt,
					}).changes !== 1 ||
				hash(readReceipt(main, plan.dateColumnsDigest)) !== hash(receipt)
			)
				refuse();
		} else if (!sealed.receipt) {
			const receipt = {
				id: 1,
				formatVersion: 1,
				dateColumnsDigest: plan.dateColumnsDigest,
				completedAt: canonical(new Date().toISOString(), false)!,
				normalizedValues: changed,
			};
			if (
				main
					.prepare(
						`INSERT INTO main.${quote(marker)}(id,formatVersion,dateColumnsDigest,completedAt,normalizedValues) VALUES(@id,@formatVersion,@dateColumnsDigest,@completedAt,@normalizedValues)`,
					)
					.run(receipt).changes !== 1 ||
				hash(readReceipt(main, plan.dateColumnsDigest)) !== hash(receipt)
			)
				refuse();
		}
	} catch (error) {
		if (error instanceof SqliteDateCompatibilityError) throw error;
		refuse();
	}
}
