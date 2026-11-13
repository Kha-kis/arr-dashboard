import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	planRuntimeSchema,
	type RuntimeSchemaCatalog,
	type RuntimeSchemaPlanningCatalog,
	type RuntimeSchemaRegistry,
	type RuntimeSchemaTable,
} from "./runtime-schema-catalog.js";

// BEGIN REVIEWED RUNTIME SCHEMA ASSET BINDINGS
const REVIEWED_RUNTIME_SCHEMA_ASSETS = {
	normalizedSchemaSha256: "37f65bf997572e24f82098f7956a2115d33d1e60a9a67dbd13f72892632f33bb",
	sqlite: {
		documentSha256: "795f78d2643c9d218c22ca1786be66f5def12f2de961ff0e2759bbf866f22a45",
		sqlSha256: "62aaf87ddab3e1d497a9da3283702d501e4781f9a3caa4d8af4cb07573b17b9e",
	},
	postgresql: {
		documentSha256: "2a312d2575f91af13c2cfc636f5fe6d85bdbd5ffc6efb55dad5eb376d4d18113",
		sqlSha256: "f0621360b026ef8d7a820359b069b062577fe5978d690bf75d0b5594442cf680",
	},
} as const;
// END REVIEWED RUNTIME SCHEMA ASSET BINDINGS

export type RuntimeSchemaAtomKind =
	| "enum"
	| "table"
	| "column"
	| "index"
	| "foreign-key"
	| "predecessor-index";
export type RuntimeSchemaAtom = Readonly<{
	id: string;
	kind: RuntimeSchemaAtomKind;
	tableName: string | null;
	objectName: string;
	sha256: string;
	sql: string;
}>;
export type RuntimeSchemaRegistryDocument = Readonly<{
	formatVersion: 1;
	schemaSourceSha256: string;
	applicationModelCount: number;
	registry: RuntimeSchemaRegistry;
	nativeEnums: readonly Readonly<{ name: string; values: readonly string[]; createAtom: string }>[];
	atoms: readonly RuntimeSchemaAtom[];
	sqlSha256: string;
}>;
export class RuntimeSchemaRegistryError extends Error {
	readonly category = "registry-unavailable";
	constructor() {
		super("Database schema registry is unavailable.");
		this.name = "RuntimeSchemaRegistryError";
	}
}

function unavailable(): never {
	throw new RuntimeSchemaRegistryError();
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/** Copy only inert JSON values; never evaluate accessors or serialization hooks. */
function copyJson(value: unknown, parents = new Set<object>()): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : unavailable();
	if (typeof value !== "object" || parents.has(value)) unavailable();
	const array = Array.isArray(value);
	const prototype = Object.getPrototypeOf(value);
	if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
		unavailable();
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (
		Reflect.ownKeys(value).some((key) => typeof key !== "string" || !("value" in descriptors[key]!))
	)
		unavailable();
	parents.add(value);
	try {
		if (array) {
			const result: unknown[] = [];
			if (Object.keys(descriptors).some((key) => key !== "length" && !/^(0|[1-9]\d*)$/.test(key)))
				unavailable();
			for (let index = 0; index < value.length; index++) {
				const descriptor = descriptors[String(index)];
				if (!descriptor) unavailable();
				result.push(copyJson(descriptor.value, parents));
			}
			return result;
		}
		return Object.fromEntries(
			Object.entries(descriptors).map(([key, descriptor]) => [
				key,
				copyJson(descriptor.value, parents),
			]),
		);
	} finally {
		parents.delete(value);
	}
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

function freeze<T>(value: T): Readonly<T> {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}

function keys(value: unknown, required: readonly string[], optional: readonly string[] = []): void {
	if (value === null || typeof value !== "object" || Array.isArray(value)) unavailable();
	if (
		required.some((key) => !Object.hasOwn(value, key)) ||
		Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
	)
		unavailable();
}

function hash(value: unknown): void {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) unavailable();
}

function name(value: unknown): asserts value is string {
	if (typeof value !== "string" || !value || value.includes("\0")) unavailable();
}

function array(value: unknown): void {
	if (!Array.isArray(value)) unavailable();
}

