import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
	authorRuntimeSchemaRegistry,
	type RuntimeSchemaAuthorInput,
} from "../../../../scripts/build-runtime-schema-registry.js";
import type { RuntimeSchemaTable } from "../runtime-schema-catalog.js";
import { planRuntimeSchema } from "../runtime-schema-catalog.js";
import {
	loadRuntimeSchemaRegistry,
	normalizeRuntimeSchemaSource,
	prepareRuntimeSchemaExecution,
	prepareSqliteOidcPredecessorReplacement,
	type RuntimeSchemaRegistryDocument,
	RuntimeSchemaRegistryError,
	verifyRuntimeSchemaRegistryDocument,
} from "../runtime-schema-registry.js";
import { readSqliteRuntimeSchemaCatalog } from "../runtime-schema-sqlite.js";

type PackagedModule = typeof import("../runtime-schema-registry.js");
const require = createRequire(import.meta.url);
const { transformSync } = createRequire(require.resolve("tsup"))("esbuild") as {
	transformSync: (source: string, options: object) => { code: string };
};

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

describe("loaded SQLite OIDC replacement capability", () => {
	it("creates only the verified complete canonical replacement once, without exposing atom text", async () => {
		const registry = loadRuntimeSchemaRegistry("sqlite");
		const replacement = prepareSqliteOidcPredecessorReplacement(registry);
		expect(Object.isFrozen(replacement)).toBe(true);
		expect(Object.keys(replacement).sort()).toEqual(["execute", "tableName"]);
		expect(replacement.tableName).toBe("ArrOidcProviderSchemaMigration");
		const db = new Database(":memory:");
		try {
			db.pragma("foreign_keys=ON");
			db.exec("BEGIN EXCLUSIVE");
			await replacement.execute((sql) => {
				db.exec(sql);
			});
			const actual = readSqliteRuntimeSchemaCatalog(db, [replacement.tableName]).tables[0]!;
			expect({ ...actual, name: "oidc_providers" }).toEqual(
				registry.tables.find(({ target }) => target.name === "oidc_providers")!.target,
			);
			await expect(
				replacement.execute((sql) => {
					db.exec(sql);
				}),
			).rejects.toThrow("Database schema registry is unavailable.");
			expect(
				db.prepare("SELECT name FROM sqlite_schema WHERE name='oidc_providers'").get(),
			).toBeUndefined();
		} finally {
			if (db.inTransaction) db.exec("ROLLBACK");
			db.close();
		}
	});
	it("refuses copied, JSON-reconstructed, metadata-only and wrong-provider registries", () => {
		const registry = loadRuntimeSchemaRegistry("sqlite");
		const source = readFileSync(
			new URL("../../../../prisma/runtime-schema/registry-sqlite-v1.json", import.meta.url),
			"utf8",
		);
		const document = JSON.parse(source) as RuntimeSchemaRegistryDocument;
		const pure = verifyRuntimeSchemaRegistryDocument(document, document.schemaSourceSha256);
		for (const candidate of [
			{ ...registry },
			JSON.parse(JSON.stringify(registry)),
			pure,
			loadRuntimeSchemaRegistry("postgresql"),
		])
			expect(() => prepareSqliteOidcPredecessorReplacement(candidate)).toThrow(
				"Database schema registry is unavailable.",
			);
	});
	it("consumes the capability before awaiting, and sanitizes callback failure without replay", async () => {
		const replacement = prepareSqliteOidcPredecessorReplacement(
			loadRuntimeSchemaRegistry("sqlite"),
		);
		let release!: () => void,
			calls = 0;
		const barrier = new Promise<void>((done) => {
			release = done;
		});
		const first = replacement.execute(async () => {
			calls++;
			await barrier;
			throw new Error("private fixture details");
		});
		await expect(
			replacement.execute(() => {
				calls++;
			}),
		).rejects.toThrow("Database schema registry is unavailable.");
		release();
		await expect(first).rejects.toThrow("Database schema registry is unavailable.");
		await expect(
			replacement.execute(() => {
				calls++;
			}),
		).rejects.toThrow("Database schema registry is unavailable.");
		expect(calls).toBe(1);
	});
});
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
function fixture(): RuntimeSchemaRegistryDocument {
	const table: RuntimeSchemaTable = {
		name: "Example",
		columns: [{ name: "id", type: "TEXT", nullable: false, defaultValue: null }],
		primaryKey: ["id"],
		indexes: [],
		foreignKeys: [],
		rowCount: 0,
	};
	const receipt: RuntimeSchemaTable = {
		name: "ArrSchemaMigrationReceipt",
		columns: [
			{ name: "id", type: "TEXT", nullable: false, defaultValue: null },
			{ name: "protocolVersion", type: "INTEGER", nullable: false, defaultValue: "1" },
			{ name: "registryVersion", type: "INTEGER", nullable: false, defaultValue: null },
			{ name: "provider", type: "TEXT", nullable: false, defaultValue: null },
			{ name: "targetDigest", type: "TEXT", nullable: false, defaultValue: null },
			{ name: "planDigest", type: "TEXT", nullable: false, defaultValue: null },
			{ name: "completedAt", type: "DATETIME", nullable: false, defaultValue: null },
		],
		primaryKey: ["id"],
		indexes: [],
		foreignKeys: [],
		rowCount: 0,
	};
	const dateReceipt: RuntimeSchemaTable = {
		name: "ArrRuntimeDataFormatReceipt",
		columns: [
			{ name: "id", type: "INTEGER;ROWID", nullable: false, defaultValue: null },
			{ name: "formatVersion", type: "INTEGER", nullable: false, defaultValue: null },
			{ name: "dateColumnsDigest", type: "TEXT", nullable: false, defaultValue: null },
			{ name: "completedAt", type: "TEXT", nullable: false, defaultValue: null },
			{ name: "normalizedValues", type: "INTEGER", nullable: false, defaultValue: null },
		],
		primaryKey: ["id"],
		indexes: [],
		foreignKeys: [],
		rowCount: 0,
	};
	const atoms = [
		{
			id: "table:example",
			kind: "table" as const,
			tableName: table.name,
			objectName: table.name,
			sql: 'CREATE TABLE "Example"("id" TEXT NOT NULL PRIMARY KEY);',
		},
		{
			id: "table:receipt",
			kind: "table" as const,
			tableName: receipt.name,
			objectName: receipt.name,
			sql: 'CREATE TABLE "ArrSchemaMigrationReceipt"("id" TEXT NOT NULL PRIMARY KEY,"protocolVersion" INTEGER NOT NULL DEFAULT 1,"registryVersion" INTEGER NOT NULL,"provider" TEXT NOT NULL,"targetDigest" TEXT NOT NULL,"planDigest" TEXT NOT NULL,"completedAt" DATETIME NOT NULL);',
		},
		{
			id: "table:date-receipt",
			kind: "table" as const,
			tableName: dateReceipt.name,
			objectName: dateReceipt.name,
			sql: 'CREATE TABLE "ArrRuntimeDataFormatReceipt"("id" INTEGER NOT NULL PRIMARY KEY,"formatVersion" INTEGER NOT NULL,"dateColumnsDigest" TEXT NOT NULL,"completedAt" TEXT NOT NULL,"normalizedValues" INTEGER NOT NULL);',
		},
	].map((atom) => ({ ...atom, sha256: hash(atom.sql) }));
	const nativeEnums: RuntimeSchemaRegistryDocument["nativeEnums"] = [];
	const registry = {
		provider: "sqlite" as const,
		version: 1 as const,
		targetDigest: hash(
			canonical({
				provider: "sqlite",
				version: 1,
				tables: [table, receipt, dateReceipt],
				nativeEnums,
			}),
		),
		tables: [table, receipt, dateReceipt].map((target, index) => ({
			target,
			createAtom: atoms[index]!.id,
			addColumnAtoms: {},
			addIndexAtoms: {},
			addForeignKeyAtoms: {},
		})),
		orderedAtomIds: atoms.map((atom) => atom.id),
	};
	return {
		formatVersion: 1,
		schemaSourceSha256: "a".repeat(64),
		applicationModelCount: 1,
		registry,
		nativeEnums,
		atoms,
		sqlSha256: hash(atoms.map((atom) => `-- arr-schema-atom ${atom.id}\n${atom.sql}\n`).join("\n")),
	};
}
function alter(f: RuntimeSchemaRegistryDocument, patch: object): RuntimeSchemaRegistryDocument {
	return { ...f, ...patch } as RuntimeSchemaRegistryDocument;
}

