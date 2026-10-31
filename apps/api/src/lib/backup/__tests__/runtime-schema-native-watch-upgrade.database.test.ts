import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { readSqliteRuntimeSchemaCatalog } from "../runtime-schema-sqlite.js";
import {
	loadRuntimeSchemaRegistry,
	prepareRuntimeSchemaExecution,
} from "../runtime-schema-registry.js";

const table = "jellyfin_native_watch_scope_receipts";
const seed = `
INSERT INTO "User" ("id","username","updatedAt") VALUES ('owner','synthetic-owner','2026-10-19T12:00:00Z');
INSERT INTO "ServiceInstance" ("id","userId","service","label","baseUrl","encryptedApiKey","encryptionIv","updatedAt") VALUES ('instance','owner','JELLYFIN','Synthetic','http://synthetic.invalid','synthetic-cipher','synthetic-iv','2026-10-19T12:00:00Z');
INSERT INTO "jellyfin_native_watch_scope_receipts" ("id","instanceId","runId","userKeyDigest","libraryId","expectedRawCount","observedRawCount","exact","contentFingerprint","observedAt","connectionGeneration","identityGeneration") VALUES ('receipt','instance','old-run','synthetic-digest','synthetic-library',1,1,true,'${"a".repeat(64)}','2026-10-19T12:00:00Z',1,2);
INSERT INTO "jellyfin_native_watch_rows" ("id","instanceId","runId","userKeyDigest","libraryId","jellyfinId","seriesId","seasonNumber","episodeNumber","played","observedAt","connectionGeneration","identityGeneration") VALUES ('watch','instance','old-run','synthetic-digest','synthetic-library','synthetic-episode','synthetic-series',1,1,false,'2026-10-19T12:00:00Z',1,2);
`;

describe("native watch nullable diagnostic upgrade on populated synthetic SQLite", () => {
	it("adds only the receipt column, preserves rows and all table root pages, and rolls back failure", async () => {
		const db = new Database(":memory:");
		try {
			db.pragma("foreign_keys=ON");
			const registry = loadRuntimeSchemaRegistry("sqlite");
			const names = registry.tables.map((d) => d.target.name);
			db.exec("BEGIN EXCLUSIVE");
			await prepareRuntimeSchemaExecution(
				registry,
				readSqliteRuntimeSchemaCatalog(db, names),
			).execute((sql) => {
				db.exec(sql);
			});
			db.exec("COMMIT");
			db.exec(`ALTER TABLE "${table}" DROP COLUMN "diagnosticsJson";`);
			db.exec(seed);
			const rows = db.prepare(`SELECT * FROM "${table}"`).all();
			const identities = db
				.prepare("SELECT name, rootpage FROM sqlite_schema WHERE type='table' ORDER BY name")
				.all();
			db.exec("BEGIN EXCLUSIVE");
			const rejected = prepareRuntimeSchemaExecution(
				registry,
				readSqliteRuntimeSchemaCatalog(db, names),
			);
			await expect(
				rejected.execute(() => {
					throw new Error("synthetic upgrade failure");
				}),
			).rejects.toThrow();
			db.exec("ROLLBACK");
			expect(db.prepare(`SELECT * FROM "${table}"`).all()).toEqual(rows);
			db.exec("BEGIN EXCLUSIVE");
			const prepared = prepareRuntimeSchemaExecution(
				registry,
				readSqliteRuntimeSchemaCatalog(db, names),
			);
			expect(prepared.statementCount).toBe(1);
			const statements: string[] = [];
			await prepared.execute((sql) => {
				statements.push(sql);
				db.exec(sql);
			});
			expect(statements).toEqual([`ALTER TABLE "${table}" ADD COLUMN "diagnosticsJson" TEXT;`]);
			expect(db.prepare(`SELECT * FROM "${table}"`).all()).toEqual(
				rows.map((row) => ({ ...(row as object), diagnosticsJson: null })),
			);
			expect(
				db
					.prepare("SELECT name, rootpage FROM sqlite_schema WHERE type='table' ORDER BY name")
					.all(),
			).toEqual(identities);
			expect(db.prepare('SELECT "runId","played" FROM "jellyfin_native_watch_rows"').all()).toEqual(
				[{ runId: "old-run", played: 0 }],
			);
			expect(db.pragma("foreign_key_check")).toEqual([]);
			expect(
				prepareRuntimeSchemaExecution(registry, readSqliteRuntimeSchemaCatalog(db, names))
					.statementCount,
			).toBe(0);
			db.exec("COMMIT");
		} finally {
			db.close();
		}
	});
});