type Token = { kind: "word" | "identifier" | "literal" | "punctuation"; value: string };
function sqlTokens(sql: string): Token[] {
	const tokens: Token[] = [];
	for (let position = 0; position < sql.length; ) {
		const char = sql[position]!;
		if (/\s/.test(char)) {
			position++;
			continue;
		}
		if (
			sql.startsWith("--", position) ||
			sql.startsWith("/*", position) ||
			char === "$" ||
			char === "\0"
		)
			unavailable();
		if (char === "'" || char === '"') {
			let value = "";
			let closed = false;
			for (position++; position < sql.length; position++) {
				if (sql[position] !== char) {
					value += sql[position];
					continue;
				}
				if (sql[position + 1] === char) {
					value += char;
					position++;
					continue;
				}
				position++;
				closed = true;
				break;
			}
			if (!closed) unavailable();
			tokens.push({ kind: char === "'" ? "literal" : "identifier", value });
		} else if (/[a-z_]/i.test(char)) {
			const start = position++;
			while (position < sql.length && /[a-z0-9_]/i.test(sql[position]!)) position++;
			tokens.push({ kind: "word", value: sql.slice(start, position).toUpperCase() });
		} else tokens.push({ kind: "punctuation", value: sql[position++]! });
	}
	if (
		tokens.at(-1)?.value !== ";" ||
		tokens.filter((token) => token.kind === "punctuation" && token.value === ";").length !== 1
	)
		unavailable();
	return tokens;
}

function statementKind(atom: RuntimeSchemaAtom, provider: "sqlite" | "postgresql"): void {
	const tokens = sqlTokens(atom.sql);
	const word = (index: number, value: string) =>
		tokens[index]?.kind === "word" && tokens[index]?.value === value;
	const identifier = (index: number, value: string | null) =>
		value !== null && tokens[index]?.kind === "identifier" && tokens[index]?.value === value;
	if (
		tokens.some(
			(token) =>
				token.kind === "word" &&
				[
					"PRAGMA",
					"ATTACH",
					"DETACH",
					"SELECT",
					"BEGIN",
					"COMMIT",
					"ROLLBACK",
					"TRUNCATE",
				].includes(token.value),
		)
	)
		unavailable();
	let valid = false;
	switch (atom.kind) {
		case "table":
			valid =
				word(0, "CREATE") &&
				word(1, "TABLE") &&
				identifier(2, atom.objectName) &&
				atom.tableName === atom.objectName &&
				tokens[3]?.value === "(";
			break;
		case "column":
			valid =
				word(0, "ALTER") &&
				word(1, "TABLE") &&
				identifier(2, atom.tableName) &&
				word(3, "ADD") &&
				word(4, "COLUMN") &&
				identifier(5, atom.objectName);
			break;
		case "index": {
			const shift = word(1, "UNIQUE") ? 1 : 0;
			valid =
				word(0, "CREATE") &&
				word(1 + shift, "INDEX") &&
				identifier(2 + shift, atom.objectName) &&
				word(3 + shift, "ON") &&
				identifier(4 + shift, atom.tableName);
			break;
		}
		case "foreign-key":
			valid =
				provider === "postgresql" &&
				word(0, "ALTER") &&
				word(1, "TABLE") &&
				identifier(2, atom.tableName) &&
				word(3, "ADD") &&
				word(4, "CONSTRAINT") &&
				tokens[5]?.kind === "identifier" &&
				word(6, "FOREIGN") &&
				word(7, "KEY");
			break;
		case "enum":
			valid =
				provider === "postgresql" &&
				atom.tableName === null &&
				word(0, "CREATE") &&
				word(1, "TYPE") &&
				identifier(2, atom.objectName) &&
				word(3, "AS") &&
				word(4, "ENUM");
			break;
		case "predecessor-index":
			valid =
				word(0, "DROP") &&
				word(1, "INDEX") &&
				identifier(2, atom.objectName) &&
				tokens.length === 4;
			break;
	}
	if (!valid) unavailable();
}

export function serializeRuntimeSchemaAtoms(atoms: readonly RuntimeSchemaAtom[]): string {
	return atoms.map((atom) => `-- arr-schema-atom ${atom.id}\n${atom.sql}\n`).join("\n");
}

export function runtimeSchemaTargetDigest(
	registry: Pick<RuntimeSchemaRegistry, "provider" | "version" | "tables">,
	nativeEnums: RuntimeSchemaRegistryDocument["nativeEnums"],
): string {
	return digest(
		canonical({
			provider: registry.provider,
			version: registry.version,
			tables: registry.tables.map((table) => table.target),
			nativeEnums,
		}),
	);
}