function indexedFixture(
	sql: string,
	unique = false,
	columns = ["id"],
): RuntimeSchemaRegistryDocument {
	const f = fixture();
	const first = f.registry.tables[0]!;
	const index = { name: "Example_id_idx", unique, columns, predicate: null, valid: true };
	const atoms = [
		...f.atoms,
		{
			id: "index:example",
			kind: "index" as const,
			tableName: "Example",
			objectName: index.name,
			sql,
			sha256: hash(sql),
		},
	];
	const registry = {
		...f.registry,
		tables: [
			{
				...first,
				target: { ...first.target, indexes: [index] },
				addIndexAtoms: { [index.name]: "index:example" },
			},
			f.registry.tables[1]!,
			f.registry.tables[2]!,
		],
		orderedAtomIds: atoms.map((atom) => atom.id),
	};
	registry.targetDigest = hash(
		canonical({
			provider: registry.provider,
			version: 1,
			tables: registry.tables.map((definition) => definition.target),
			nativeEnums: [],
		}),
	);
	return {
		...f,
		registry,
		atoms,
		sqlSha256: hash(atoms.map((atom) => `-- arr-schema-atom ${atom.id}\n${atom.sql}\n`).join("\n")),
	};
}
function refused(document: RuntimeSchemaRegistryDocument, expected = "a".repeat(64)) {
	expect(() => verifyRuntimeSchemaRegistryDocument(document, expected)).toThrow(
		RuntimeSchemaRegistryError,
	);
	try {
		verifyRuntimeSchemaRegistryDocument(document, expected);
	} catch (error) {
		expect(error).not.toHaveProperty("cause");
		expect(String(error)).not.toMatch(/Private|secret|SELECT|CREATE|https:/);
	}
}

const packagedSchema = 'datasource db { provider = "sqlite" }\nmodel Example { id String @id }\n';
const authorSchema = `${packagedSchema}model Parent { id String @id }\n`;
const authorSql = `-- CreateTable
CREATE TABLE "Parent"("id" TEXT NOT NULL PRIMARY KEY,"a" TEXT NOT NULL,"b" TEXT NOT NULL);
CREATE TABLE "Example"("id" TEXT NOT NULL PRIMARY KEY,"parentId" TEXT,"a" TEXT,"b" TEXT,
"completedPages" INTEGER NOT NULL DEFAULT 0,"note" TEXT DEFAULT 'a,b;done',"createdAt" DATETIME DEFAULT CURRENT_TIMESTAMP,
CONSTRAINT "Example_parentId_fkey" FOREIGN KEY("parentId") REFERENCES "Parent"("id") ON DELETE SET NULL ON UPDATE CASCADE,
CONSTRAINT "Example_pair_fkey" FOREIGN KEY("a","b") REFERENCES "Parent"("a","b") ON DELETE RESTRICT ON UPDATE CASCADE);
CREATE UNIQUE INDEX "Parent_a_b_key" ON "Parent"("a","b");`;
function authorInput(sql = authorSql, schema = authorSchema): RuntimeSchemaAuthorInput {
	const db = new Database(":memory:");
	try {
		db.pragma("foreign_keys=ON");
		db.exec(sql);
		db.exec(fixture().atoms[1]!.sql);
		db.exec(fixture().atoms[2]!.sql);
		db.exec("BEGIN");
		return {
			schemaSource: schema,
			applicationSql: sql,
			catalog: readSqliteRuntimeSchemaCatalog(db, []),
		};
	} finally {
		db.close();
	}
}
function rebind(document: RuntimeSchemaRegistryDocument): RuntimeSchemaRegistryDocument {
	return {
		...document,
		registry: {
			...document.registry,
			targetDigest: hash(
				canonical({
					provider: document.registry.provider,
					version: 1,
					tables: document.registry.tables.map((definition) => definition.target),
					nativeEnums: document.nativeEnums,
				}),
			),
			orderedAtomIds: document.atoms.map((atom) => atom.id),
		},
		atoms: document.atoms.map((atom) => ({ ...atom, sha256: hash(atom.sql) })),
		sqlSha256: hash(
			document.atoms.map((atom) => `-- arr-schema-atom ${atom.id}\n${atom.sql}\n`).join("\n"),
		),
	};
}

