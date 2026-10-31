import { type ChildProcess, fork } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireSqliteRestoreRuntimeOwnership } from "../restore-runtime-sqlite.js";
import {
	loadRuntimeSchemaRegistry,
	prepareRuntimeSchemaExecution,
} from "../runtime-schema-registry.js";
import {
	readSqliteRuntimeSchemaCatalog,
	readSqliteRuntimeSchemaPlanningCatalog,
	synchronizeSqliteRuntimeSchema,
} from "../runtime-schema-sqlite.js";
import {
	applySqliteOidcPredecessorMigration,
	prepareSqliteOidcPredecessorMigration,
	type SqliteOidcPredecessorPlan,
} from "../runtime-schema-sqlite-oidc-migration.js";

// Independent complete public predecessor. Expectations never derive from the migration.
const legacySql = `CREATE TABLE oidc_providers (
 id INTEGER NOT NULL PRIMARY KEY DEFAULT 1,
 displayName TEXT NOT NULL, clientId TEXT NOT NULL,
 encryptedClientSecret TEXT NOT NULL, clientSecretIv TEXT NOT NULL,
 issuer TEXT NOT NULL, redirectUri TEXT NOT NULL,
 scopes TEXT NOT NULL DEFAULT 'openid,email,profile',
 enabled BOOLEAN NOT NULL DEFAULT true,
 createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updatedAt DATETIME NOT NULL);`;
const seedSql = `INSERT INTO oidc_providers VALUES(41,'synthetic','synthetic-client',
 'opaque-ciphertext','opaque-iv','https://synthetic.invalid','https://synthetic.invalid/callback',
 'openid,email,profile',1,'2026-10-08T12:00:00.000+00:00','2026-10-08T12:00:00.000+00:00')`;
const registry = loadRuntimeSchemaRegistry("sqlite");
const catalog = (db: Database.Database) => readSqliteRuntimeSchemaCatalog(db, ["oidc_providers"]);
const plan = (db: Database.Database) =>
	prepareSqliteOidcPredecessorMigration(db, registry, catalog(db));
const snapshot = (db: Database.Database) => ({
	schema: db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all(),
	rows: db.prepare("SELECT * FROM oidc_providers ORDER BY id").raw().safeIntegers().all(),
});
const encoded = (db: Database.Database) =>
	db
		.prepare(`SELECT id,
 typeof(displayName),hex(CAST(displayName AS BLOB)),
 typeof(encryptedClientSecret),hex(encryptedClientSecret),
 typeof(enabled),enabled,typeof(createdAt),createdAt,typeof(updatedAt),updatedAt
 FROM oidc_providers ORDER BY id`)
		.raw()
		.safeIntegers()
		.all();