function receipt(table: RuntimeSchemaTable, provider: "sqlite" | "postgresql"): void {
	const expected = [
		"id",
		"protocolVersion",
		"registryVersion",
		"provider",
		"targetDigest",
		"planDigest",
		"completedAt",
	];
	if (
		table.columns.length !== expected.length ||
		JSON.stringify(table.columns.map((column) => column.name)) !== JSON.stringify(expected) ||
		JSON.stringify(table.primaryKey) !== '["id"]' ||
		table.indexes.length ||
		table.foreignKeys.length
	)
		unavailable();
	for (const column of table.columns) {
		const type = ["protocolVersion", "registryVersion"].includes(column.name)
			? "INTEGER"
			: column.name === "completedAt"
				? provider === "sqlite"
					? "DATETIME"
					: "TIMESTAMP(3) WITHOUT TIME ZONE"
				: "TEXT";
		if (
			column.nullable ||
			column.type !== type ||
			column.defaultValue !== (column.name === "protocolVersion" ? "1" : null)
		)
			unavailable();
	}
}

function dateFormatReceipt(table: RuntimeSchemaTable): void {
	const fields = [
		["id", "INTEGER;ROWID"],
		["formatVersion", "INTEGER"],
		["dateColumnsDigest", "TEXT"],
		["completedAt", "TEXT"],
		["normalizedValues", "INTEGER"],
	];
	if (
		table.columns.length !== fields.length ||
		table.columns.some(
			(column, index) =>
				column.name !== fields[index]![0] ||
				column.type !== fields[index]![1] ||
				column.nullable ||
				column.defaultValue !== null,
		) ||
		JSON.stringify(table.primaryKey) !== '["id"]' ||
		table.indexes.length ||
		table.foreignKeys.length
	)
		unavailable();
}