function postgresEnumFixture(): RuntimeSchemaRegistryDocument {
	const f = fixture();
	const state = { name: "State", values: ["ready", "done"], createAtom: "enum:state" };
	return rebind({
		...f,
		nativeEnums: [state],
		registry: {
			...f.registry,
			provider: "postgresql",
			tables: f.registry.tables.slice(0, 2).map((definition, index) => ({
				...definition,
				target: {
					...definition.target,
					columns:
						index === 0
							? [
									...definition.target.columns,
									{
										name: "state",
										type: 'ENUM:["State",["ready","done"]]',
										nullable: true,
										defaultValue: null,
									},
								]
							: definition.target.columns.map((column) =>
									column.name === "completedAt"
										? { ...column, type: "TIMESTAMP(3) WITHOUT TIME ZONE" }
										: column,
								),
				},
			})),
		},
		atoms: [
			{
				id: state.createAtom,
				kind: "enum",
				tableName: null,
				objectName: state.name,
				sha256: "",
				sql: `CREATE TYPE "State" AS ENUM ('ready', 'done');`,
			},
			{
				...f.atoms[0]!,
				sql: 'CREATE TABLE "Example"("id" TEXT NOT NULL PRIMARY KEY,"state" "State");',
			},
			{ ...f.atoms[1]!, sql: f.atoms[1]!.sql.replace("DATETIME", "TIMESTAMP(3)") },
		],
	});
}

