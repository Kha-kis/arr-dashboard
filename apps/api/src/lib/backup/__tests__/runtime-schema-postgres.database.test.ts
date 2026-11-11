import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planRuntimeSchema, RuntimeSchemaPlanError } from "../runtime-schema-catalog.js";
import {
	type RuntimeSchemaPostgresEnum,
	readPostgresRuntimeSchemaCatalog,
} from "../runtime-schema-postgres.js";
import {
	loadRuntimeSchemaRegistry,
	prepareRuntimeSchemaExecution,
} from "../runtime-schema-registry.js";

const connectionString = process.env.RUNTIME_SCHEMA_TEST_DATABASE_URL;
const expectedEnums: readonly RuntimeSchemaPostgresEnum[] = [
	{ name: "State", values: ["ready", "pending"] },
];
const applicationEnums: readonly RuntimeSchemaPostgresEnum[] = [
	{
		name: "ServiceType",
		values: [
			"SONARR",
			"RADARR",
			"PROWLARR",
			"LIDARR",
			"READARR",
			"SEERR",
			"TAUTULLI",
			"PLEX",
			"JELLYFIN",
			"EMBY",
			"QUI",
		],
	},
	{
		name: "ProviderIdentityKind",
		values: [
			"plex-machine-identifier",
			"jellyfin-server-id",
			"emby-server-id",
			"tautulli-pms-identifier",
		],
	},
	{ name: "ProviderIdentityStatus", values: ["unverified", "verified", "mismatch"] },
	{ name: "LibraryItemType", values: ["movie", "series", "artist", "author"] },
	{ name: "BackupIntervalType", values: ["DISABLED", "HOURLY", "DAILY", "WEEKLY"] },
];
let sequence = 0;