export function verifyRuntimeSchemaRegistryDocument(
	document: unknown,
	expectedSchemaSourceSha256: string,
): Readonly<RuntimeSchemaRegistry> {
	try {
		const value = copyJson(document) as RuntimeSchemaRegistryDocument;
		keys(value, [
			"formatVersion",
			"schemaSourceSha256",
			"applicationModelCount",
			"registry",
			"nativeEnums",
			"atoms",
			"sqlSha256",
		]);
		hash(expectedSchemaSourceSha256);
		hash(value.schemaSourceSha256);
		hash(value.sqlSha256);
		if (
			value.formatVersion !== 1 ||
			value.schemaSourceSha256 !== expectedSchemaSourceSha256 ||
			!Number.isSafeInteger(value.applicationModelCount) ||
			value.applicationModelCount < 1
		)
			unavailable();
		keys(
			value.registry,
			["provider", "version", "targetDigest", "tables", "orderedAtomIds"],
			["predecessorIndexes"],
		);
		array(value.registry.tables);
		array(value.nativeEnums);
		array(value.atoms);
		if (
			value.registry.tables.length !==
			value.applicationModelCount + (value.registry.provider === "sqlite" ? 2 : 1)
		)
			unavailable();
		for (const definition of value.registry.tables) {
			keys(definition, [
				"target",
				"createAtom",
				"addColumnAtoms",
				"addIndexAtoms",
				"addForeignKeyAtoms",
			]);
			keys(definition.target, [
				"name",
				"columns",
				"primaryKey",
				"indexes",
				"foreignKeys",
				"rowCount",
			]);
			if (definition.target.rowCount !== 0) unavailable();
			for (const column of definition.target.columns)
				keys(column, ["name", "type", "nullable", "defaultValue"]);
			for (const index of definition.target.indexes)
				keys(index, ["name", "unique", "columns", "predicate", "valid"]);
			for (const foreignKey of definition.target.foreignKeys)
				keys(foreignKey, ["columns", "targetTable", "targetColumns", "onDelete", "onUpdate"]);
		}
		planRuntimeSchema(
			{
				provider: value.registry.provider,
				tables: value.registry.tables.map((definition) => definition.target),
			},
			value.registry,
		);
		const protocol = value.registry.tables.filter(
			(definition) => definition.target.name === "ArrSchemaMigrationReceipt",
		);
		if (protocol.length !== 1) unavailable();
		receipt(protocol[0]!.target, value.registry.provider);
		const dateProtocol = value.registry.tables.filter(
			(definition) => definition.target.name === "ArrRuntimeDataFormatReceipt",
		);
		if (dateProtocol.length !== (value.registry.provider === "sqlite" ? 1 : 0)) unavailable();
		if (dateProtocol.length) dateFormatReceipt(dateProtocol[0]!.target);
		if (
			runtimeSchemaTargetDigest(value.registry, value.nativeEnums) !==
				value.registry.targetDigest ||
			value.sqlSha256 !== digest(serializeRuntimeSchemaAtoms(value.atoms)) ||
			JSON.stringify(value.atoms.map((atom) => atom.id)) !==
				JSON.stringify(value.registry.orderedAtomIds)
		)
			unavailable();
		const references = new Set<string>();
		const mapped = (
			id: string,
			kind: RuntimeSchemaAtomKind,
			tableName: string | null,
			objectName: string,
		) => {
			const atom = value.atoms.find((candidate) => candidate.id === id);
			if (
				!atom ||
				atom.kind !== kind ||
				atom.tableName !== tableName ||
				atom.objectName !== objectName
			)
				unavailable();
			references.add(id);
		};
		const ranks: Record<RuntimeSchemaAtomKind, number> = {
			enum: 0,
			table: 1,
			column: 2,
			index: 3,
			"foreign-key": 4,
			"predecessor-index": 5,
		};
		let previous = -1;
		for (const atom of value.atoms) {
			keys(atom, ["id", "kind", "tableName", "objectName", "sha256", "sql"]);
			name(atom.objectName);
			if (atom.tableName !== null) name(atom.tableName);
			hash(atom.sha256);
			if (
				!Object.hasOwn(ranks, atom.kind) ||
				typeof atom.sql !== "string" ||
				atom.sql.length === 0 ||
				digest(atom.sql) !== atom.sha256 ||
				ranks[atom.kind] < previous
			)
				unavailable();
			previous = ranks[atom.kind];
			statementKind(atom, value.registry.provider);
		}
		const enums = new Set<string>();
		for (const definition of value.nativeEnums) {
			keys(definition, ["name", "values", "createAtom"]);
			name(definition.name);
			if (
				value.registry.provider !== "postgresql" ||
				enums.has(definition.name) ||
				!Array.isArray(definition.values) ||
				definition.values.length === 0 ||
				new Set(definition.values).size !== definition.values.length
			)
				unavailable();
			definition.values.forEach(name);
			enums.add(definition.name);
			mapped(definition.createAtom, "enum", null, definition.name);
			const tokens = sqlTokens(value.atoms.find((atom) => atom.id === definition.createAtom)!.sql);
			const labels = tokens.filter((token) => token.kind === "literal").map((token) => token.value);
			if (JSON.stringify(labels) !== JSON.stringify(definition.values)) unavailable();
		}
		for (const definition of value.registry.tables) {
			const table = definition.target;
			mapped(definition.createAtom, "table", table.name, table.name);
			for (const [column, id] of Object.entries(definition.addColumnAtoms))
				mapped(id, "column", table.name, column);
			for (const [index, id] of Object.entries(definition.addIndexAtoms)) {
				mapped(id, "index", table.name, index);
				const target = table.indexes.find((candidate) => candidate.name === index)!;
				const tokens = sqlTokens(value.atoms.find((atom) => atom.id === id)!.sql);
				const unique = tokens[1]?.kind === "word" && tokens[1]?.value === "UNIQUE";
				const start = unique ? 6 : 5;
				if (
					target.unique !== unique ||
					target.predicate !== null ||
					tokens[start]?.value !== "(" ||
					tokens[start]?.kind !== "punctuation"
				)
					unavailable();
				let position = start + 1;
				for (const [ordinal, column] of target.columns.entries()) {
					if (
						ordinal > 0 &&
						(tokens[position]?.value !== "," || tokens[position++]?.kind !== "punctuation")
					)
						unavailable();
					if (tokens[position]?.kind !== "identifier" || tokens[position++]?.value !== column)
						unavailable();
				}
				if (
					tokens[position]?.value !== ")" ||
					tokens[position]?.kind !== "punctuation" ||
					position !== tokens.length - 2
				)
					unavailable();
			}
			for (const [foreignKey, id] of Object.entries(definition.addForeignKeyAtoms))
				mapped(id, "foreign-key", table.name, foreignKey);
			for (const column of table.columns) {
				if (!column.type.startsWith("ENUM:")) continue;
				const actual = JSON.parse(column.type.slice(5)) as [string, string[]];
				const declared = value.nativeEnums.find((definition) => definition.name === actual[0]);
				if (
					!declared ||
					JSON.stringify(actual) !== JSON.stringify([declared.name, declared.values])
				)
					unavailable();
			}
		}
		for (const rule of value.registry.predecessorIndexes ?? []) {
			keys(rule, ["tableName", "expected", "replacementIndexName", "dropAtom"]);
			mapped(rule.dropAtom, "predecessor-index", rule.tableName, rule.expected.name);
		}
		if (references.size !== value.atoms.length) unavailable();
		return freeze(value.registry);
	} catch {
		return unavailable();
	}
}