describe("exact SQLite OIDC predecessor migration", () => {
	let db: Database.Database;
	beforeEach(() => {
		db = new Database(":memory:");
		db.pragma("foreign_keys=ON");
		db.exec(`${legacySql} ${seedSql}; BEGIN EXCLUSIVE`);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		if (db.inTransaction) db.exec("ROLLBACK");
		db.close();
	});
	it.each([false, true])(
		"preserves the %s empty/populated predecessor through SQL-only copy and canonical restart",
		async (empty) => {
			if (empty) db.exec("DELETE FROM oidc_providers");
			const before = snapshot(db);
			const prepared = plan(db)!;
			expect(snapshot(db)).toEqual(before);
			expect(Object.isFrozen(prepared)).toBe(true);
			expect(Object.isFrozen(prepared.postCatalog.tables)).toBe(true);
			expect(Object.keys(prepared).sort()).toEqual(["migrationId", "postCatalog"]);
			await applySqliteOidcPredecessorMigration(db, prepared, async () => {});
			expect(snapshot(db).rows).toEqual(before.rows);
			expect(catalog(db).tables[0]!.columns[0]!.type).toBe("INTEGER;ROWID;AUTOINCREMENT");
			expect(
				db
					.prepare("SELECT name FROM sqlite_schema WHERE name='ArrOidcProviderSchemaMigration'")
					.get(),
			).toBeUndefined();
			expect(plan(db)).toBeNull();
			db.exec("COMMIT; BEGIN EXCLUSIVE");
			expect(plan(db)).toBeNull();
			expect(snapshot(db).rows).toEqual(before.rows);
		},
	);
	it("conserves three distinct OIDC rows and preserves ordinary presence evidence in the post-catalog", async () => {
		db.exec(`INSERT INTO oidc_providers SELECT 42,'second',clientId||'2',encryptedClientSecret||'2',clientSecretIv,issuer,redirectUri,scopes,0,createdAt,updatedAt FROM oidc_providers WHERE id=41;
			INSERT INTO oidc_providers SELECT 43,'third',clientId||'3',encryptedClientSecret||'3',clientSecretIv,issuer,redirectUri,scopes,1,createdAt,updatedAt FROM oidc_providers WHERE id=41;
			CREATE TABLE Ordinary(id INTEGER PRIMARY KEY); INSERT INTO Ordinary VALUES(1),(2);`);
		const saved = snapshot(db).rows;
		expect(saved).toHaveLength(3);
		const planning = readSqliteRuntimeSchemaPlanningCatalog(db, ["oidc_providers"]);
		const prepared = prepareSqliteOidcPredecessorMigration(db, registry, planning)!;
		expect(prepared.postCatalog.tables.find(({ name }) => name === "Ordinary")).toMatchObject({
			rowPresence: "nonempty",
		});
		expect(prepared.postCatalog.tables.find(({ name }) => name === "Ordinary")).not.toHaveProperty(
			"rowCount",
		);
		expect(prepared.postCatalog.tables.find(({ name }) => name === "oidc_providers")).toMatchObject(
			{ rowCount: 3 },
		);
		await applySqliteOidcPredecessorMigration(db, prepared, async () => {});
		expect(snapshot(db).rows).toEqual(saved);
		db.exec("COMMIT; BEGIN EXCLUSIVE");
		expect(
			prepareSqliteOidcPredecessorMigration(
				db,
				registry,
				readSqliteRuntimeSchemaPlanningCatalog(db, ["oidc_providers"]),
			),
		).toBeNull();
		expect(snapshot(db).rows).toEqual(saved);
	});
	it.each([false, true])(
		"refuses presence-only OIDC evidence even for canonical=%s",
		async (canonical) => {
			if (canonical) await applySqliteOidcPredecessorMigration(db, plan(db)!, async () => {});
			const exact = catalog(db);
			const { rowCount: _count, ...metadata } = exact.tables[0]!;
			const forged = {
				...exact,
				provider: "sqlite" as const,
				tables: [{ ...metadata, rowPresence: "nonempty" as const }],
			};
			const saved = snapshot(db);
			expect(() => prepareSqliteOidcPredecessorMigration(db, registry, forged)).toThrow();
			expect(snapshot(db)).toEqual(saved);
		},
	);
	it.each(["prototype", "getter", "ambiguous"])(
		"refuses %s ordinary evidence before OIDC post-catalog cloning",
		(kind) => {
			db.exec("CREATE TABLE Ordinary(id INTEGER PRIMARY KEY); INSERT INTO Ordinary VALUES(1),(2)");
			const native = readSqliteRuntimeSchemaPlanningCatalog(db, ["oidc_providers"]);
			const ordinary = native.tables.find(({ name }) => name === "Ordinary")!;
			let reads = 0;
			if (kind === "prototype") Object.setPrototypeOf(ordinary, { unsafe: true });
			if (kind === "getter")
				Object.defineProperty(ordinary, "rowPresence", {
					enumerable: true,
					get() {
						reads++;
						return "nonempty";
					},
				});
			if (kind === "ambiguous") Object.assign(ordinary, { rowCount: 2 });
			expect(() => prepareSqliteOidcPredecessorMigration(db, registry, native)).toThrow();
			expect(reads).toBe(0);
		},
	);
	it.each(["row-count", "same-count-value", "copy-corruption"])(
		"refuses %s with three-row exact OIDC evidence inside a planning catalog",
		async (kind) => {
			db.exec(`INSERT INTO oidc_providers SELECT 42,'second',clientId||'2',encryptedClientSecret||'2',clientSecretIv,issuer,redirectUri,scopes,0,createdAt,updatedAt FROM oidc_providers WHERE id=41;
			INSERT INTO oidc_providers SELECT 43,'third',clientId||'3',encryptedClientSecret||'3',clientSecretIv,issuer,redirectUri,scopes,1,createdAt,updatedAt FROM oidc_providers WHERE id=41;
			COMMIT; BEGIN EXCLUSIVE`);
			const saved = snapshot(db);
			expect(saved.rows).toHaveLength(3);
			const prepared = prepareSqliteOidcPredecessorMigration(
				db,
				registry,
				readSqliteRuntimeSchemaPlanningCatalog(db, ["oidc_providers"]),
			)!;
			if (kind === "row-count") db.exec("DELETE FROM oidc_providers WHERE id=43");
			if (kind === "same-count-value")
				db.exec("UPDATE oidc_providers SET clientId='changed' WHERE id=43");
			let copied = false;
			if (kind === "copy-corruption") {
				const original = db.exec;
				vi.spyOn(db, "exec").mockImplementation((sql: string) => {
					const result = original.call(db, sql);
					if (sql.startsWith('INSERT INTO main."ArrOidcProviderSchemaMigration"')) {
						copied = true;
						original.call(
							db,
							"UPDATE ArrOidcProviderSchemaMigration SET clientId='corrupted' WHERE id=43",
						);
					}
					return result;
				});
			}
			const beforeApply = snapshot(db);
			await expect(
				applySqliteOidcPredecessorMigration(db, prepared, async () => {}),
			).rejects.toThrow();
			vi.restoreAllMocks();
			if (kind === "copy-corruption") expect(copied).toBe(true);
			else expect(snapshot(db)).toEqual(beforeApply);
			db.exec("ROLLBACK; BEGIN EXCLUSIVE");
			expect(snapshot(db)).toEqual(saved);
		},
	);
	it("retains 64-bit IDs, embedded NUL and invalid UTF8 TEXT bytes, BLOB ciphertext, INTEGER and REAL storage classes", async () => {
		db.exec(`UPDATE oidc_providers SET displayName=CAST(x'610062ff' AS TEXT),
		 encryptedClientSecret=x'00ff807361766564', enabled=9223372036854775806,
		 createdAt=1.2345678901234567, updatedAt=CAST(x'610062' AS TEXT);
		 UPDATE oidc_providers SET id=9223372036854775806;`);
		const before = encoded(db);
		expect(before).toEqual([
			[
				9223372036854775806n,
				"text",
				"610062FF",
				"blob",
				"00FF807361766564",
				"integer",
				9223372036854775806n,
				"real",
				1.2345678901234567,
				"text",
				"a\0b",
			],
		]);
		await applySqliteOidcPredecessorMigration(db, plan(db)!, async () => {});
		expect(encoded(db)).toEqual(before);
		expect(
			db
				.prepare("SELECT seq FROM sqlite_sequence WHERE name='oidc_providers'")
				.safeIntegers()
				.get(),
		).toEqual({ seq: 9223372036854775806n });
	});
	it("refuses unsupported nonfinite REAL evidence rather than changing its value", () => {
		db.exec("UPDATE oidc_providers SET enabled=1e999");
		const before = snapshot(db);
		expect(() => plan(db)).toThrow("Database schema upgrade is unavailable.");
		expect(snapshot(db)).toEqual(before);
	});
	it("leaves missing and canonical OIDC on the strict ordinary planner path", () => {
		db.exec("DROP TABLE oidc_providers");
		expect(plan(db)).toBeNull();
		expect(prepareRuntimeSchemaExecution(registry, catalog(db)).result).toBe("upgrade");
	});
	it("plans under native query-only mode and refuses an actual read-only apply without writes", async () => {
		db.pragma("query_only=ON");
		const before = snapshot(db),
			prepared = plan(db)!;
		expect(snapshot(db)).toEqual(before);
		await expect(
			applySqliteOidcPredecessorMigration(db, prepared, async () => {}),
		).rejects.toThrow();
		expect(snapshot(db)).toEqual(before);
	});
	it("detects a drop and identical source recreation through native schema-version evidence", async () => {
		const prepared = plan(db)!;
		db.exec(`DROP TABLE oidc_providers; ${legacySql} ${seedSql}`);
		const before = snapshot(db);
		await expect(
			applySqliteOidcPredecessorMigration(db, prepared, async () => {}),
		).rejects.toThrow();
		expect(snapshot(db)).toEqual(before);
	});
	it.each([
		[
			"extra-column",
			(sql: string) =>
				sql.replace("updatedAt DATETIME NOT NULL", "updatedAt DATETIME NOT NULL, extra TEXT"),
		],
		["missing-column", (sql: string) => sql.replace(" clientId TEXT NOT NULL,", "")],
		["type", (sql: string) => sql.replace("displayName TEXT", "displayName BLOB")],
		["nullability", (sql: string) => sql.replace("displayName TEXT NOT NULL", "displayName TEXT")],
		["default", (sql: string) => sql.replace("DEFAULT 1", "DEFAULT 2")],
		[
			"primary-key",
			(sql: string) =>
				sql.replace("id INTEGER NOT NULL PRIMARY KEY", "id INT NOT NULL PRIMARY KEY"),
		],
		[
			"check",
			(sql: string) =>
				sql.replace(
					"displayName TEXT NOT NULL",
					"displayName TEXT NOT NULL CHECK(length(displayName)>0)",
				),
		],
		[
			"column-order",
			(sql: string) =>
				sql.replace(
					"displayName TEXT NOT NULL, clientId TEXT NOT NULL",
					"clientId TEXT NOT NULL, displayName TEXT NOT NULL",
				),
		],
	] as const)("refuses complete-schema %s drift, including an empty table", (_kind, alter) => {
		db.exec(`DROP TABLE oidc_providers; ${alter(legacySql)}`);
		const before = snapshot(db);
		expect(() => plan(db)).toThrow();
		expect(snapshot(db)).toEqual(before);
	});
	it.each([
		["index", "CREATE INDEX unexpected_oidc ON oidc_providers(clientId)"],
		[
			"trigger",
			"CREATE TRIGGER unexpected_oidc AFTER UPDATE ON oidc_providers BEGIN SELECT 1; END",
		],
		[
			"incoming-fk",
			"CREATE TABLE dependent(id INTEGER PRIMARY KEY,providerId INTEGER REFERENCES oidc_providers(id))",
		],
		["view", "CREATE VIEW dependent AS SELECT id FROM oidc_providers"],
		["quoted-view", 'CREATE VIEW dependent AS SELECT id FROM main."OIDC_PROVIDERS"'],
		[
			"foreign-trigger",
			"CREATE TABLE dependent(id INTEGER PRIMARY KEY); CREATE TRIGGER dependent_trigger AFTER INSERT ON dependent BEGIN SELECT id FROM oidc_providers; END",
		],
		[
			"temp-trigger",
			"CREATE TEMP TRIGGER dependent_trigger AFTER INSERT ON main.oidc_providers BEGIN SELECT 1; END",
		],
		["temp-view", "CREATE TEMP VIEW dependent AS SELECT id FROM main.oidc_providers"],
		["temp-shadow", "CREATE TEMP TABLE oidc_providers(id INTEGER)"],
		["stage-table", "CREATE TABLE ArrOidcProviderSchemaMigration(id INTEGER)"],
		["stage-case", "CREATE TABLE arroIdcProviderSchemaMigration(id INTEGER)"],
		["stage-view", "CREATE VIEW ArrOidcProviderSchemaMigration AS SELECT 1"],
		["stage-temp", "CREATE TEMP TABLE ArrOidcProviderSchemaMigration(id INTEGER)"],
		[
			"stage-trigger",
			"CREATE TRIGGER ArrOidcProviderSchemaMigration AFTER UPDATE ON oidc_providers BEGIN SELECT 1; END",
		],
	] as const)(
		"refuses %s dependencies and replacement collisions before any writes",
		(_kind, sql) => {
			db.exec(sql);
			const before = snapshot(db);
			expect(() => plan(db)).toThrow();
			expect(snapshot(db)).toEqual(before);
		},
	);
	it("refuses a case variant source rather than treating it as absent", () => {
		db.exec(
			'ALTER TABLE oidc_providers RENAME TO temporary_oidc; ALTER TABLE temporary_oidc RENAME TO "OIDC_PROVIDERS"',
		);
		expect(() => plan(db)).toThrow();
	});
	it("preserves compatible unrelated custom objects", async () => {
		db.exec(
			"CREATE TABLE unrelated(id INTEGER PRIMARY KEY); CREATE VIEW unrelated_view AS SELECT id FROM unrelated; CREATE TRIGGER unrelated_trigger AFTER INSERT ON unrelated BEGIN SELECT 'oidc_providers'; END",
		);
		const before = db
			.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name LIKE 'unrelated%' ORDER BY name")
			.all();
		await applySqliteOidcPredecessorMigration(db, plan(db)!, async () => {});
		expect(
			db
				.prepare(
					"SELECT type,name,sql FROM sqlite_schema WHERE name LIKE 'unrelated%' ORDER BY name",
				)
				.all(),
		).toEqual(before);
	});
	it("requires loaded registry authority and genuine unconsumed plan identity", async () => {
		for (const copied of [{ ...registry }, JSON.parse(JSON.stringify(registry))])
			expect(() => prepareSqliteOidcPredecessorMigration(db, copied, catalog(db))).toThrow();
		const prepared = plan(db)!;
		for (const forged of [{ ...prepared }, JSON.parse(JSON.stringify(prepared)), {}])
			await expect(
				applySqliteOidcPredecessorMigration(
					db,
					forged as SqliteOidcPredecessorPlan,
					async () => {},
				),
			).rejects.toThrow();
		await applySqliteOidcPredecessorMigration(db, prepared, async () => {});
		const after = snapshot(db);
		await expect(
			applySqliteOidcPredecessorMigration(db, prepared, async () => {}),
		).rejects.toThrow();
		expect(snapshot(db)).toEqual(after);
	});
	it("rejects foreign and inactive connections without consuming genuine authority", async () => {
		const prepared = plan(db)!;
		const foreign = new Database(":memory:");
		try {
			foreign.pragma("foreign_keys=ON");
			foreign.exec(`${legacySql} BEGIN EXCLUSIVE`);
			await expect(
				applySqliteOidcPredecessorMigration(foreign, prepared, async () => {}),
			).rejects.toThrow();
			await applySqliteOidcPredecessorMigration(db, prepared, async () => {});
		} finally {
			if (foreign.inTransaction) foreign.exec("ROLLBACK");
			foreign.close();
		}
		db.exec("ROLLBACK; BEGIN EXCLUSIVE");
		const inactive = plan(db)!;
		db.exec("ROLLBACK");
		await expect(
			applySqliteOidcPredecessorMigration(db, inactive, async () => {}),
		).rejects.toThrow();
		expect(() => plan(db)).toThrow();
	});
	it.each([
		["same-count-value", "UPDATE oidc_providers SET encryptedClientSecret='changed'"],
		["row-count", "DELETE FROM oidc_providers"],
		["schema", "ALTER TABLE oidc_providers ADD COLUMN extra TEXT"],
		["dependency", "CREATE VIEW changed_view AS SELECT id FROM oidc_providers"],
		["temporary-dependency", "CREATE TEMP VIEW changed_view AS SELECT id FROM main.oidc_providers"],
		["unrelated-schema", "CREATE TABLE unrelated(id INTEGER)"],
	] as const)(
		"refuses %s drift at execution time and retains the drifted source",
		async (_kind, sql) => {
			const prepared = plan(db)!;
			db.exec(sql);
			const before = snapshot(db);
			await expect(
				applySqliteOidcPredecessorMigration(db, prepared, async () => {}),
			).rejects.toThrow();
			expect(snapshot(db)).toEqual(before);
		},
	);
	it.each([1, 2, 3, 4, 5])(
		"rolls back owner loss at consequential checkpoint %s",
		async (checkpoint) => {
			const before = snapshot(db),
				prepared = plan(db)!;
			let calls = 0;
			await expect(
				applySqliteOidcPredecessorMigration(db, prepared, async () => {
					if (++calls === checkpoint) throw new Error("private owner error");
				}),
			).rejects.toThrow("Database schema upgrade is unavailable.");
			db.exec("ROLLBACK; BEGIN EXCLUSIVE");
			expect(snapshot(db)).toEqual(before);
		},
	);
	it("revalidates same-count value changes after an awaited ownership check", async () => {
		const prepared = plan(db)!;
		await expect(
			applySqliteOidcPredecessorMigration(db, prepared, async () => {
				await Promise.resolve();
				db.exec("UPDATE oidc_providers SET clientId='changed'");
			}),
		).rejects.toThrow();
		expect(db.prepare("SELECT clientId FROM oidc_providers").get()).toEqual({
			clientId: "changed",
		});
		expect(
			db
				.prepare("SELECT name FROM sqlite_schema WHERE name='ArrOidcProviderSchemaMigration'")
				.get(),
		).toBeUndefined();
	});
	it("refuses before copying after the ownership callback ends the transaction", async () => {
		await expect(
			applySqliteOidcPredecessorMigration(db, plan(db)!, async () => {
				db.exec("ROLLBACK");
			}),
		).rejects.toThrow();
		expect(
			db
				.prepare("SELECT name FROM sqlite_schema WHERE name='ArrOidcProviderSchemaMigration'")
				.get(),
		).toBeUndefined();
	});
	it("does not let concurrent application consume one token twice", async () => {
		const prepared = plan(db)!;
		let release!: () => void;
		const barrier = new Promise<void>((done) => {
			release = done;
		});
		const first = applySqliteOidcPredecessorMigration(db, prepared, async () => {
			await barrier;
		});
		await expect(
			applySqliteOidcPredecessorMigration(db, prepared, async () => {}),
		).rejects.toThrow();
		release();
		await first;
	});
	it("refuses typed-copy coercion or corruption and leaves enclosing transaction rollback honest", async () => {
		const prepared = plan(db)!,
			before = snapshot(db);
		const original = db.exec;
		vi.spyOn(db, "exec").mockImplementation((sql: string) => {
			const result = original.call(db, sql);
			if (sql.startsWith("INSERT INTO main."))
				original.call(
					db,
					"UPDATE ArrOidcProviderSchemaMigration SET encryptedClientSecret=x'00ff'",
				);
			return result;
		});
		await expect(
			applySqliteOidcPredecessorMigration(db, prepared, async () => {}),
		).rejects.toThrow();
		vi.restoreAllMocks();
		db.exec("ROLLBACK; BEGIN EXCLUSIVE");
		expect(snapshot(db)).toEqual(before);
	});
	it("refuses a closed native connection before creating a replacement", async () => {
		const prepared = plan(db)!;
		db.exec("ROLLBACK");
		db.close();
		await expect(
			applySqliteOidcPredecessorMigration(db, prepared, async () => {}),
		).rejects.toThrow();
		// Restore only the test-owned descriptor so ordinary fixture cleanup remains valid.
		db = new Database(":memory:");
	});
});

