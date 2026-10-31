import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Client } from "pg";
import type {
	RuntimeSchemaCatalog,
	RuntimeSchemaForeignKey,
	RuntimeSchemaRegistry,
} from "../src/lib/backup/runtime-schema-catalog.js";
import { readPostgresRuntimeSchemaCatalog } from "../src/lib/backup/runtime-schema-postgres.js";
import {
	normalizeRuntimeSchemaSource,
	type RuntimeSchemaAtom,
	type RuntimeSchemaAtomKind,
	type RuntimeSchemaRegistryDocument,
	RuntimeSchemaRegistryError,
	runtimeSchemaTargetDigest,
	serializeRuntimeSchemaAtoms,
	verifyRuntimeSchemaRegistryDocument,
} from "../src/lib/backup/runtime-schema-registry.js";
import { readSqliteRuntimeSchemaCatalog } from "../src/lib/backup/runtime-schema-sqlite.js";
import { SQLITE_DATE_FORMAT_RECEIPT_SQL } from "../src/lib/backup/runtime-sqlite-datetime.js";

export type RuntimeSchemaAuthorInput = Readonly<{
	schemaSource: string;
	applicationSql: string;
	catalog: RuntimeSchemaCatalog;
}>;

export function authorRuntimeSchemaRegistry(
	input: RuntimeSchemaAuthorInput,
): RuntimeSchemaRegistryDocument {
	try {
		const schemaSource = normalizeRuntimeSchemaSource(input.schemaSource);
		const models = [...schemaSource.matchAll(/^model\s+(\w+)\s*\{/gm)];
		const nativeNames = ["ArrSchemaMigrationReceipt", "ArrRuntimeDataFormatReceipt"];
		if (!models.length || models.some((model) => nativeNames.includes(model[1]!))) fail();
		const parsed = parseAuthoringSql(input.applicationSql);
		if (
			parsed.tables.length !== models.length ||
			parsed.tables.some((table) => nativeNames.includes(table.name))
		)
			fail();
		const catalog = JSON.parse(JSON.stringify(input.catalog)) as RuntimeSchemaCatalog;
		const nativeTables = catalog.provider === "sqlite" ? nativeNames : nativeNames.slice(0, 1);
		if (catalog.provider === "sqlite" && parsed.publicSchemaPrologue) fail();
		if (
			catalog.tables.length !== models.length + nativeTables.length ||
			catalog.tables.some((table) => table.rowCount !== 0)
		)
			fail();
		const tableNames = new Set([...parsed.tables.map((table) => table.name), ...nativeTables]);
		if (
			tableNames.size !== models.length + nativeTables.length ||
			catalog.tables.some((table) => !tableNames.has(table.name))
		)
			fail();
		const atoms: RuntimeSchemaAtom[] = [];
		const add = (
			kind: RuntimeSchemaAtomKind,
			tableName: string | null,
			objectName: string,
			sql: string,
		) => {
			const id = `${kind}:${sha(JSON.stringify([tableName, objectName]))}`;
			atoms.push({ id, kind, tableName, objectName, sql, sha256: sha(sql) });
			return id;
		};
		const nativeEnums = parsed.enums.map((definition) => ({
			name: definition.name,
			values: definition.values,
			createAtom: add("enum", null, definition.name, definition.sql),
		}));
		if (catalog.provider === "sqlite" && nativeEnums.length) fail();
		const tables = catalog.tables.map((target) => {
			const source =
				target.name === "ArrSchemaMigrationReceipt"
					? parseAuthoringSql(nativeReceiptSql(catalog.provider)).tables[0]!
					: target.name === "ArrRuntimeDataFormatReceipt"
						? parseAuthoringSql(SQLITE_DATE_FORMAT_RECEIPT_SQL).tables[0]!
						: parsed.tables.find((table) => table.name === target.name);
			if (
				!source ||
				source.columns.size !== target.columns.length ||
				target.columns.some((column) => !source.columns.has(column.name))
			)
				fail();
			return {
				target,
				createAtom: add("table", target.name, target.name, source.sql),
				addColumnAtoms: {} as Record<string, string>,
				addIndexAtoms: {} as Record<string, string>,
				addForeignKeyAtoms: {} as Record<string, string>,
			};
		});
		for (const definition of tables) {
			if (nativeTables.includes(definition.target.name)) continue;
			const target = definition.target;
			const source = parsed.tables.find((table) => table.name === target.name)!;
			for (const column of target.columns) {
				if (target.primaryKey.includes(column.name)) continue;
				const foreignKeys = target.foreignKeys.filter((key) => key.columns.includes(column.name));
				let sql = `ALTER TABLE ${identifier(target.name)} ADD COLUMN ${source.columns.get(column.name)!}`;
				if (catalog.provider === "sqlite") {
					if (
						foreignKeys.some((key) => key.columns.length !== 1) ||
						foreignKeys.length > 1 ||
						!constantDefault(column.defaultValue)
					)
						continue;
					if (foreignKeys.length) {
						if (column.defaultValue !== null && column.defaultValue.toUpperCase() !== "NULL")
							continue;
						const key = foreignKeys[0]!;
						sql += ` REFERENCES ${identifier(key.targetTable)}(${key.targetColumns.map(identifier).join(",")}) ON DELETE ${key.onDelete} ON UPDATE ${key.onUpdate}`;
					}
				}
				definition.addColumnAtoms[column.name] = add("column", target.name, column.name, `${sql};`);
			}
		}
		for (const definition of tables)
			for (const index of definition.target.indexes) {
				const source = parsed.indexes.find(
					(candidate) =>
						candidate.name === index.name && candidate.table === definition.target.name,
				);
				if (!source) fail();
				definition.addIndexAtoms[index.name] = add(
					"index",
					definition.target.name,
					index.name,
					source.sql,
				);
			}
		if (catalog.provider === "postgresql")
			for (const definition of tables)
				for (const key of definition.target.foreignKeys) {
					const objectName = foreignKeyKey(key);
					const source = parsed.foreignKeys.find(
						(candidate) =>
							candidate.table === definition.target.name &&
							foreignKeyKey(candidate.key) === objectName,
					);
					if (!source) fail();
					definition.addForeignKeyAtoms[objectName] = add(
						"foreign-key",
						definition.target.name,
						objectName,
						source.sql,
					);
				}
		const predecessorIndexes: NonNullable<RuntimeSchemaRegistry["predecessorIndexes"]>[number][] =
			[];
		for (const [tableName, listColumn] of [
			["tmdb_list_cache", "listId"],
			["trakt_list_cache", "listSlug"],
		] as const) {
			const definition = tables.find((table) => table.target.name === tableName);
			if (!definition) continue;
			const oldName = `${tableName}_userId_${listColumn}_tmdbId_key`;
			const newName = `${tableName}_userId_${listColumn}_mediaType_tmdbId_key`;
			const replacement = definition.target.indexes.find((index) => index.name === newName);
			if (
				!replacement?.unique ||
				replacement.predicate !== null ||
				JSON.stringify(replacement.columns) !==
					JSON.stringify(["userId", listColumn, "mediaType", "tmdbId"])
			)
				fail();
			predecessorIndexes.push({
				tableName,
				expected: {
					name: oldName,
					unique: true,
					columns: ["userId", listColumn, "tmdbId"],
					predicate: null,
					valid: true,
				},
				replacementIndexName: newName,
				dropAtom: add(
					"predecessor-index",
					tableName,
					oldName,
					`DROP INDEX ${identifier(oldName)};`,
				),
			});
		}
		const registry: RuntimeSchemaRegistry = {
			provider: catalog.provider,
			version: 1,
			targetDigest: runtimeSchemaTargetDigest(
				{ provider: catalog.provider, version: 1, tables },
				nativeEnums,
			),
			tables,
			orderedAtomIds: atoms.map((atom) => atom.id),
			predecessorIndexes,
		};
		const document: RuntimeSchemaRegistryDocument = {
			formatVersion: 1,
			schemaSourceSha256: sha(schemaSource),
			applicationModelCount: models.length,
			registry,
			nativeEnums,
			atoms,
			sqlSha256: sha(serializeRuntimeSchemaAtoms(atoms)),
		};
		return {
			...document,
			registry: verifyRuntimeSchemaRegistryDocument(document, document.schemaSourceSha256),
		};
	} catch {
		return fail();
	}
}

const quotedIdentifier = '"(?:[^"\\0]|"")+"';
const sqlIdentifier = new RegExp(`^(${quotedIdentifier})\\s+`);
type ParsedSql = {
	publicSchemaPrologue: boolean;
	tables: { name: string; sql: string; columns: Map<string, string> }[];
	indexes: { name: string; table: string; sql: string }[];
	enums: { name: string; values: string[]; sql: string }[];
	foreignKeys: { table: string; key: RuntimeSchemaForeignKey; sql: string }[];
};
function fail(): never {
	throw new RuntimeSchemaRegistryError();
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function identifier(value: string): string {
	if (!value || value.includes("\0")) fail();
	return `"${value.replaceAll('"', '""')}"`;
}
function unquote(value: string): string {
	return value.slice(1, -1).replaceAll('""', '"');
}
function foreignKeyKey(key: RuntimeSchemaForeignKey): string {
	return JSON.stringify([
		key.columns,
		key.targetTable,
		key.targetColumns,
		key.onDelete,
		key.onUpdate,
	]);
}
function constantDefault(value: string | null): boolean {
	return (
		value === null || /^(NULL|TRUE|FALSE|[+-]?(?:\d+(?:\.\d*)?|\.\d+)|'(?:[^']|'')*')$/i.test(value)
	);
}

function splitSql(input: string, delimiter: ";" | ",", comments = false): string[] {
	const parts: string[] = [];
	let current = "",
		quote = "",
		depth = 0;
	for (let index = 0; index < input.length; index++) {
		const character = input[index]!;
		if (character === "\0" || (character === "$" && !quote)) fail();
		if (quote) {
			current += character;
			if (character === quote) {
				if (input[index + 1] === quote) current += input[++index];
				else quote = "";
			}
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			current += character;
			continue;
		}
		if (input.startsWith("--", index)) {
			if (!comments) fail();
			while (index < input.length && input[index] !== "\n") index++;
			current += "\n";
			continue;
		}
		if (input.startsWith("/*", index)) fail();
		if (character === "(") depth++;
		else if (character === ")" && --depth < 0) fail();
		if (character === delimiter && depth === 0) {
			if (!current.trim()) fail();
			parts.push(current.trim());
			current = "";
		} else current += character;
	}
	if (quote || depth) fail();
	if (current.trim()) {
		if (delimiter === ";") fail();
		parts.push(current.trim());
	}
	return parts;
}

function parseAuthoringSql(sql: string): ParsedSql {
	const parsed: ParsedSql = {
		publicSchemaPrologue: false,
		tables: [],
		indexes: [],
		enums: [],
		foreignKeys: [],
	};
	for (const statement of splitSql(sql, ";", true)) {
		if (
			statement === 'CREATE SCHEMA IF NOT EXISTS "public"' &&
			!parsed.publicSchemaPrologue &&
			!parsed.tables.length &&
			!parsed.enums.length &&
			!parsed.indexes.length &&
			!parsed.foreignKeys.length
		) {
			parsed.publicSchemaPrologue = true;
			continue;
		}
		const table = statement.match(
			new RegExp(`^CREATE TABLE (${quotedIdentifier})\\s*\\(([\\s\\S]*)\\)$`),
		);
		if (table) {
			const columns = new Map<string, string>();
			for (const definition of splitSql(table[2]!, ",")) {
				const column = definition.match(sqlIdentifier);
				if (column) {
					const name = unquote(column[1]!);
					if (columns.has(name)) fail();
					columns.set(name, definition);
				} else if (
					!/^(?:CONSTRAINT\s+"(?:[^"]|"")+"\s+)?(PRIMARY KEY|FOREIGN KEY)\s*\(/.test(definition)
				)
					fail();
			}
			parsed.tables.push({ name: unquote(table[1]!), sql: `${statement};`, columns });
			continue;
		}
		const index = statement.match(
			new RegExp(
				`^CREATE (?:UNIQUE )?INDEX (${quotedIdentifier}) ON (${quotedIdentifier})\\s*\\([\\s\\S]+\\)$`,
			),
		);
		if (index) {
			parsed.indexes.push({
				name: unquote(index[1]!),
				table: unquote(index[2]!),
				sql: `${statement};`,
			});
			continue;
		}
		const enumeration = statement.match(
			new RegExp(`^CREATE TYPE (${quotedIdentifier}) AS ENUM \\(([^]*)\\)$`),
		);
		if (enumeration) {
			const values = splitSql(enumeration[2]!, ",").map((value) => {
				if (!/^'(?:[^']|'')*'$/.test(value)) fail();
				return value.slice(1, -1).replaceAll("''", "'");
			});
			parsed.enums.push({ name: unquote(enumeration[1]!), values, sql: `${statement};` });
			continue;
		}
		const foreignKey = statement.match(
			new RegExp(
				`^ALTER TABLE (${quotedIdentifier}) ADD CONSTRAINT ${quotedIdentifier} FOREIGN KEY \\(([^]*)\\) REFERENCES (${quotedIdentifier})\\(([^]*)\\) ON DELETE (NO ACTION|RESTRICT|CASCADE|SET NULL|SET DEFAULT) ON UPDATE (NO ACTION|RESTRICT|CASCADE|SET NULL|SET DEFAULT)$`,
			),
		);
		if (foreignKey) {
			const names = (value: string) =>
				splitSql(value, ",").map((name) => {
					if (!new RegExp(`^${quotedIdentifier}$`).test(name)) fail();
					return unquote(name);
				});
			parsed.foreignKeys.push({
				table: unquote(foreignKey[1]!),
				key: {
					columns: names(foreignKey[2]!),
					targetTable: unquote(foreignKey[3]!),
					targetColumns: names(foreignKey[4]!),
					onDelete: foreignKey[5]!,
					onUpdate: foreignKey[6]!,
				},
				sql: `${statement};`,
			});
			continue;
		}
		fail();
	}
	if (
		new Set(parsed.tables.map((table) => table.name)).size !== parsed.tables.length ||
		new Set(parsed.indexes.map((index) => index.name)).size !== parsed.indexes.length ||
		new Set(parsed.enums.map((enumeration) => enumeration.name)).size !== parsed.enums.length
	)
		fail();
	return parsed;
}