export function normalizeRuntimeSchemaSource(source: string): string {
	try {
		if (typeof source !== "string" || source.includes("\0")) unavailable();
		const blocks = [...source.matchAll(/\bdatasource\s+\w+\s*\{[^}]*\}/g)];
		if (blocks.length !== 1) unavailable();
		const block = blocks[0]!;
		const providers = [...block[0].matchAll(/\bprovider\s*=\s*"([^"]+)"/g)];
		if (providers.length !== 1 || !["sqlite", "postgresql"].includes(providers[0]![1]!))
			unavailable();
		const normalized = block[0].replace(
			/\bprovider(\s*=\s*)"(?:sqlite|postgresql)"/,
			'provider$1"sqlite"',
		);
		return source.slice(0, block.index) + normalized + source.slice(block.index + block[0].length);
	} catch {
		return unavailable();
	}
}

export function loadRuntimeSchemaRegistry(
	provider: "sqlite" | "postgresql",
): Readonly<RuntimeSchemaRegistry> {
	try {
		if (provider !== "sqlite" && provider !== "postgresql") unavailable();
		const directory = dirname(fileURLToPath(import.meta.url));
		let packageRoot: string;
		if (basename(directory) === "dist") packageRoot = dirname(directory);
		else if (
			basename(directory) === "backup" &&
			basename(dirname(directory)) === "lib" &&
			basename(dirname(dirname(directory))) === "src"
		)
			packageRoot = dirname(dirname(dirname(directory)));
		else return unavailable();
		const source = readPackagedText(join(packageRoot, "prisma", "schema.prisma"));
		const sourceHash = digest(normalizeRuntimeSchemaSource(source));
		if (sourceHash !== REVIEWED_RUNTIME_SCHEMA_ASSETS.normalizedSchemaSha256) unavailable();
		const bindings = REVIEWED_RUNTIME_SCHEMA_ASSETS[provider];
		const assetDirectory = join(packageRoot, "prisma", "runtime-schema");
		const documentText = readPackagedText(join(assetDirectory, `registry-${provider}-v1.json`));
		const sql = readPackagedText(join(assetDirectory, `${provider}-v1.sql`));
		if (digest(documentText) !== bindings.documentSha256 || digest(sql) !== bindings.sqlSha256)
			unavailable();
		const document = JSON.parse(documentText) as RuntimeSchemaRegistryDocument;
		const registry = verifyRuntimeSchemaRegistryDocument(document, sourceHash);
		if (
			registry.provider !== provider ||
			document.sqlSha256 !== bindings.sqlSha256 ||
			serializeRuntimeSchemaAtoms(document.atoms) !== sql
		)
			unavailable();
		loadedRegistries.set(registry, freeze(document));
		return registry;
	} catch {
		return unavailable();
	}
}

function readPackagedText(path: string): string {
	const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = fstatSync(descriptor);
		if (!stat.isFile() || stat.size === 0 || stat.size > 8 * 1024 * 1024) unavailable();
		return readFileSync(descriptor, "utf8");
	} finally {
		closeSync(descriptor);
	}
}

// Purely verified metadata is deliberately not an executable package capability.
const loadedRegistries = new WeakMap<
	Readonly<RuntimeSchemaRegistry>,
	RuntimeSchemaRegistryDocument
>();