describe.skipIf(process.platform !== "linux")(
	"native OIDC startup rollback and child lifecycle",
	() => {
		let directory: string, path: string, url: string;
		const actors = new Map<
			ChildProcess,
			Promise<{ code: number | null; signal: NodeJS.Signals | null }>
		>();
		beforeEach(() => {
			directory = mkdtempSync(join(tmpdir(), "arr-native-oidc-"));
			chmodSync(directory, 0o700);
			path = join(directory, "fixture.sqlite");
			url = `file:${path}`;
			const db = new Database(path);
			db.exec(`${legacySql} ${seedSql}`);
			db.close();
			chmodSync(path, 0o600);
		});
		afterEach(async () => {
			vi.restoreAllMocks();
			for (const [actor, closed] of actors) {
				if (actor.exitCode === null && actor.signalCode === null) actor.kill("SIGKILL");
				await closed;
			}
			actors.clear();
			rmSync(directory, { recursive: true, force: true });
		});
		const read = <T>(operation: (db: Database.Database) => T): T => {
			const db = new Database(path, { fileMustExist: true, timeout: 0 });
			try {
				return operation(db);
			} finally {
				db.close();
			}
		};
		const before = () => read(snapshot);
		const canonical = () =>
			read((db) =>
				(
					db.prepare("SELECT sql FROM sqlite_schema WHERE name='oidc_providers'").get() as {
						sql: string;
					}
				).sql.includes("AUTOINCREMENT"),
			);
		const ready = () =>
			read((db) => db.prepare("SELECT count(*) AS n FROM ArrSchemaMigrationReceipt").get());
		const seedEnrolledLegacy = async () => {
			await synchronizeSqliteRuntimeSchema(url);
			read((db) => {
				db.exec(`DROP TABLE oidc_providers; ${legacySql} ${seedSql}`);
			});
		};
		it.each([
			["single-quoted-view", "CREATE VIEW dependent AS SELECT id FROM 'oidc_providers'"],
			["qualified-view", "CREATE VIEW dependent AS SELECT id FROM main.'oidc_providers'"],
			["quoted-schema-view", "CREATE VIEW dependent AS SELECT id FROM 'main'.'OIDC_PROVIDERS'"],
			[
				"joined-view",
				"CREATE VIEW dependent AS SELECT p.id FROM unrelated JOIN 'oidc_providers' AS p",
			],
			[
				"comma-view",
				"CREATE VIEW dependent AS SELECT p.id FROM unrelated AS u, 'oidc_providers' AS p",
			],
			[
				"quoted-alias-double-select",
				`CREATE VIEW dependent AS SELECT p.id FROM unrelated AS "SELECT", 'oidc_providers' AS p`,
			],
			[
				"quoted-alias-backtick-select",
				"CREATE VIEW dependent AS SELECT p.id FROM unrelated AS `SELECT`, 'oidc_providers' AS p",
			],
			[
				"quoted-alias-bracket-select",
				"CREATE VIEW dependent AS SELECT p.id FROM unrelated AS [SELECT], 'oidc_providers' AS p",
			],
			[
				"quoted-alias-double-where",
				`CREATE VIEW dependent AS SELECT p.id FROM unrelated AS "WHERE", 'oidc_providers' AS p`,
			],
			[
				"quoted-alias-backtick-where",
				"CREATE VIEW dependent AS SELECT p.id FROM unrelated AS `WHERE`, 'oidc_providers' AS p",
			],
			[
				"quoted-alias-bracket-where",
				"CREATE VIEW dependent AS SELECT p.id FROM unrelated AS [WHERE], 'oidc_providers' AS p",
			],
			[
				"quoted-alias-double-parenthesis",
				`CREATE VIEW dependent AS SELECT p.id FROM unrelated AS "(", 'oidc_providers' AS p`,
			],
			[
				"quoted-alias-backtick-parenthesis",
				"CREATE VIEW dependent AS SELECT p.id FROM unrelated AS `(`, 'oidc_providers' AS p",
			],
			[
				"quoted-alias-bracket-parenthesis",
				"CREATE VIEW dependent AS SELECT p.id FROM unrelated AS [(], 'oidc_providers' AS p",
			],
			["grouped-view", "CREATE VIEW dependent AS SELECT id FROM (('oidc_providers'))"],
			[
				"replacement-view",
				"CREATE VIEW dependent AS SELECT id FROM 'ArrOidcProviderSchemaMigration'",
			],
			[
				"single-quoted-foreign-trigger",
				"CREATE TRIGGER dependent AFTER INSERT ON unrelated BEGIN SELECT id FROM 'oidc_providers'; END",
			],
			[
				"qualified-foreign-trigger",
				"CREATE TRIGGER dependent AFTER INSERT ON unrelated BEGIN SELECT id FROM main.'oidc_providers'; END",
			],
			[
				"updating-foreign-trigger",
				"CREATE TRIGGER dependent AFTER INSERT ON unrelated BEGIN UPDATE 'oidc_providers' SET enabled=enabled; END",
			],
			[
				"conflict-updating-foreign-trigger",
				"CREATE TRIGGER dependent AFTER INSERT ON unrelated BEGIN UPDATE OR IGNORE 'oidc_providers' SET enabled=enabled; END",
			],
			[
				"replacement-foreign-trigger",
				"CREATE TRIGGER dependent AFTER INSERT ON unrelated BEGIN SELECT id FROM 'ArrOidcProviderSchemaMigration'; END",
			],
		] as const)(
			"OIDC-PREFLIGHT-001 refuses %s before cold coordination or DDL",
			async (_kind, sql) => {
				read((db) =>
					db.exec(
						`CREATE TABLE unrelated(id INTEGER PRIMARY KEY); INSERT INTO unrelated VALUES(7); ${sql}`,
					),
				);
				const originalState = before();
				await expect(synchronizeSqliteRuntimeSchema(url)).rejects.toMatchObject({
					category: "startup-unavailable",
				});
				expect(before()).toEqual(originalState);
				expect(read((db) => db.prepare("SELECT id FROM unrelated").all())).toEqual([{ id: 7 }]);
				expect(existsSync(`${path}.arr-restore-runtime`)).toBe(false);
				expect(
					read((db) =>
						db
							.prepare(
								"SELECT name FROM sqlite_schema WHERE name IN ('ArrOidcProviderSchemaMigration','ArrSchemaMigrationReceipt')",
							)
							.all(),
					),
				).toEqual([]);
				await expect(synchronizeSqliteRuntimeSchema(url)).rejects.toMatchObject({
					category: "startup-unavailable",
				});
				expect(before()).toEqual(originalState);
				expect(existsSync(`${path}.arr-restore-runtime`)).toBe(false);
			},
		);
		it("OIDC-PREFLIGHT-001 preserves harmless SELECT literals in unrelated views and foreign triggers", async () => {
			read((db) =>
				db.exec(`CREATE TABLE unrelated(id INTEGER PRIMARY KEY);
			 CREATE VIEW harmless AS SELECT 'oidc_providers' AS value,'ArrOidcProviderSchemaMigration' AS replacement;
			 CREATE VIEW harmless_expression AS SELECT coalesce(NULL,'oidc_providers') AS value FROM unrelated WHERE 'ArrOidcProviderSchemaMigration'<>'';
			 CREATE TRIGGER harmless_trigger AFTER INSERT ON unrelated BEGIN SELECT 'oidc_providers','ArrOidcProviderSchemaMigration'; END;`),
			);
			const savedRows = before().rows;
			expect(await synchronizeSqliteRuntimeSchema(url)).toEqual({
				apiPort: null,
				webPort: null,
				listenAddress: null,
			});
			expect(before().rows).toEqual(savedRows);
			expect(read((db) => db.prepare("SELECT * FROM harmless").get())).toEqual({
				value: "oidc_providers",
				replacement: "ArrOidcProviderSchemaMigration",
			});
			read((db) => db.exec("INSERT INTO unrelated VALUES(7)"));
			expect(read((db) => db.prepare("SELECT id FROM unrelated").all())).toEqual([{ id: 7 }]);
			expect(read((db) => db.prepare("SELECT * FROM harmless_expression").all())).toEqual([
				{ value: "oidc_providers" },
			]);
			expect(canonical()).toBe(true);
		});
		it("OIDC-PREFLIGHT-001 preserves harmless literals beside quoted-alias columns and punctuation", async () => {
			read((db) =>
				db.exec(`CREATE TABLE unrelated(id INTEGER PRIMARY KEY,"WHERE" TEXT);
			 CREATE VIEW harmless_quoted AS SELECT "FROM"."WHERE" AS "(", 'oidc_providers' AS value FROM unrelated AS "FROM";
			 CREATE VIEW harmless_quoted_id AS SELECT "FROM"."id" AS "projection", 'oidc_providers' AS value FROM unrelated AS "FROM";
			 CREATE TRIGGER harmless_quoted_trigger AFTER INSERT ON unrelated BEGIN SELECT "NEW"."WHERE",'ArrOidcProviderSchemaMigration'; END;`),
			);
			const savedRows = before().rows;
			expect(await synchronizeSqliteRuntimeSchema(url)).toEqual({
				apiPort: null,
				webPort: null,
				listenAddress: null,
			});
			expect(before().rows).toEqual(savedRows);
			read((db) => db.exec(`INSERT INTO unrelated VALUES(7,'synthetic')`));
			expect(read((db) => db.prepare("SELECT * FROM harmless_quoted").get())).toEqual({
				"(": "synthetic",
				value: "oidc_providers",
			});
			expect(read((db) => db.prepare("SELECT * FROM harmless_quoted_id").get())).toEqual({
				projection: 7,
				value: "oidc_providers",
			});
			expect(canonical()).toBe(true);
		});
		const actorAt = async (
			action:
				| "after-create"
				| "after-copy"
				| "after-drop"
				| "after-rename"
				| "before-commit"
				| "after-acknowledged-commit"
				| "hold-shared",
		) => {
			const actor = fork(
				fileURLToPath(
					new URL("./fixtures/runtime-schema-oidc-migration-actor.ts", import.meta.url),
				),
				[],
				{
					execArgv: ["--import", import.meta.resolve("tsx/esm")],
					stdio: ["ignore", "pipe", "pipe", "ipc"],
					env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", TZ: "UTC" },
				},
			);
			const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
				(done, reject) => {
					actor.once("error", reject);
					actor.once("close", (code, signal) => done({ code, signal }));
				},
			);
			actors.set(actor, closed);
			const checkpoint = new Promise<void>((done, reject) => {
				const timer = setTimeout(() => {
					actor.kill("SIGKILL");
					reject(new Error("OIDC child checkpoint deadline exceeded"));
				}, 10000);
				let stderr = 0;
				actor.stderr!.on("data", (bytes) => {
					stderr += bytes.length;
					if (stderr > 1024) actor.kill("SIGKILL");
				});
				actor.stdout!.on("data", () => {
					actor.kill("SIGKILL");
				});
				actor.once("message", (message) => {
					clearTimeout(timer);
					if (
						message &&
						typeof message === "object" &&
						"category" in message &&
						message.category === "native-checkpoint"
					)
						done();
					else reject(new Error("Unexpected OIDC child result"));
				});
				actor.once("close", () => {
					clearTimeout(timer);
					reject(new Error("OIDC child closed before checkpoint"));
				});
			});
			actor.send({ path, action });
			await checkpoint;
			return { actor, closed };
		};
		it("normalizes approved legacy dates in the same startup transaction while preserving OIDC credentials and IDs", async () => {
			read((db) =>
				db.exec("UPDATE oidc_providers SET createdAt=0,updatedAt='1970-01-01 00:00:00'"),
			);
			expect(await synchronizeSqliteRuntimeSchema(url)).toEqual({
				apiPort: null,
				webPort: null,
				listenAddress: null,
			});
			expect(canonical()).toBe(true);
			expect(
				read((db) =>
					db
						.prepare(
							"SELECT id,encryptedClientSecret,clientSecretIv,typeof(createdAt) AS dateType,createdAt,updatedAt FROM oidc_providers",
						)
						.get(),
				),
			).toEqual({
				id: 41,
				encryptedClientSecret: "opaque-ciphertext",
				clientSecretIv: "opaque-iv",
				dateType: "text",
				createdAt: "1970-01-01T00:00:00.000+00:00",
				updatedAt: "1970-01-01T00:00:00.000+00:00",
			});
			await synchronizeSqliteRuntimeSchema(url);
		});
		it("refuses unsupported legacy date evidence before coordination creation or allocator conversion", async () => {
			read((db) => db.exec("UPDATE oidc_providers SET createdAt='not-a-date'"));
			const originalState = before();
			await expect(synchronizeSqliteRuntimeSchema(url)).rejects.toMatchObject({
				category: "format-migration-required",
			});
			expect(before()).toEqual(originalState);
			expect(existsSync(`${path}.arr-restore-runtime`)).toBe(false);
		});
		it.each(["create", "copy", "drop", "rename", "commit"] as const)(
			"rolls back a real SQLite error before %s, including already completed OIDC DDL",
			async (stage) => {
				await seedEnrolledLegacy();
				const originalState = before();
				const receipt = ready();
				const original = Database.prototype.exec;
				let hit = false;
				vi.spyOn(Database.prototype, "exec").mockImplementation(function (
					this: Database.Database,
					sql: string,
				) {
					const match =
						stage === "create"
							? sql.startsWith('CREATE TABLE "ArrOidcProviderSchemaMigration"')
							: stage === "copy"
								? sql.startsWith('INSERT INTO main."ArrOidcProviderSchemaMigration"')
								: stage === "drop"
									? sql === 'DROP TABLE main."oidc_providers"'
									: stage === "rename"
										? sql.startsWith('ALTER TABLE main."ArrOidcProviderSchemaMigration"')
										: sql === "COMMIT";
					if (this.name === path && match) {
						hit = true;
						original.call(this, "INSERT INTO nonexistent_oidc_fixture VALUES(1)");
					}
					return original.call(this, sql);
				});
				await expect(synchronizeSqliteRuntimeSchema(url)).rejects.toMatchObject({
					category: stage === "commit" ? "commit-unknown" : "startup-unavailable",
				});
				vi.restoreAllMocks();
				expect(hit).toBe(true);
				expect(before()).toEqual(originalState);
				expect(ready()).toEqual(receipt);
				await synchronizeSqliteRuntimeSchema(url);
				expect(canonical()).toBe(true);
			},
		);
		it("rolls back a real native verification query error after copy, before dropping source", async () => {
			await seedEnrolledLegacy();
			const originalState = before(),
				receipt = ready();
			const originalExec = Database.prototype.exec,
				originalPrepare = Database.prototype.prepare;
			let copied = false,
				hit = false;
			vi.spyOn(Database.prototype, "exec").mockImplementation(function (
				this: Database.Database,
				sql: string,
			) {
				const result = originalExec.call(this, sql);
				if (
					this.name === path &&
					sql.startsWith('INSERT INTO main."ArrOidcProviderSchemaMigration"')
				)
					copied = true;
				return result;
			});
			vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
				this: Database.Database,
				sql: string,
			) {
				if (
					this.name === path &&
					copied &&
					sql.includes('FROM main."ArrOidcProviderSchemaMigration" ORDER BY')
				) {
					hit = true;
					return originalPrepare.call(this, "SELECT nonexistent_oidc_column FROM oidc_providers");
				}
				return originalPrepare.call(this, sql);
			});
			await expect(synchronizeSqliteRuntimeSchema(url)).rejects.toMatchObject({
				category: "startup-unavailable",
			});
			vi.restoreAllMocks();
			expect(hit).toBe(true);
			expect(before()).toEqual(originalState);
			expect(ready()).toEqual(receipt);
		});
		it("keeps commit acknowledgement loss unknown after real OIDC commit, without retrying COMMIT", async () => {
			await seedEnrolledLegacy();
			const savedRows = before().rows;
			const receipt = ready() as { n: number };
			const original = Database.prototype.exec;
			let commits = 0;
			vi.spyOn(Database.prototype, "exec").mockImplementation(function (
				this: Database.Database,
				sql: string,
			) {
				const result = original.call(this, sql);
				if (this.name === path && sql === "COMMIT") {
					commits++;
					throw new Error("private synthetic acknowledgement loss");
				}
				return result;
			});
			await expect(synchronizeSqliteRuntimeSchema(url)).rejects.toMatchObject({
				category: "commit-unknown",
			});
			vi.restoreAllMocks();
			expect(commits).toBe(1);
			expect(canonical()).toBe(true);
			expect(before().rows).toEqual(savedRows);
			expect(ready()).toEqual({ n: receipt.n + 1 });
			await synchronizeSqliteRuntimeSchema(url);
			expect(ready()).toEqual({ n: receipt.n + 2 });
		});
		it.each(["after-create", "after-copy", "after-drop", "after-rename", "before-commit"] as const)(
			"SIGKILL at %s preserves the legacy main schema and rows without cold-marker repair",
			async (action) => {
				const original = before();
				const { actor, closed } = await actorAt(action);
				await expect(synchronizeSqliteRuntimeSchema(url)).rejects.toMatchObject({
					category: "startup-unavailable",
				});
				actor.kill("SIGKILL");
				expect(await closed).toMatchObject({ signal: "SIGKILL" });
				expect(before()).toEqual(original);
				expect(canonical()).toBe(false);
				expect(existsSync(`${path}.arr-restore-runtime`)).toBe(true);
				await expect(synchronizeSqliteRuntimeSchema(url)).rejects.toMatchObject({
					category: "startup-unavailable",
				});
				expect(before()).toEqual(original);
			},
		);
		it("retains canonical values after acknowledged commit and joins the killed child before retry", async () => {
			const original = before().rows;
			const { actor, closed } = await actorAt("after-acknowledged-commit");
			expect(canonical()).toBe(true);
			expect(before().rows).toEqual(original);
			expect(ready()).toEqual({ n: 1 });
			actor.kill("SIGKILL");
			await closed;
			await synchronizeSqliteRuntimeSchema(url);
			expect(ready()).toEqual({ n: 2 });
			expect(before().rows).toEqual(original);
		});
		it("blocks the OIDC writer under a real child-held shared admission and retries after release", async () => {
			await seedEnrolledLegacy();
			const original = before();
			const receipt = ready();
			const { actor, closed } = await actorAt("hold-shared");
			await expect(synchronizeSqliteRuntimeSchema(url)).rejects.toMatchObject({
				category: "startup-unavailable",
			});
			expect(before()).toEqual(original);
			expect(ready()).toEqual(receipt);
			actor.send({ category: "close" });
			expect(await closed).toEqual({ code: 0, signal: null });
			await synchronizeSqliteRuntimeSchema(url);
			expect(canonical()).toBe(true);
			const owner = await acquireSqliteRestoreRuntimeOwnership(url);
			try {
				expect(await owner.tryAcquireExclusive()).toBe(true);
			} finally {
				await owner.close();
			}
		});
	},
);