export function nativeReceiptSql(provider: "sqlite" | "postgresql"): string {
	if (provider !== "sqlite" && provider !== "postgresql") fail();
	return `CREATE TABLE "ArrSchemaMigrationReceipt"("id" TEXT NOT NULL PRIMARY KEY,"protocolVersion" INTEGER NOT NULL DEFAULT 1,"registryVersion" INTEGER NOT NULL,"provider" TEXT NOT NULL,"targetDigest" TEXT NOT NULL,"planDigest" TEXT NOT NULL,"completedAt" ${provider === "sqlite" ? "DATETIME" : "TIMESTAMP(3)"} NOT NULL);`;
}

const authoringImage = "sha256:de3a4eab8fdfa507ea92aac488b916b08089e515db49b055fe71dfa271ba3a28";
const temporaryPrefix = join(tmpdir(), "arr-registry-author-");
const childEnvironment = () => ({
	PATH: process.env.PATH,
	LANG: "C.UTF-8",
	PRISMA_HIDE_UPDATE_MESSAGE: "1",
	CHECKPOINT_DISABLE: "1",
});

function command(file: string, args: readonly string[], cwd: string, input?: string): string {
	return execFileSync(file, [...args], {
		cwd,
		env: childEnvironment(),
		input,
		encoding: "utf8",
		timeout: 30000,
		maxBuffer: 8 * 1024 * 1024,
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function sqliteTarget(schemaSource: string, sql: string): RuntimeSchemaRegistryDocument {
	const database = new Database(":memory:");
	try {
		database.pragma("foreign_keys=ON");
		database.exec(sql);
		database.exec(nativeReceiptSql("sqlite"));
		database.exec(SQLITE_DATE_FORMAT_RECEIPT_SQL);
		database.exec("BEGIN");
		const document = authorRuntimeSchemaRegistry({
			schemaSource,
			applicationSql: sql,
			catalog: readSqliteRuntimeSchemaCatalog(database, []),
		});
		const failures = database.pragma("foreign_key_check");
		if (!Array.isArray(failures) || failures.length) fail();
		return document;
	} finally {
		database.close();
	}
}

async function postgresTarget(
	schemaSource: string,
	sql: string,
	temporary: string,
): Promise<RuntimeSchemaRegistryDocument> {
	const dockerConfig = join(temporary, "docker");
	mkdirSync(dockerConfig, { mode: 0o700 });
	const docker = (args: readonly string[]) =>
		command(
			"docker",
			["--config", dockerConfig, "--host", "unix:///var/run/docker.sock", ...args],
			temporary,
		).trim();
	if (docker(["image", "inspect", authoringImage, "--format", "{{.Id}}"]) !== authoringImage)
		fail();
	const token = randomUUID(),
		name = `arr-registry-author-${token}`;
	const password = randomBytes(24).toString("hex");
	let id: string | undefined;
	const inspect = () => {
		if (!id || !/^[a-f0-9]{64}$/.test(id)) fail();
		return JSON.parse(
			docker([
				"inspect",
				id,
				"--format",
				'{"name":{{json .Name}},"image":{{json .Image}},"owner":{{json (index .Config.Labels "arr.registry.author")}},"mounts":{{json .Mounts}},"tmpfs":{{json .HostConfig.Tmpfs}},"ports":{{json .NetworkSettings.Ports}}}',
			]),
		) as {
			name: string;
			image: string;
			owner: string;
			mounts: { Type: string; Destination: string }[];
			tmpfs: Record<string, string>;
			ports: Record<string, { HostIp: string; HostPort: string }[] | null>;
		};
	};
	try {
		id = docker([
			"create",
			"--pull=never",
			"--name",
			name,
			"--label",
			`arr.registry.author=${token}`,
			"--restart=no",
			"--memory=512m",
			"--cpus=1",
			"--publish",
			"127.0.0.1::5432",
			"--tmpfs",
			"/var/lib/postgresql/data:rw,nosuid,noexec,size=268435456",
			"--env",
			"POSTGRES_DB=registry_author",
			"--env",
			"POSTGRES_USER=registry_author",
			"--env",
			`POSTGRES_PASSWORD=${password}`,
			authoringImage,
		]);
		const created = inspect();
		if (
			created.name !== `/${name}` ||
			created.image !== authoringImage ||
			created.owner !== token ||
			created.mounts.some(
				(mount) => mount.Type !== "tmpfs" || mount.Destination !== "/var/lib/postgresql/data",
			) ||
			Object.keys(created.tmpfs).length !== 1 ||
			!created.tmpfs["/var/lib/postgresql/data"]
		)
			fail();
		docker(["start", id]);
		const ports = inspect().ports["5432/tcp"];
		if (
			ports?.length !== 1 ||
			ports[0]!.HostIp !== "127.0.0.1" ||
			!/^\d+$/.test(ports[0]!.HostPort)
		)
			fail();
		const connection = {
			host: "127.0.0.1",
			port: Number(ports[0]!.HostPort),
			database: "registry_author",
			user: "registry_author",
			password,
			connectionTimeoutMillis: 500,
			query_timeout: 5000,
			statement_timeout: 4000,
		};
		let ready = false;
		for (let attempt = 0; attempt < 30; attempt++) {
			const probe = new Client(connection);
			probe.on("error", () => {});
			try {
				await probe.connect();
				await probe.query("SELECT 1");
				ready = true;
			} catch {
			} finally {
				await probe.end();
			}
			if (ready) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		if (!ready) fail();
		const database = new Client(connection);
		database.on("error", () => {});
		try {
			await database.connect();
			await database.query("BEGIN");
			await database.query(sql);
			await database.query(nativeReceiptSql("postgresql"));
			const parsed = parseAuthoringSql(sql);
			const observed = await readPostgresRuntimeSchemaCatalog(
				database,
				[...parsed.tables.map((table) => table.name), "ArrSchemaMigrationReceipt"],
				parsed.enums,
				parsed.indexes.map((index) => index.name),
			);
			if (observed.missingEnums.length) fail();
			const document = authorRuntimeSchemaRegistry({
				schemaSource,
				applicationSql: sql,
				catalog: observed.catalog,
			});
			await database.query("ROLLBACK");
			return document;
		} finally {
			await database.end();
		}
	} finally {
		if (id) {
			const current = inspect();
			if (
				current.name !== `/${name}` ||
				current.image !== authoringImage ||
				current.owner !== token ||
				current.mounts.some((mount) => mount.Type !== "tmpfs")
			)
				fail();
			docker(["rm", "--force", id]);
			if (docker(["ps", "--all", "--no-trunc", "--quiet", "--filter", `id=${id}`])) fail();
		}
	}
}

function writeGenerated(path: string, contents: string): void {
	if (existsSync(path)) {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink()) fail();
	}
	const descriptor = openSync(
		path,
		constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
		0o644,
	);
	try {
		if (!fstatSync(descriptor).isFile()) fail();
		writeFileSync(descriptor, contents);
	} finally {
		closeSync(descriptor);
	}
}

async function runOfflineAuthoring(): Promise<void> {
	if (process.argv.length !== 2) fail();
	const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
	const sourcePath = join(packageRoot, "prisma/schema.prisma");
	const source = readFileSync(sourcePath, "utf8"),
		normalized = normalizeRuntimeSchemaSource(source);
	const temporary = mkdtempSync(temporaryPrefix);
	try {
		const documents = {} as Record<"sqlite" | "postgresql", RuntimeSchemaRegistryDocument>;
		for (const provider of ["sqlite", "postgresql"] as const) {
			const schema = normalized.replace(/\bprovider(\s*=\s*)"sqlite"/, `provider$1"${provider}"`);
			const schemaPath = join(temporary, `${provider}.prisma`),
				configPath = join(temporary, `${provider}.config.ts`);
			writeFileSync(schemaPath, schema, { mode: 0o600 });
			writeFileSync(
				configPath,
				`export default { datasource: { url: ${JSON.stringify(provider === "sqlite" ? "file:/unopened-registry-author.db" : "postgresql://synthetic:synthetic@127.0.0.1:1/unopened")} } };\n`,
				{ mode: 0o600 },
			);
			const sql = command(
				process.execPath,
				[
					join(packageRoot, "node_modules/prisma/build/index.js"),
					"migrate",
					"diff",
					"--from-empty",
					"--to-schema",
					schemaPath,
					"--script",
					"--config",
					configPath,
				],
				temporary,
			);
			// Reject unexpected authoring output before it reaches even the disposable target.
			parseAuthoringSql(sql);
			documents[provider] =
				provider === "sqlite"
					? sqliteTarget(normalized, sql)
					: await postgresTarget(normalized, sql, temporary);
		}
		if (readFileSync(sourcePath, "utf8") !== source) fail();
		const directory = join(packageRoot, "prisma/runtime-schema");
		if (existsSync(directory)) {
			const stat = lstatSync(directory);
			if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
		} else mkdirSync(directory, { mode: 0o755 });
		const biome = resolve(packageRoot, "../../node_modules/.bin/biome");
		const format = (path: string, contents: string) =>
			command(
				biome,
				["format", `--stdin-file-path=${path}`],
				dirname(dirname(packageRoot)),
				contents,
			);
		const bindings = {
			normalizedSchemaSha256: sha(normalized),
			sqlite: { documentSha256: "", sqlSha256: "" },
			postgresql: { documentSha256: "", sqlSha256: "" },
		};
		const outputs: [string, string][] = [];
		for (const provider of ["sqlite", "postgresql"] as const) {
			const document = documents[provider];
			const jsonPath = join(directory, `registry-${provider}-v1.json`),
				sqlPath = join(directory, `${provider}-v1.sql`);
			const json = format(jsonPath, JSON.stringify(document)),
				sql = serializeRuntimeSchemaAtoms(document.atoms);
			bindings[provider] = { documentSha256: sha(json), sqlSha256: sha(sql) };
			outputs.push([jsonPath, json], [sqlPath, sql]);
		}
		const modulePath = join(packageRoot, "src/lib/backup/runtime-schema-registry.ts");
		const module = readFileSync(modulePath, "utf8"),
			marker =
				/\/\/ BEGIN REVIEWED RUNTIME SCHEMA ASSET BINDINGS[\s\S]*?\/\/ END REVIEWED RUNTIME SCHEMA ASSET BINDINGS/g;
		if ([...module.matchAll(marker)].length !== 1) fail();
		const replacement = `// BEGIN REVIEWED RUNTIME SCHEMA ASSET BINDINGS\nconst REVIEWED_RUNTIME_SCHEMA_ASSETS = ${JSON.stringify(bindings)} as const;\n// END REVIEWED RUNTIME SCHEMA ASSET BINDINGS`;
		outputs.push([modulePath, format(modulePath, module.replace(marker, replacement))]);
		for (const [path, contents] of outputs) writeGenerated(path, contents);
		process.stdout.write(
			`${JSON.stringify({ providers: 2, applicationModels: documents.sqlite.applicationModelCount, nativeTables: documents.sqlite.registry.tables.length })}\n`,
		);
	} finally {
		const stat = lstatSync(temporary);
		if (
			!temporary.startsWith(temporaryPrefix) ||
			dirname(temporary) !== tmpdir() ||
			!stat.isDirectory() ||
			stat.isSymbolicLink()
		)
			fail();
		rmSync(temporary, { recursive: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	void runOfflineAuthoring().catch(() => {
		process.stderr.write("Runtime schema registry authoring failed.\n");
		process.exitCode = 1;
	});
}