/** The sole fixed replacement for the reviewed SQLite OIDC predecessor. */
export function prepareSqliteOidcPredecessorReplacement(
	registry: Readonly<RuntimeSchemaRegistry>,
): Readonly<{
	tableName: string;
	execute: (apply: (sql: string) => void | Promise<void>) => Promise<void>;
}> {
	const document = loadedRegistries.get(registry);
	if (!document || registry.provider !== "sqlite") unavailable();
	const definition = registry.tables.find(({ target }) => target.name === "oidc_providers");
	const atom = document.atoms.find((candidate) => candidate.id === definition?.createAtom);
	const header = 'CREATE TABLE "oidc_providers"';
	if (
		atom?.kind !== "table" ||
		atom.tableName !== "oidc_providers" ||
		atom.objectName !== "oidc_providers" ||
		!atom.sql.startsWith(`${header} (`)
	)
		unavailable();
	const tableName = "ArrOidcProviderSchemaMigration";
	const sql = `CREATE TABLE "${tableName}"${atom.sql.slice(header.length)}`;
	let consumed = false;
	return Object.freeze({
		tableName,
		async execute(apply: (sql: string) => void | Promise<void>): Promise<void> {
			if (consumed || typeof apply !== "function") unavailable();
			consumed = true;
			try {
				await apply(sql);
			} catch {
				return unavailable();
			}
		},
	});
}

/** Read-only native projection targets; this never exposes executable atom text. */
export function readRuntimeSchemaRegistryTargets(
	registry: Readonly<RuntimeSchemaRegistry>,
): Readonly<{
	tables: readonly string[];
	indexes: readonly string[];
	enums: readonly Readonly<{ name: string; values: readonly string[] }>[];
}> {
	const document = loadedRegistries.get(registry);
	if (!document) unavailable();
	return freeze({
		tables: registry.tables.map((definition) => definition.target.name),
		indexes: registry.tables.flatMap((definition) =>
			definition.target.indexes.map((index) => index.name),
		),
		enums: document.nativeEnums.map(({ name, values }) => ({ name, values: [...values] })),
	});
}

export type RuntimeSchemaExecution = Readonly<{
	provider: "sqlite" | "postgresql";
	version: 1;
	targetDigest: string;
	planDigest: string;
	result: "ready" | "upgrade";
	preservedExtraObjects: number;
	statementCount: number;
	execute: (apply: (sql: string) => void | Promise<void>) => Promise<void>;
}>;

export function prepareRuntimeSchemaExecution(
	registry: Readonly<RuntimeSchemaRegistry>,
	catalog: RuntimeSchemaCatalog | RuntimeSchemaPlanningCatalog,
	missingEnums: readonly string[] = [],
): RuntimeSchemaExecution {
	const document = loadedRegistries.get(registry);
	if (!document) unavailable();
	const missing = copyJson(missingEnums) as readonly string[];
	array(missing);
	if (
		new Set(missing).size !== missing.length ||
		(registry.provider === "sqlite" && missing.length)
	)
		unavailable();
	const selectedEnums = new Set<string>();
	for (const enumName of missing) {
		name(enumName);
		const definition = document.nativeEnums.find((candidate) => candidate.name === enumName);
		if (!definition) unavailable();
		selectedEnums.add(definition.createAtom);
	}
	// The pure planner validates the complete native projection before any SQL is resolved.
	const plan = planRuntimeSchema(catalog, registry);
	for (const table of catalog.tables) {
		for (const column of table.columns) {
			if (!column.type.startsWith("ENUM:")) continue;
			try {
				const [enumName] = JSON.parse(column.type.slice(5)) as [string];
				if (missing.includes(enumName)) unavailable();
			} catch {
				return unavailable();
			}
		}
	}
	const selected = new Set([...selectedEnums, ...plan.atomIds]);
	const atoms = document.atoms.filter((atom) => selected.has(atom.id));
	if (atoms.length !== selected.size) unavailable();
	const planDigest = digest(
		canonical({
			provider: plan.provider,
			version: plan.version,
			targetDigest: plan.targetDigest,
			atomIds: atoms.map((atom) => atom.id),
		}),
	);
	let consumed = false;
	return Object.freeze({
		provider: plan.provider,
		version: plan.version,
		targetDigest: plan.targetDigest,
		planDigest,
		result: atoms.length ? "upgrade" : "ready",
		preservedExtraObjects: plan.preservedExtraObjects,
		statementCount: atoms.length,
		async execute(apply: (sql: string) => void | Promise<void>): Promise<void> {
			if (consumed || typeof apply !== "function") unavailable();
			consumed = true;
			try {
				for (const atom of atoms) await apply(atom.sql);
			} catch {
				return unavailable();
			}
		},
	});
}
