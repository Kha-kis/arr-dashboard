import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import {
	loadRuntimeSchemaRegistry,
	prepareRuntimeSchemaExecution,
} from "../runtime-schema-registry.js";
import { readSqliteRuntimeSchemaCatalog } from "../runtime-schema-sqlite.js";

describe("qUI independent observation additive upgrade on populated native SQLite", () => {
	it("adds only new tables/indexes, preserves old root pages/rows, rolls back partial failure then reruns idempotently", async () => {
		const db = new Database(":memory:");
		try {
			db.pragma("foreign_keys=ON");
			const registry = loadRuntimeSchemaRegistry("sqlite"),
				names = registry.tables.map((t) => t.target.name),
				added = ["qui_observation_publications", "qui_torrent_observations"];
			db.exec("BEGIN EXCLUSIVE");
			await prepareRuntimeSchemaExecution(
				registry,
				readSqliteRuntimeSchemaCatalog(db, names),
			).execute((sql) => {
				db.exec(sql);
			});
			db.exec("COMMIT");
			for (const table of added) db.exec(`DROP TABLE "${table}"`);
			db.exec(
				`INSERT INTO "User"("id","username","updatedAt") VALUES('owner','synthetic-owner','2026-10-25T00:00:00Z');INSERT INTO "ServiceInstance"("id","userId","service","label","baseUrl","encryptedApiKey","encryptionIv","updatedAt") VALUES('arr','owner','RADARR','Synthetic','http://synthetic.invalid','synthetic-cipher','synthetic-iv','2026-10-25T00:00:00Z');INSERT INTO "library_cache"("id","instanceId","arrItemId","itemType","title","data","infoHash","updatedAt") VALUES('parent','arr',1,'movie','Synthetic','{}','${"a".repeat(40)}','2026-10-25T00:00:00Z');`,
			);
			const rows = db.prepare('SELECT * FROM "library_cache"').all(),
				source = db.prepare('SELECT * FROM "ServiceInstance"').all(),
				roots = db
					.prepare("SELECT name,rootpage FROM sqlite_schema WHERE type='table' ORDER BY name")
					.all();
			db.exec("BEGIN EXCLUSIVE");
			let applied = 0;
			await expect(
				prepareRuntimeSchemaExecution(registry, readSqliteRuntimeSchemaCatalog(db, names)).execute(
					(sql) => {
						db.exec(sql);
						if (++applied === 1) throw new Error("INJECTED_ADDITIVE_UPGRADE_FAILURE");
					},
				),
			).rejects.toThrow("Database schema registry is unavailable.");
			db.exec("ROLLBACK");
			expect(applied).toBe(1);
			expect(
				db
					.prepare("SELECT name,rootpage FROM sqlite_schema WHERE type='table' ORDER BY name")
					.all(),
			).toEqual(roots);
			expect(db.prepare('SELECT * FROM "library_cache"').all()).toEqual(rows);
			db.exec("BEGIN EXCLUSIVE");
			const statements: string[] = [];
			await prepareRuntimeSchemaExecution(
				registry,
				readSqliteRuntimeSchemaCatalog(db, names),
			).execute((sql) => {
				statements.push(sql);
				db.exec(sql);
			});
			expect(statements.every((s) => /^CREATE (?:TABLE|UNIQUE INDEX|INDEX)/.test(s.trim()))).toBe(
				true,
			);
			for (const table of added)
				expect(
					db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name=?").get(table),
				).toEqual({ name: table });
			expect(db.prepare('SELECT * FROM "library_cache"').all()).toEqual(rows);
			expect(db.prepare('SELECT * FROM "ServiceInstance"').all()).toEqual(source);
			expect(
				db
					.prepare("SELECT name,rootpage FROM sqlite_schema WHERE type='table' ORDER BY name")
					.all()
					.filter((r) => !added.includes((r as { name: string }).name)),
			).toEqual(roots);
			expect(db.pragma("foreign_key_check")).toEqual([]);
			expect(
				prepareRuntimeSchemaExecution(registry, readSqliteRuntimeSchemaCatalog(db, names))
					.statementCount,
			).toBe(0);
			db.exec("COMMIT");
			expect(db.pragma("quick_check", { simple: true })).toBe("ok");
		} finally {
			db.close();
		}
	});
});