describe.skipIf(!connectionString)("native PostgreSQL runtime schema catalog", () => {
	let database: Client;
	let namespace: string;
	beforeEach(async () => {
		database = new Client({
			connectionString,
			connectionTimeoutMillis: 5000,
			query_timeout: 5000,
			statement_timeout: 4000,
		});
		database.on("error", () => {});
		await database.connect();
		namespace = `reader_fixture_${process.pid}_${++sequence}`;
		await database.query(`CREATE SCHEMA "${namespace}"`);
		await database.query(`SET search_path TO "${namespace}"`);
	});
	afterEach(async () => {
		try {
			await database.query("ROLLBACK");
			await database.query(`DROP SCHEMA "${namespace}" CASCADE`);
		} finally {
			await database.end();
		}
	});
	const read = async (
		targets: readonly string[] = [],
		enums: readonly RuntimeSchemaPostgresEnum[] = [],
		indexes: readonly string[] = [],
	) => {
		await database.query("BEGIN");
		try {
			return await readPostgresRuntimeSchemaCatalog(database, targets, enums, indexes);
		} finally {
			await database.query("ROLLBACK");
		}
	};
	const refuse = async (
		targets: readonly string[] = [],
		enums: readonly RuntimeSchemaPostgresEnum[] = [],
		indexes: readonly string[] = [],
	) => {
		await expect(read(targets, enums, indexes)).rejects.toBeInstanceOf(RuntimeSchemaPlanError);
		try {
			await read(targets, enums, indexes);
		} catch (error) {
			expect(error).toMatchObject({ category: "unknown-schema-state" });
			expect(error).not.toHaveProperty("cause");
			expect(String(error)).not.toMatch(/Private|secret|SELECT|CREATE|postgresql:/);
		}
	};

	it("projects real counts, primary keys, defaults, indexes and native foreign keys", async () => {
		await database.query(`CREATE TABLE "Parent"(id TEXT NOT NULL PRIMARY KEY);
			CREATE TABLE "Child"(id INTEGER NOT NULL PRIMARY KEY,"parentId" TEXT,
				"completedPages" INTEGER NOT NULL DEFAULT 0,"enabled" BOOLEAN DEFAULT false,
				"createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
				FOREIGN KEY("parentId") REFERENCES "Parent"(id) ON DELETE SET NULL ON UPDATE CASCADE);
			CREATE UNIQUE INDEX "Child_parentId_key" ON "Child"("parentId");
			INSERT INTO "Parent" VALUES('synthetic'); INSERT INTO "Child"(id,"parentId") VALUES(1,'synthetic'),(2,NULL)`);
		const result = await read(["Parent", "Child"]);
		expect(result.namespace).toBe(namespace);
		expect(result.catalog.provider).toBe("postgresql");
		expect(result.catalog.tables.find((table) => table.name === "Child")).toEqual({
			name: "Child",
			rowCount: 2,
			columns: [
				{ name: "id", type: "INTEGER", nullable: false, defaultValue: null },
				{ name: "parentId", type: "TEXT", nullable: true, defaultValue: null },
				{ name: "completedPages", type: "INTEGER", nullable: false, defaultValue: "0" },
				{ name: "enabled", type: "BOOLEAN", nullable: true, defaultValue: "FALSE" },
				{
					name: "createdAt",
					type: "TIMESTAMP(3) WITHOUT TIME ZONE",
					nullable: true,
					defaultValue: "CURRENT_TIMESTAMP",
				},
			],
			primaryKey: ["id"],
			indexes: [
				{
					name: "Child_parentId_key",
					unique: true,
					columns: ["parentId"],
					predicate: null,
					valid: true,
				},
			],
			foreignKeys: [
				{
					columns: ["parentId"],
					targetTable: "Parent",
					targetColumns: ["id"],
					onDelete: "SET NULL",
					onUpdate: "CASCADE",
				},
			],
		});
	});
	it("executes the complete packaged PostgreSQL target in the actual custom-schema transaction", async () => {
		const registry = loadRuntimeSchemaRegistry("postgresql");
		const names = registry.tables.map((definition) => definition.target.name);
		const indexes = registry.tables.flatMap((definition) =>
			definition.target.indexes.map((index) => index.name),
		);
		await database.query("BEGIN");
		const empty = await readPostgresRuntimeSchemaCatalog(
			database,
			names,
			applicationEnums,
			indexes,
		);
		const prepared = prepareRuntimeSchemaExecution(registry, empty.catalog, empty.missingEnums);
		// Two Outbox tables, seven indexes and four same-owner foreign keys.
		expect(prepared.statementCount).toBe(453);
		await prepared.execute(async (sql) => {
			await database.query(sql);
		});
		const result = await readPostgresRuntimeSchemaCatalog(
			database,
			names,
			applicationEnums,
			indexes,
		);
		expect(result.namespace).toBe(namespace);
		expect(result.missingEnums).toEqual([]);
		expect(result.catalog.tables).toHaveLength(102);
		expect(result.catalog.tables.reduce((count, table) => count + table.columns.length, 0)).toBe(
			1351,
		);
		expect(
			result.catalog.tables.reduce((count, table) => count + table.foreignKeys.length, 0),
		).toBe(112);
		const event = result.catalog.tables.find((table) => table.name === "NotificationOutboxEvent");
		const delivery = result.catalog.tables.find(
			(table) => table.name === "NotificationOutboxDelivery",
		);
		expect(event?.columns.map((column) => column.name)).toEqual([
			"id",
			"userId",
			"eventType",
			"encryptedPayload",
			"payloadIv",
			"dedupFingerprint",
			"scopeFingerprint",
			"stage",
			"dueAt",
			"aggregationWindowSeconds",
			"maxBatchSize",
			"aggregateParentId",
			"destinationInstallationId",
			"restoreCommitId",
			"acceptedAt",
			"updatedAt",
		]);
		expect(delivery?.columns.map((column) => column.name)).toEqual([
			"id",
			"userId",
			"eventId",
			"channelId",
			"channelType",
			"subscriptionEventType",
			"state",
			"attemptOrdinal",
			"nextAttemptAt",
			"attemptToken",
			"workerEpoch",
			"attemptConfigFingerprint",
			"dispatchedAt",
			"outcomeCategory",
			"completedAt",
			"createdAt",
			"updatedAt",
		]);
		expect(event?.foreignKeys).toEqual(
			expect.arrayContaining([
				{
					columns: ["userId"],
					targetTable: "User",
					targetColumns: ["id"],
					onDelete: "CASCADE",
					onUpdate: "CASCADE",
				},
				{
					columns: ["aggregateParentId", "userId"],
					targetTable: "NotificationOutboxEvent",
					targetColumns: ["id", "userId"],
					onDelete: "NO ACTION",
					onUpdate: "NO ACTION",
				},
			]),
		);
		expect(delivery?.foreignKeys).toEqual(
			expect.arrayContaining([
				{
					columns: ["userId"],
					targetTable: "User",
					targetColumns: ["id"],
					onDelete: "CASCADE",
					onUpdate: "CASCADE",
				},
				{
					columns: ["eventId", "userId"],
					targetTable: "NotificationOutboxEvent",
					targetColumns: ["id", "userId"],
					onDelete: "CASCADE",
					onUpdate: "RESTRICT",
				},
			]),
		);
		expect(event?.foreignKeys).toHaveLength(2);
		expect(delivery?.foreignKeys).toHaveLength(2);
		expect(planRuntimeSchema(result.catalog, registry).atomIds).toEqual([]);
		await database.query("ROLLBACK");
	});
	it("adds only nullable watch diagnostics on populated legacy tables and preserves physical identities", async () => {
		const registry = loadRuntimeSchemaRegistry("postgresql");
		const names = registry.tables.map((d) => d.target.name);
		const indexes = registry.tables.flatMap((d) => d.target.indexes.map((i) => i.name));
		const catalog = () =>
			readPostgresRuntimeSchemaCatalog(database, names, applicationEnums, indexes);
		const table = "jellyfin_native_watch_scope_receipts";
		await database.query("BEGIN");
		const empty = await catalog();
		await prepareRuntimeSchemaExecution(registry, empty.catalog, empty.missingEnums).execute(
			async (sql) => {
				await database.query(sql);
			},
		);
		await database.query(`ALTER TABLE "${table}" DROP COLUMN "diagnosticsJson"`);
		await database.query(`
			INSERT INTO "User" ("id","username","updatedAt") VALUES ('owner','synthetic-owner','2026-10-19T12:00:00Z');
			INSERT INTO "ServiceInstance" ("id","userId","service","label","baseUrl","encryptedApiKey","encryptionIv","updatedAt") VALUES ('instance','owner','JELLYFIN','Synthetic','http://synthetic.invalid','synthetic-cipher','synthetic-iv','2026-10-19T12:00:00Z');
			INSERT INTO "jellyfin_native_watch_scope_receipts" ("id","instanceId","runId","userKeyDigest","libraryId","expectedRawCount","observedRawCount","exact","contentFingerprint","observedAt","connectionGeneration","identityGeneration") VALUES ('receipt','instance','old-run','synthetic-digest','synthetic-library',1,1,true,'${"a".repeat(64)}','2026-10-19T12:00:00Z',1,2);
			INSERT INTO "jellyfin_native_watch_rows" ("id","instanceId","runId","userKeyDigest","libraryId","jellyfinId","seriesId","seasonNumber","episodeNumber","played","observedAt","connectionGeneration","identityGeneration") VALUES ('watch','instance','old-run','synthetic-digest','synthetic-library','synthetic-episode','synthetic-series',1,1,false,'2026-10-19T12:00:00Z',1,2);
		`);
		await database.query("COMMIT");
		const rows = (await database.query(`SELECT * FROM "${table}"`)).rows;
		const identitySql =
			"SELECT c.relname,c.oid,c.relfilenode FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r' ORDER BY c.relname";
		const identities = (await database.query(identitySql, [namespace])).rows;
		await database.query("BEGIN");
		const failed = await catalog();
		await expect(
			prepareRuntimeSchemaExecution(registry, failed.catalog, failed.missingEnums).execute(() => {
				throw new Error("synthetic failure");
			}),
		).rejects.toThrow();
		await database.query("ROLLBACK");
		expect((await database.query(`SELECT * FROM "${table}"`)).rows).toEqual(rows);
		await database.query("BEGIN");
		const before = await catalog();
		const prepared = prepareRuntimeSchemaExecution(registry, before.catalog, before.missingEnums);
		expect(prepared.statementCount).toBe(1);
		const statements: string[] = [];
		await prepared.execute(async (sql) => {
			statements.push(sql);
			await database.query(sql);
		});
		expect(statements).toEqual([`ALTER TABLE "${table}" ADD COLUMN "diagnosticsJson" TEXT;`]);
		expect((await database.query(`SELECT * FROM "${table}"`)).rows).toEqual(
			rows.map((row) => ({ ...row, diagnosticsJson: null })),
		);
		expect((await database.query(identitySql, [namespace])).rows).toEqual(identities);
		expect(
			(await database.query('SELECT "runId","played" FROM "jellyfin_native_watch_rows"')).rows,
		).toEqual([{ runId: "old-run", played: false }]);
		await database.query("COMMIT");
	});
	it("replaces only exact stricter native list-cache indexes before allowing cross-media rows", async () => {
		const registry = loadRuntimeSchemaRegistry("postgresql");
		const names = registry.tables.map((definition) => definition.target.name);
		const indexes = registry.tables.flatMap((definition) =>
			definition.target.indexes.map((index) => index.name),
		);
		await database.query("BEGIN");
		const empty = await readPostgresRuntimeSchemaCatalog(
			database,
			names,
			applicationEnums,
			indexes,
		);
		await prepareRuntimeSchemaExecution(registry, empty.catalog, empty.missingEnums).execute(
			async (sql) => {
				await database.query(sql);
			},
		);
		await database.query(
			`INSERT INTO "User"(id,username,"updatedAt") VALUES('synthetic-user','synthetic-user',CURRENT_TIMESTAMP)`,
		);
		for (const [table, list] of [
			["tmdb_list_cache", "listId"],
			["trakt_list_cache", "listSlug"],
		] as const) {
			await database.query(
				`DROP INDEX "${table}_userId_${list}_mediaType_tmdbId_key";CREATE UNIQUE INDEX "${table}_userId_${list}_tmdbId_key" ON "${table}"("userId","${list}","tmdbId")`,
			);
			const insert = `INSERT INTO "${table}"(id,"userId","${list}","tmdbId","mediaType",title) VALUES($1,'synthetic-user','synthetic-list',7,$2,'synthetic')`;
			await database.query(insert, ["movie", "movie"]);
			await database.query("SAVEPOINT duplicate_probe");
			await expect(database.query(insert, ["show", "show"])).rejects.toMatchObject({
				code: "23505",
			});
			await database.query(
				"ROLLBACK TO SAVEPOINT duplicate_probe;RELEASE SAVEPOINT duplicate_probe",
			);
		}
		const current = await readPostgresRuntimeSchemaCatalog(
			database,
			names,
			applicationEnums,
			indexes,
		);
		const prepared = prepareRuntimeSchemaExecution(registry, current.catalog, current.missingEnums);
		expect(prepared.statementCount).toBe(4);
		const executed: string[] = [];
		await prepared.execute(async (sql) => {
			executed.push(sql);
			await database.query(sql);
		});
		for (const [table, list] of [
			["tmdb_list_cache", "listId"],
			["trakt_list_cache", "listSlug"],
		] as const) {
			const create = executed.findIndex((sql) =>
				sql.startsWith(`CREATE UNIQUE INDEX "${table}_userId_${list}_mediaType_tmdbId_key"`),
			);
			const drop = executed.indexOf(`DROP INDEX "${table}_userId_${list}_tmdbId_key";`);
			expect(create).toBeGreaterThanOrEqual(0);
			expect(drop).toBeGreaterThan(create);
			await database.query(
				`INSERT INTO "${table}"(id,"userId","${list}","tmdbId","mediaType",title) VALUES('show','synthetic-user','synthetic-list',7,'show','synthetic')`,
			);
			expect((await database.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows).toEqual([
				{ n: 2 },
			]);
		}
		expect(
			planRuntimeSchema(
				(await readPostgresRuntimeSchemaCatalog(database, names, applicationEnums, indexes))
					.catalog,
				registry,
			).atomIds,
		).toEqual([]);
		await database.query("ROLLBACK");
	});

	it("retains composite primary-key and foreign-key order", async () => {
		await database.query(`CREATE TABLE "Parent"(a TEXT NOT NULL,b INTEGER NOT NULL,PRIMARY KEY(b,a));
			CREATE TABLE "Child"(id TEXT PRIMARY KEY,x INTEGER,y TEXT,
				FOREIGN KEY(x,y) REFERENCES "Parent"(b,a) ON DELETE RESTRICT)`);
		const result = await read();
		expect(result.catalog.tables.find((table) => table.name === "Parent")?.primaryKey).toEqual([
			"b",
			"a",
		]);
		expect(result.catalog.tables.find((table) => table.name === "Child")?.foreignKeys).toEqual([
			{
				columns: ["x", "y"],
				targetTable: "Parent",
				targetColumns: ["b", "a"],
				onDelete: "RESTRICT",
				onUpdate: "NO ACTION",
			},
		]);
	});

	it("uses the actual custom namespace without reading a same-name table in public", async () => {
		await database.query(`CREATE TABLE public."Private"(id INTEGER PRIMARY KEY); INSERT INTO public."Private" VALUES(100),(200);
			CREATE TABLE "Private"(id INTEGER PRIMARY KEY); INSERT INTO "Private" VALUES(7)`);
		try {
			const result = await read(["Private"]);
			expect(result.namespace).toBe(namespace);
			expect(result.catalog.tables[0]?.rowCount).toBe(1);
		} finally {
			await database.query('DROP TABLE public."Private"');
		}
	});

	it("refuses ambiguous effective search paths rather than selecting a fallback schema", async () => {
		await database.query(`SET search_path TO "${namespace}",public`);
		await refuse();
	});

	it("requires the caller transaction rather than independently committed reads", async () => {
		await expect(readPostgresRuntimeSchemaCatalog(database, [])).rejects.toBeInstanceOf(
			RuntimeSchemaPlanError,
		);
	});

	it("validates enum labels and order, not just an existing type name", async () => {
		await database.query(
			`CREATE TYPE "State" AS ENUM('ready','pending'); CREATE TABLE "Private"(id TEXT PRIMARY KEY,state "State" DEFAULT 'ready')`,
		);
		const result = await read(["Private"], expectedEnums);
		expect(result.missingEnums).toEqual([]);
		expect(result.catalog.tables[0]?.columns[1]).toEqual({
			name: "state",
			type: 'ENUM:["State",["ready","pending"]]',
			nullable: true,
			defaultValue: "'ready'",
		});
		await refuse(["Private"], [{ name: "State", values: ["pending", "ready"] }]);
	});

	it("reports missing registered types without creating them or inventing completion", async () => {
		const result = await read([], expectedEnums);
		expect(result.missingEnums).toEqual(["State"]);
		expect(
			(
				await database.query(
					"SELECT count(*)::int AS n FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=$1 AND t.typname='State'",
					[namespace],
				)
			).rows,
		).toEqual([{ n: 0 }]);
	});

	it("refuses non-enum type collisions", async () => {
		await database.query('CREATE DOMAIN "State" AS TEXT');
		await refuse([], expectedEnums);
	});

	it("refuses mismatched enum values even before any managed table exists", async () => {
		await database.query(`CREATE TYPE "State" AS ENUM('ready','other')`);
		await refuse([], expectedEnums);
	});

	it("refuses view collisions with registered table or index names", async () => {
		await database.query('CREATE VIEW "Private" AS SELECT 1 AS id');
		await refuse(["Private"]);
		await refuse([], [], ["Private"]);
	});

	it("refuses temporary target shadowing", async () => {
		await database.query('CREATE TEMP TABLE "Private"(id INTEGER)');
		await refuse(["Private"]);
	});

	it("refuses deferred or unvalidated constraints", async () => {
		await database.query(`CREATE TABLE "Parent"(id INTEGER PRIMARY KEY);
			CREATE TABLE "Private"(id INTEGER PRIMARY KEY,parent INTEGER,
				CONSTRAINT "fk" FOREIGN KEY(parent) REFERENCES "Parent" DEFERRABLE INITIALLY DEFERRED)`);
		await refuse();
		await database.query(
			'ALTER TABLE "Private" DROP CONSTRAINT fk; ALTER TABLE "Private" ADD CONSTRAINT fk FOREIGN KEY(parent) REFERENCES "Parent" NOT VALID',
		);
		await refuse();
	});

	it("refuses a genuinely invalid index left by a failed concurrent unique build", async () => {
		await database.query(
			"CREATE TABLE \"Private\"(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO \"Private\" VALUES(1,'duplicate'),(2,'duplicate')",
		);
		await expect(
			database.query('CREATE UNIQUE INDEX CONCURRENTLY "Private_invalid" ON "Private"(value)'),
		).rejects.toMatchObject({ code: "23505" });
		await refuse();
		expect((await database.query('SELECT count(*)::int AS n FROM "Private"')).rows).toEqual([
			{ n: 2 },
		]);
	});

	it("refuses expression, descending and non-default operator-class index semantics", async () => {
		await database.query(
			'CREATE TABLE "Private"(id INTEGER PRIMARY KEY,value TEXT); CREATE INDEX "idx" ON "Private"(lower(value))',
		);
		await refuse();
		await database.query('DROP INDEX idx; CREATE INDEX idx ON "Private"(value DESC)');
		await refuse();
		await database.query('DROP INDEX idx; CREATE INDEX idx ON "Private"(value text_pattern_ops)');
		await refuse();
	});

	it("refuses NULLS NOT DISTINCT uniqueness rather than equating null policies", async () => {
		await database.query(
			'CREATE TABLE "Private"(id INTEGER PRIMARY KEY,value TEXT); CREATE UNIQUE INDEX idx ON "Private"(value) NULLS NOT DISTINCT',
		);
		await refuse();
	});

	it("retains a real partial-index predicate", async () => {
		await database.query(
			'CREATE TABLE "Private"(id INTEGER PRIMARY KEY,value TEXT); CREATE INDEX idx ON "Private"(value) WHERE value IS NOT NULL',
		);
		expect((await read()).catalog.tables[0]?.indexes[0]?.predicate).toBe("(value IS NOT NULL)");
	});

	it("distinguishes identity allocation from an ordinary integer column", async () => {
		await database.query(
			'CREATE TABLE "Private"(id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY)',
		);
		expect((await read()).catalog.tables[0]?.columns[0]?.type).toBe("INTEGER;IDENTITY:a");
	});

	it("refuses row-level security rather than treating filtered counts as complete inventory", async () => {
		await database.query(
			'CREATE TABLE "Private"(id INTEGER PRIMARY KEY); ALTER TABLE "Private" ENABLE ROW LEVEL SECURITY',
		);
		await refuse();
	});

	it("quotes private-shaped identifiers without executing them as SQL", async () => {
		await database.query(
			`CREATE TABLE "Private'""secret"("id""x" TEXT PRIMARY KEY); INSERT INTO "Private'""secret" VALUES('synthetic')`,
		);
		const result = await read();
		expect(result.catalog.tables[0]?.name).toBe("Private'\"secret");
		expect(result.catalog.tables[0]?.rowCount).toBe(1);
	});

	it("keeps custom views, ordinary triggers, data and the caller transaction untouched", async () => {
		await database.query(`CREATE TABLE "Private"(id INTEGER PRIMARY KEY); INSERT INTO "Private" VALUES(7);
			CREATE VIEW "CustomView" AS SELECT id FROM "Private";
			CREATE FUNCTION custom_trigger() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;
			CREATE TRIGGER custom_guard BEFORE INSERT ON "Private" FOR EACH ROW EXECUTE FUNCTION custom_trigger()`);
		await database.query("BEGIN");
		await readPostgresRuntimeSchemaCatalog(database, ["Private"]);
		expect((await database.query('SELECT id FROM "CustomView"')).rows).toEqual([{ id: 7 }]);
		expect(
			(
				await database.query(
					"SELECT count(*)::int AS n FROM pg_trigger WHERE tgname='custom_guard' AND tgrelid='\"Private\"'::regclass",
				)
			).rows,
		).toEqual([{ n: 1 }]);
		await database.query('INSERT INTO "Private" VALUES(8)');
		await database.query("ROLLBACK");
		expect((await database.query('SELECT id FROM "Private"')).rows).toEqual([{ id: 7 }]);
	});

	it("refuses denied inventory reads instead of publishing a zero count", async () => {
		const role = `reader_role_${process.pid}_${sequence}`;
		await database.query(`CREATE TABLE "Private"(id INTEGER PRIMARY KEY); INSERT INTO "Private" VALUES(7);
			CREATE ROLE "${role}"; GRANT USAGE ON SCHEMA "${namespace}" TO "${role}"; SET ROLE "${role}"`);
		try {
			await refuse(["Private"]);
		} finally {
			await database.query("RESET ROLE");
			await database.query(
				`REVOKE USAGE ON SCHEMA "${namespace}" FROM "${role}"; DROP ROLE "${role}"`,
			);
		}
		expect((await database.query('SELECT id FROM "Private"')).rows).toEqual([{ id: 7 }]);
	});

	it("does not reconnect or infer an empty schema from a closed native backend", async () => {
		const closed = new Client({ connectionString, connectionTimeoutMillis: 5000 });
		closed.on("error", () => {});
		await closed.connect();
		await closed.query("BEGIN");
		await closed.end();
		await expect(readPostgresRuntimeSchemaCatalog(closed, [])).rejects.toMatchObject({
			category: "unknown-schema-state",
		});
	});

	it("refuses CHECK constraints and generated columns outside the catalog contract", async () => {
		await database.query(
			'CREATE TABLE "Private"(id INTEGER PRIMARY KEY,value TEXT CHECK(length(value)>0))',
		);
		await refuse();
		await database.query(
			'DROP TABLE "Private"; CREATE TABLE "Private"(id INTEGER PRIMARY KEY,value INTEGER GENERATED ALWAYS AS (id+1) STORED)',
		);
		await refuse();
	});

	it("refuses partitioned and inherited tables rather than silently omitting rows", async () => {
		await database.query('CREATE TABLE "Private"(id INTEGER) PARTITION BY RANGE(id)');
		await refuse(["Private"]);
		await database.query(
			'DROP TABLE "Private"; CREATE TABLE "Parent"(id INTEGER); CREATE TABLE "Private"() INHERITS("Parent")',
		);
		await refuse();
	});

	it("refuses domain types and non-default column collations", async () => {
		await database.query(
			'CREATE DOMAIN "Positive" AS INTEGER CHECK(VALUE>0); CREATE TABLE "Private"(id "Positive" PRIMARY KEY)',
		);
		await refuse();
		await database.query(
			'DROP TABLE "Private"; CREATE TABLE "Private"(id TEXT COLLATE "C" PRIMARY KEY)',
		);
		await refuse();
	});

	it("retains native literal defaults without erasing escaped quote semantics", async () => {
		await database.query(
			`CREATE TABLE "Private"(id INTEGER PRIMARY KEY,value TEXT DEFAULT 'literal ) '' CHECK',negative INTEGER DEFAULT -1)`,
		);
		const result = await read();
		expect(result.catalog.tables[0]?.columns[1]?.defaultValue).toBe("'literal ) '' CHECK'");
		expect(result.catalog.tables[0]?.columns[2]?.defaultValue).toBe("-1");
	});

	it("does not confuse a foreign-namespace enum with a registered destination type", async () => {
		await database.query(`CREATE TYPE public."State" AS ENUM('ready','pending');
			CREATE TABLE "Private"(id INTEGER PRIMARY KEY,state public."State")`);
		try {
			await refuse(["Private"], expectedEnums);
		} finally {
			await database.query('DROP TABLE "Private"; DROP TYPE public."State"');
		}
	});

	it("refuses cross-namespace foreign-key targets rather than assigning local identity", async () => {
		await database.query(
			'CREATE TABLE public."Parent"(id INTEGER PRIMARY KEY); CREATE TABLE "Private"(id INTEGER PRIMARY KEY,parent INTEGER REFERENCES public."Parent")',
		);
		try {
			await refuse(["Private"]);
		} finally {
			await database.query('DROP TABLE "Private"; DROP TABLE public."Parent"');
		}
	});
});