async function withPackage(
	operation: (module: PackagedModule, root: string, modulePath: string) => void | Promise<void>,
	options: {
		layout?: "source" | "dist";
		document?: RuntimeSchemaRegistryDocument;
		schema?: string;
	} = {},
) {
	const root = mkdtempSync(join(tmpdir(), "arr-registry-package-"));
	try {
		const sourceDirectory = fileURLToPath(new URL("../", import.meta.url));
		const moduleDirectory =
			options.layout === "dist" ? join(root, "dist") : join(root, "src/lib/backup");
		const assetDirectory = join(root, "prisma/runtime-schema");
		mkdirSync(moduleDirectory, { recursive: true, mode: 0o700 });
		mkdirSync(assetDirectory, { recursive: true, mode: 0o700 });
		const schema = options.schema ?? packagedSchema;
		const document = {
			...(options.document ?? fixture()),
			schemaSourceSha256: hash(packagedSchema),
		};
		const documentText = `${JSON.stringify(document, null, 2)}\n`;
		const sql = document.atoms
			.map((atom) => `-- arr-schema-atom ${atom.id}\n${atom.sql}\n`)
			.join("\n");
		const bindings = {
			normalizedSchemaSha256: hash(packagedSchema),
			sqlite: { documentSha256: hash(documentText), sqlSha256: hash(sql) },
			postgresql: { documentSha256: hash(documentText), sqlSha256: hash(sql) },
		};
		const registrySource = readFileSync(
			join(sourceDirectory, "runtime-schema-registry.ts"),
			"utf8",
		).replace(
			/\/\/ BEGIN REVIEWED RUNTIME SCHEMA ASSET BINDINGS[\s\S]*?\/\/ END REVIEWED RUNTIME SCHEMA ASSET BINDINGS/,
			`const REVIEWED_RUNTIME_SCHEMA_ASSETS = ${JSON.stringify(bindings)};`,
		);
		const write = (path: string, content: string) => writeFileSync(path, content, { mode: 0o600 });
		write(join(root, "package.json"), '{"type":"module"}');
		write(join(root, "prisma/schema.prisma"), schema);
		const provider = document.registry.provider;
		write(join(assetDirectory, `registry-${provider}-v1.json`), documentText);
		write(join(assetDirectory, `${provider}-v1.sql`), sql);
		for (const [name, source] of [
			["runtime-schema-registry", registrySource],
			[
				"runtime-schema-catalog",
				readFileSync(join(sourceDirectory, "runtime-schema-catalog.ts"), "utf8"),
			],
		])
			write(
				join(moduleDirectory, `${name}.js`),
				transformSync(source!, { loader: "ts", format: "esm", target: "node22" }).code,
			);
		const modulePath = join(moduleDirectory, "runtime-schema-registry.js");
		const module = (await import(
			/* @vite-ignore */ pathToFileURL(modulePath).href
		)) as PackagedModule;
		await operation(module, root, modulePath);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("reviewed runtime schema registry verification", () => {
	it("returns detached deeply frozen metadata without exposing atom SQL", () => {
		const f = fixture();
		const registry = verifyRuntimeSchemaRegistryDocument(f, "a".repeat(64));
		expect(registry).toEqual(f.registry);
		expect(registry).not.toBe(f.registry);
		expect(Object.isFrozen(registry)).toBe(true);
		expect(Object.isFrozen(registry.tables[0]?.target.columns)).toBe(true);
		expect(registry).not.toHaveProperty("atoms");
	});
	it("refuses stale schema bindings even when atom hashes still match", () =>
		refused(fixture(), "b".repeat(64)));
	it("refuses a changed native target with an unchanged digest", () => {
		const f = fixture();
		const first = f.registry.tables[0]!;
		refused(
			alter(f, {
				registry: {
					...f.registry,
					tables: [
						{
							...first,
							target: {
								...first.target,
								columns: [{ name: "id", type: "INTEGER", nullable: false, defaultValue: null }],
							},
						},
						f.registry.tables[1],
						f.registry.tables[2],
					],
				},
			}),
		);
	});
	it("refuses changed statement bytes under an old atom hash", () => {
		const f = fixture();
		refused(
			alter(f, {
				atoms: [{ ...f.atoms[0], sql: 'CREATE TABLE "Private"(id TEXT);' }, ...f.atoms.slice(1)],
			}),
		);
	});
	it("refuses a mismatched SQL asset hash", () =>
		refused(alter(fixture(), { sqlSha256: "b".repeat(64) })));
	it("refuses a missing referenced atom", () => {
		const f = fixture();
		refused(alter(f, { atoms: f.atoms.slice(1) }));
	});
	it("refuses duplicate ordered IDs", () => {
		const f = fixture();
		refused(
			alter(f, { registry: { ...f.registry, orderedAtomIds: [f.atoms[0]!.id, f.atoms[0]!.id] } }),
		);
	});
	it("refuses metadata order that differs from statement order", () => {
		const f = fixture();
		refused(
			alter(f, {
				registry: { ...f.registry, orderedAtomIds: [...f.registry.orderedAtomIds].reverse() },
			}),
		);
	});
	it("refuses atom ownership that differs from its mapped table", () => {
		const f = fixture();
		refused(alter(f, { atoms: [{ ...f.atoms[0], tableName: "Private" }, ...f.atoms.slice(1)] }));
	});
	it("refuses a create-table mapping to a different operation kind", () => {
		const f = fixture();
		refused(alter(f, { atoms: [{ ...f.atoms[0], kind: "column" }, ...f.atoms.slice(1)] }));
	});
	it("accepts a correctly paired index without making it executable", () => {
		const f = indexedFixture('CREATE INDEX "Example_id_idx" ON "Example"("id");');
		expect(
			verifyRuntimeSchemaRegistryDocument(f, "a".repeat(64)).tables[0]?.target.indexes[0]?.unique,
		).toBe(false);
	});
	it("refuses mismatched SQL uniqueness even when all hashes are internally consistent", () => {
		refused(indexedFixture('CREATE UNIQUE INDEX "Example_id_idx" ON "Example"("id");'));
	});
	it("accepts a correctly paired unique index", () => {
		const f = indexedFixture('CREATE UNIQUE INDEX "Example_id_idx" ON "Example"("id");', true);
		expect(
			verifyRuntimeSchemaRegistryDocument(f, "a".repeat(64)).tables[0]?.target.indexes[0]?.unique,
		).toBe(true);
	});
	it("refuses mismatched SQL index columns before any native statement can run", () => {
		refused(indexedFixture('CREATE INDEX "Example_id_idx" ON "Example"("other");'));
	});
	it("refuses extra index expressions or sort semantics hidden under a plain descriptor", () => {
		refused(indexedFixture('CREATE INDEX "Example_id_idx" ON "Example"("id" DESC);'));
		refused(indexedFixture('CREATE INDEX "Example_id_idx" ON "Example"(lower("id"));'));
	});
	it("refuses unknown document fields instead of accepting runtime source URLs", () =>
		refused(alter(fixture(), { sourceUrl: "https://example.invalid/secret" })));
	it("refuses wrong model counts rather than certifying incomplete targets", () =>
		refused(alter(fixture(), { applicationModelCount: 0 })));
	it("requires the native receipt table outside the application count", () => {
		const f = fixture();
		refused(alter(f, { registry: { ...f.registry, tables: f.registry.tables.slice(0, 1) } }));
	});
	it("refuses protocol receipt fields that invent mutable authority", () => {
		const f = fixture();
		const receipt = f.registry.tables[1]!.target;
		refused(
			alter(f, {
				registry: {
					...f.registry,
					tables: [
						f.registry.tables[0],
						{
							...f.registry.tables[1],
							target: {
								...receipt,
								columns: [
									...receipt.columns,
									{ name: "ownerPassword", type: "TEXT", nullable: true, defaultValue: null },
								],
							},
						},
						f.registry.tables[2],
					],
				},
			}),
		);
	});
	it("refuses SQLite foreign-key disabling or table rebuild statements", () => {
		const f = fixture();
		for (const sql of ["PRAGMA foreign_keys=OFF;", 'DROP TABLE "Example";']) {
			const atoms = [{ ...f.atoms[0]!, sql, sha256: hash(sql) }, ...f.atoms.slice(1)];
			refused(
				alter(f, {
					atoms,
					sqlSha256: hash(
						atoms.map((atom) => `-- arr-schema-atom ${atom.id}\n${atom.sql}\n`).join("\n"),
					),
				}),
			);
		}
	});
	it("refuses additional statements hidden after a valid prefix", () => {
		const f = fixture();
		const sql = `${f.atoms[0]!.sql} DELETE FROM "Example";`;
		const atoms = [{ ...f.atoms[0]!, sql, sha256: hash(sql) }, ...f.atoms.slice(1)];
		refused(
			alter(f, {
				atoms,
				sqlSha256: hash(
					atoms.map((atom) => `-- arr-schema-atom ${atom.id}\n${atom.sql}\n`).join("\n"),
				),
			}),
		);
	});
	it("does not turn an accessor into a registry load side effect", () => {
		let read = false;
		const f = fixture();
		Object.defineProperty(f, "registry", {
			get() {
				read = true;
				return {};
			},
		});
		refused(f);
		expect(read).toBe(false);
	});
	it("refuses cycles and non-JSON metadata without executing them", () => {
		const f = fixture();
		refused(alter(f, { atoms: [new Date(), f.atoms[1]] }));
		const cyclic = { ...f, extra: {} };
		cyclic.extra = cyclic;
		refused(cyclic);
	});
});

describe("provider-only source normalization", () => {
	const sqlite =
		'generator client {\n  provider = "prisma-client"\n}\ndatasource db {\n  provider = "sqlite"\n}\nmodel Example { id String @id }\n';
	it("normalizes only the datasource provider, not model or generator content", () => {
		expect(
			normalizeRuntimeSchemaSource(
				sqlite.replace('provider = "sqlite"', 'provider = "postgresql"'),
			),
		).toBe(sqlite);
	});
	it("does not normalize away a real application schema change", () => {
		expect(normalizeRuntimeSchemaSource(sqlite.replace("id String", "id Int"))).not.toBe(sqlite);
	});
	it("refuses ambiguous or unsupported datasource definitions", () => {
		for (const source of [
			sqlite.replace('"sqlite"', '"mysql"'),
			`${sqlite}datasource other { provider = "sqlite" }`,
			"model Example { id String @id }",
		])
			expect(() => normalizeRuntimeSchemaSource(source)).toThrow(RuntimeSchemaRegistryError);
	});
});

describe("closed packaged loader", () => {
	it("refuses unknown providers without reading a caller-selected URL or SQL path", () => {
		expect(() => loadRuntimeSchemaRegistry("https://example.invalid/secret" as "sqlite")).toThrow(
			RuntimeSchemaRegistryError,
		);
	});
	it.each(["source", "dist"] as const)(
		"loads only fixed %s package assets and exposes frozen metadata",
		async (layout) => {
			await withPackage(
				(module) => {
					const registry = module.loadRuntimeSchemaRegistry("sqlite");
					expect(registry.tables.map((definition) => definition.target.name)).toEqual([
						"Example",
						"ArrSchemaMigrationReceipt",
						"ArrRuntimeDataFormatReceipt",
					]);
					expect(Object.isFrozen(registry.tables[0]?.target)).toBe(true);
					expect(registry).not.toHaveProperty("atoms");
				},
				{ layout },
			);
		},
	);
	it("allows only a datasource-provider change in the packaged schema", async () => {
		await withPackage(
			(module) => {
				expect(module.loadRuntimeSchemaRegistry("postgresql").provider).toBe("postgresql");
			},
			{
				document: postgresEnumFixture(),
				schema: packagedSchema.replace('"sqlite"', '"postgresql"'),
			},
		);
	});
	it("ignores the working directory rather than loading its schema or registry", async () => {
		await withPackage((_module, root, modulePath) => {
			const unrelated = join(root, "unrelated");
			mkdirSync(unrelated, { mode: 0o700 });
			writeFileSync(join(unrelated, "schema.prisma"), "wrong schema", { mode: 0o600 });
			const output = execFileSync(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					`const m=await import(${JSON.stringify(pathToFileURL(modulePath).href)});console.log(JSON.stringify({loaded:m.loadRuntimeSchemaRegistry('sqlite').tables.length===3}));`,
				],
				{ cwd: unrelated, env: {}, encoding: "utf8" },
			);
			expect(JSON.parse(output)).toEqual({ loaded: true });
		});
	});
	it.each(["schema", "document", "sql"] as const)(
		"refuses corrupted %s bytes even after a successful load",
		async (asset) => {
			await withPackage((module, root) => {
				module.loadRuntimeSchemaRegistry("sqlite");
				const file =
					asset === "schema"
						? "prisma/schema.prisma"
						: asset === "document"
							? "prisma/runtime-schema/registry-sqlite-v1.json"
							: "prisma/runtime-schema/sqlite-v1.sql";
				writeFileSync(
					join(root, file),
					asset === "schema" ? packagedSchema.replace("id String", "id Int") : "corrupt",
					{ mode: 0o600 },
				);
				expect(() => module.loadRuntimeSchemaRegistry("sqlite")).toThrow(
					"Database schema registry is unavailable.",
				);
			});
		},
	);
	it("does not treat a synthetically verified or cloned registry as executable authority", async () => {
		await withPackage((module) => {
			const loaded = module.loadRuntimeSchemaRegistry("sqlite");
			const pure = module.verifyRuntimeSchemaRegistryDocument(
				{ ...fixture(), schemaSourceSha256: hash(packagedSchema) },
				hash(packagedSchema),
			);
			for (const registry of [pure, { ...loaded }, JSON.parse(JSON.stringify(loaded))])
				expect(() =>
					module.prepareRuntimeSchemaExecution(registry, { provider: "sqlite", tables: [] }),
				).toThrow("Database schema registry is unavailable.");
		});
	});
	it("does not follow a substituted asset symlink", async () => {
		await withPackage((module, root) => {
			const asset = join(root, "prisma/runtime-schema/sqlite-v1.sql");
			const substitute = join(root, "substitute.sql");
			writeFileSync(substitute, readFileSync(asset), { mode: 0o600 });
			unlinkSync(asset);
			symlinkSync(substitute, asset);
			expect(() => module.loadRuntimeSchemaRegistry("sqlite")).toThrow(
				"Database schema registry is unavailable.",
			);
		});
	});
	it("prepares from real native catalog evidence and applies the selected immutable statements once", async () => {
		await withPackage(async (module) => {
			const db = new Database(":memory:");
			try {
				db.pragma("foreign_keys=ON");
				db.exec("BEGIN EXCLUSIVE");
				const registry = module.loadRuntimeSchemaRegistry("sqlite");
				const names = ["Example", "ArrSchemaMigrationReceipt", "ArrRuntimeDataFormatReceipt"];
				const prepared = module.prepareRuntimeSchemaExecution(
					registry,
					readSqliteRuntimeSchemaCatalog(db, names),
				);
				expect(prepared.statementCount).toBe(3);
				expect(prepared.result).toBe("upgrade");
				expect(prepared.planDigest).toMatch(/^[a-f0-9]{64}$/);
				expect(prepared).not.toHaveProperty("atoms");
				await prepared.execute((sql) => {
					db.exec(sql);
				});
				expect(readSqliteRuntimeSchemaCatalog(db, names).tables.map((table) => table.name)).toEqual(
					["ArrRuntimeDataFormatReceipt", "ArrSchemaMigrationReceipt", "Example"],
				);
				await expect(
					prepared.execute(() => {
						throw new Error("Must not run twice");
					}),
				).rejects.toThrow("Database schema registry is unavailable.");
				const ready = module.prepareRuntimeSchemaExecution(
					registry,
					readSqliteRuntimeSchemaCatalog(db, names),
				);
				expect(ready.statementCount).toBe(0);
				expect(ready.result).toBe("ready");
				await ready.execute(() => {
					throw new Error("No DDL for a ready catalog");
				});
				db.exec("ROLLBACK");
			} finally {
				db.close();
			}
		});
	});
	it("rejects an incompatible whole plan before exposing any execution closure", async () => {
		await withPackage((module) => {
			const registry = module.loadRuntimeSchemaRegistry("sqlite");
			const table = fixture().registry.tables[0]!.target;
			expect(() =>
				module.prepareRuntimeSchemaExecution(registry, {
					provider: "sqlite",
					tables: [{ ...table, columns: [{ ...table.columns[0]!, type: "INTEGER" }] }],
				}),
			).toThrow("Database schema upgrade is unavailable.");
		});
	});
	it("selects a missing registered enum before dependent table creation", async () => {
		await withPackage(
			async (module) => {
				const registry = module.loadRuntimeSchemaRegistry("postgresql");
				const prepared = module.prepareRuntimeSchemaExecution(
					registry,
					{ provider: "postgresql", tables: [] },
					["State"],
				);
				const applied: string[] = [];
				await prepared.execute((sql) => {
					applied.push(sql);
				});
				expect(applied).toHaveLength(3);
				expect(applied[0]).toBe(`CREATE TYPE "State" AS ENUM ('ready', 'done');`);
				expect(applied[1]).toBe(
					'CREATE TABLE "Example"("id" TEXT NOT NULL PRIMARY KEY,"state" "State");',
				);
			},
			{ document: postgresEnumFixture() },
		);
	});
	it("rejects duplicate, unknown, or wrong-provider missing enum facts", async () => {
		await withPackage(
			(module) => {
				const registry = module.loadRuntimeSchemaRegistry("postgresql");
				for (const names of [["State", "State"], ["Other"]])
					expect(() =>
						module.prepareRuntimeSchemaExecution(
							registry,
							{ provider: "postgresql", tables: [] },
							names,
						),
					).toThrow("Database schema registry is unavailable.");
			},
			{ document: postgresEnumFixture() },
		);
		await withPackage((module) => {
			expect(() =>
				module.prepareRuntimeSchemaExecution(
					module.loadRuntimeSchemaRegistry("sqlite"),
					{ provider: "sqlite", tables: [] },
					["State"],
				),
			).toThrow("Database schema registry is unavailable.");
		});
	});
	it("does not recreate a checked existing enum and refuses contradictory missing-type evidence", async () => {
		const document = postgresEnumFixture();
		await withPackage(
			async (module) => {
				const registry = module.loadRuntimeSchemaRegistry("postgresql");
				const empty = { provider: "postgresql" as const, tables: [] };
				const prepared = module.prepareRuntimeSchemaExecution(registry, empty, []);
				const applied: string[] = [];
				await prepared.execute((sql) => {
					applied.push(sql);
				});
				expect(applied).toHaveLength(2);
				expect(applied[0]).toBe(
					'CREATE TABLE "Example"("id" TEXT NOT NULL PRIMARY KEY,"state" "State");',
				);
				expect(() =>
					module.prepareRuntimeSchemaExecution(
						registry,
						{
							provider: "postgresql",
							tables: document.registry.tables.map((definition) => definition.target),
						},
						["State"],
					),
				).toThrow("Database schema registry is unavailable.");
			},
			{ document },
		);
	});
	it("does not allow concurrent execution to enter the same plan twice", async () => {
		await withPackage(async (module) => {
			const prepared = module.prepareRuntimeSchemaExecution(
				module.loadRuntimeSchemaRegistry("sqlite"),
				{ provider: "sqlite", tables: [] },
			);
			let release!: () => void;
			const barrier = new Promise<void>((resolve) => {
				release = resolve;
			});
			let attempts = 0;
			const first = prepared.execute(async () => {
				attempts++;
				await barrier;
			});
			try {
				await expect(
					prepared.execute(() => {
						attempts++;
					}),
				).rejects.toThrow("Database schema registry is unavailable.");
				expect(attempts).toBe(1);
			} finally {
				release();
				await first;
			}
			expect(attempts).toBe(3);
		});
	});
	it("stops on executor failure and does not replay the consumed plan", async () => {
		await withPackage(async (module) => {
			const prepared = module.prepareRuntimeSchemaExecution(
				module.loadRuntimeSchemaRegistry("sqlite"),
				{ provider: "sqlite", tables: [] },
			);
			let attempts = 0;
			await expect(
				prepared.execute(() => {
					attempts++;
					throw new Error("private database detail");
				}),
			).rejects.toThrow("Database schema registry is unavailable.");
			expect(attempts).toBe(1);
			await expect(
				prepared.execute(() => {
					attempts++;
				}),
			).rejects.toThrow("Database schema registry is unavailable.");
			expect(attempts).toBe(1);
		});
	});
});

describe("offline native registry authoring", () => {
	it("omits Prisma's exact PostgreSQL public-schema prologue from runtime atoms", () => {
		const f = postgresEnumFixture();
		const input = {
			schemaSource: packagedSchema,
			applicationSql:
				'CREATE SCHEMA IF NOT EXISTS "public";\n' +
				f.atoms
					.filter((atom) => atom.tableName !== "ArrSchemaMigrationReceipt")
					.map((atom) => atom.sql)
					.join("\n"),
			catalog: {
				provider: "postgresql" as const,
				tables: f.registry.tables.map((definition) => definition.target),
			},
		};
		const document = authorRuntimeSchemaRegistry(input);
		expect(document.nativeEnums).toEqual([
			{ name: "State", values: ["ready", "done"], createAtom: document.atoms[0]!.id },
		]);
		expect(document.atoms.some((atom) => atom.sql.includes("CREATE SCHEMA"))).toBe(false);
		for (const applicationSql of [
			input.applicationSql.replace('"public"', '"other"'),
			`${input.applicationSql}CREATE SCHEMA IF NOT EXISTS "public";`,
		])
			expect(() => authorRuntimeSchemaRegistry({ ...input, applicationSql })).toThrow(
				RuntimeSchemaRegistryError,
			);
	});
	it("retains native ordinal order for Prisma's unnamed composite SQLite primary key", () => {
		const sql =
			'CREATE TABLE "Parent"("a" TEXT NOT NULL,"b" TEXT NOT NULL,PRIMARY KEY("b","a"));CREATE TABLE "Example"("id" TEXT NOT NULL PRIMARY KEY);';
		const document = authorRuntimeSchemaRegistry(authorInput(sql));
		const parent = document.registry.tables.find(
			(definition) => definition.target.name === "Parent",
		)!;
		expect(parent.target.primaryKey).toEqual(["b", "a"]);
		expect(parent.addColumnAtoms).toEqual({});
	});
	it("validates the generated output descriptor before truncating it", () => {
		const source = readFileSync(
			new URL("../../../../scripts/build-runtime-schema-registry.ts", import.meta.url),
			"utf8",
		);
		const writer = source.slice(
			source.indexOf("function writeGenerated("),
			source.indexOf("async function runOfflineAuthoring("),
		);

		expect(writer).not.toContain("O_TRUNC");
		expect(writer).toMatch(
			/fstatSync\(descriptor\)[\s\S]*isFile\(\)[\s\S]*nlink[\s\S]*ftruncateSync\(descriptor, 0\)[\s\S]*writeFileSync\(descriptor, contents\)/,
		);
	});
	it("rejects destination arguments before a CLI authoring run can start", () => {
		const script = fileURLToPath(
			new URL("../../../../scripts/build-runtime-schema-registry.ts", import.meta.url),
		);
		let result: { status?: number; stdout?: Buffer; stderr?: Buffer } | undefined;
		try {
			execFileSync(
				process.execPath,
				[
					require.resolve("tsx/cli"),
					script,
					"--database-url",
					"postgresql://example.invalid/unopened",
				],
				{ env: {}, stdio: "pipe" },
			);
		} catch (error) {
			result = error as typeof result;
		}
		expect(result?.status).toBe(1);
		expect(result?.stdout?.toString()).toBe("");
		expect(result?.stderr?.toString()).toBe("Runtime schema registry authoring failed.\n");
	});
	it("derives every application/native table and constraint from the isolated native target", () => {
		const input = authorInput();
		const document = authorRuntimeSchemaRegistry(input);
		expect(document.applicationModelCount).toBe(2);
		expect(document.registry.tables.map((definition) => definition.target.name)).toEqual([
			"ArrRuntimeDataFormatReceipt",
			"ArrSchemaMigrationReceipt",
			"Example",
			"Parent",
		]);
		expect(
			document.registry.tables.find((definition) => definition.target.name === "Example")?.target
				.foreignKeys,
		).toHaveLength(2);
		expect(verifyRuntimeSchemaRegistryDocument(document, hash(authorSchema))).toEqual(
			document.registry,
		);
		expect(planRuntimeSchema(input.catalog, document.registry).atomIds).toEqual([]);
	});
	it("serializes deterministically without importing SQL comments or weakening composite foreign keys", () => {
		const input = authorInput();
		const document = authorRuntimeSchemaRegistry(input);
		expect(authorRuntimeSchemaRegistry(input)).toEqual(document);
		expect(document.atoms.every((atom) => !atom.sql.includes("--"))).toBe(true);
		const example = document.registry.tables.find(
			(definition) => definition.target.name === "Example",
		)!;
		expect(example.addColumnAtoms).not.toHaveProperty("a");
		expect(example.addColumnAtoms).not.toHaveProperty("b");
		expect(example.addColumnAtoms).not.toHaveProperty("id");
		expect(example.addColumnAtoms).not.toHaveProperty("createdAt");
		expect(document.atoms.find((atom) => atom.id === example.createAtom)?.sql).toContain(
			'FOREIGN KEY("a","b")',
		);
	});
	it("authors native-safe single-column FK and literal-default additions", () => {
		const document = authorRuntimeSchemaRegistry(authorInput());
		const example = document.registry.tables.find(
			(definition) => definition.target.name === "Example",
		)!;
		const db = new Database(":memory:");
		try {
			db.pragma("foreign_keys=ON");
			db.exec(
				'CREATE TABLE "Parent"("id" TEXT NOT NULL PRIMARY KEY,"a" TEXT NOT NULL,"b" TEXT NOT NULL);CREATE UNIQUE INDEX "Parent_a_b_key" ON "Parent"("a","b");CREATE TABLE "Example"("id" TEXT NOT NULL PRIMARY KEY);INSERT INTO "Example"("id") VALUES(\'synthetic\');',
			);
			for (const name of ["parentId", "completedPages", "note"])
				db.exec(document.atoms.find((atom) => atom.id === example.addColumnAtoms[name])!.sql);
			expect(db.prepare('SELECT "parentId","completedPages","note" FROM "Example"').get()).toEqual({
				parentId: null,
				completedPages: 0,
				note: "a,b;done",
			});
			expect(() => db.prepare('UPDATE "Example" SET "parentId"=\'missing\'').run()).toThrow();
			db.exec("BEGIN");
			expect(
				readSqliteRuntimeSchemaCatalog(db, ["Example"]).tables.find(
					(table) => table.name === "Example",
				)?.foreignKeys,
			).toEqual([
				{
					columns: ["parentId"],
					targetTable: "Parent",
					targetColumns: ["id"],
					onDelete: "SET NULL",
					onUpdate: "CASCADE",
				},
			]);
		} finally {
			db.close();
		}
	});
	it("refuses an incomplete or populated target rather than authoring optimistic metadata", () => {
		const input = authorInput();
		for (const catalog of [
			{ ...input.catalog, tables: input.catalog.tables.slice(1) },
			{
				...input.catalog,
				tables: input.catalog.tables.map((table) => ({ ...table, rowCount: 1 })),
			},
		])
			expect(() => authorRuntimeSchemaRegistry({ ...input, catalog })).toThrow(
				RuntimeSchemaRegistryError,
			);
	});
	it("refuses unexpected DML, table drops, transaction envelopes or source model counts", () => {
		const input = authorInput();
		for (const extra of [
			'DROP TABLE "Example";',
			'DELETE FROM "Example";',
			"PRAGMA foreign_keys=OFF;",
			"BEGIN;",
		])
			expect(() =>
				authorRuntimeSchemaRegistry({ ...input, applicationSql: input.applicationSql + extra }),
			).toThrow(RuntimeSchemaRegistryError);
		expect(() => authorRuntimeSchemaRegistry({ ...input, schemaSource: packagedSchema })).toThrow(
			RuntimeSchemaRegistryError,
		);
	});
	it("keeps old managed SQLite uniqueness from blocking valid cross-media rows", () => {
		const sql =
			'CREATE TABLE "tmdb_list_cache"("id" TEXT NOT NULL PRIMARY KEY,"userId" TEXT NOT NULL,"listId" TEXT NOT NULL,"mediaType" TEXT NOT NULL,"tmdbId" INTEGER NOT NULL);CREATE UNIQUE INDEX "tmdb_list_cache_userId_listId_mediaType_tmdbId_key" ON "tmdb_list_cache"("userId","listId","mediaType","tmdbId");CREATE TABLE "Parent"("id" TEXT NOT NULL PRIMARY KEY);';
		const document = authorRuntimeSchemaRegistry(authorInput(sql));
		const db = new Database(":memory:");
		try {
			db.exec(
				'CREATE TABLE "tmdb_list_cache"("id" TEXT NOT NULL PRIMARY KEY,"userId" TEXT NOT NULL,"listId" TEXT NOT NULL,"mediaType" TEXT NOT NULL,"tmdbId" INTEGER NOT NULL);CREATE UNIQUE INDEX "tmdb_list_cache_userId_listId_tmdbId_key" ON "tmdb_list_cache"("userId","listId","tmdbId");INSERT INTO "tmdb_list_cache" VALUES(\'movie\',\'synthetic\',\'list\',\'movie\',7);',
			);
			expect(() =>
				db
					.prepare("INSERT INTO \"tmdb_list_cache\" VALUES('show','synthetic','list','show',7)")
					.run(),
			).toThrow();
			db.exec("BEGIN EXCLUSIVE");
			const plan = planRuntimeSchema(readSqliteRuntimeSchemaCatalog(db, []), document.registry);
			const selected = document.atoms.filter((atom) => plan.atomIds.includes(atom.id));
			const create = selected.findIndex(
				(atom) => atom.objectName === "tmdb_list_cache_userId_listId_mediaType_tmdbId_key",
			);
			const drop = selected.findIndex((atom) => atom.kind === "predecessor-index");
			expect(create).toBeGreaterThanOrEqual(0);
			expect(drop).toBeGreaterThan(create);
			for (const atom of selected) db.exec(atom.sql);
			db.prepare(
				"INSERT INTO \"tmdb_list_cache\" VALUES('show','synthetic','list','show',7)",
			).run();
			expect(db.prepare('SELECT count(*) AS n FROM "tmdb_list_cache"').get()).toEqual({ n: 2 });
		} finally {
			db.close();
		}
	});
});

describe("complete packaged application schema", () => {
	it.each(["sqlite", "postgresql"] as const)(
		"loads the entire %s application and native receipt target",
		(provider) => {
			const registry = loadRuntimeSchemaRegistry(provider);
			expect(registry.tables).toHaveLength(provider === "sqlite" ? 103 : 102);
			for (const [name, primaryKey] of [
				["qui_observation_publications", ["userId"]],
				["qui_torrent_observations", ["userId", "generation", "infoHash"]],
			] as const) {
				const target = registry.tables.find((t) => t.target.name === name)?.target;
				expect(target?.primaryKey).toEqual(primaryKey);
				expect(target?.foreignKeys).toEqual([
					expect.objectContaining({
						columns: ["userId"],
						targetTable: "User",
						targetColumns: ["id"],
						onDelete: "CASCADE",
					}),
				]);
			}
			expect(
				registry.tables.reduce((count, definition) => count + definition.target.columns.length, 0),
			).toBe(provider === "sqlite" ? 1355 : 1350);
			expect(
				registry.tables.reduce(
					(count, definition) => count + definition.target.foreignKeys.length,
					0,
				),
			).toBe(112);
			expect(
				registry.tables.reduce((count, definition) => count + definition.target.indexes.length, 0),
			).toBe(234);
		},
	);
	it("applies the complete SQLite target without any copy/drop/rebuild and reaches a ready catalog", async () => {
		const registry = loadRuntimeSchemaRegistry("sqlite");
		const database = new Database(":memory:");
		try {
			database.pragma("foreign_keys=ON");
			database.exec("BEGIN EXCLUSIVE");
			const names = registry.tables.map((definition) => definition.target.name);
			const prepared = prepareRuntimeSchemaExecution(
				registry,
				readSqliteRuntimeSchemaCatalog(database, names),
			);
			expect(prepared.statementCount).toBe(337);
			await prepared.execute((sql) => {
				database.exec(sql);
			});
			const observed = readSqliteRuntimeSchemaCatalog(database, names);
			expect(planRuntimeSchema(observed, registry).atomIds).toEqual([]);
			expect(observed.tables).toHaveLength(103);
			expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
			expect(database.pragma("foreign_key_check")).toEqual([]);
			database.exec("ROLLBACK");
		} finally {
			database.close();
		}
	});
});
