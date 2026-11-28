import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkCompleteSqliteForeignKeys } from "../runtime-sqlite-foreign-key-check.js";

const stage = "provider_native_inventory_stage_items";
const seen = "provider_native_inventory_seen_items";
const pass = "provider_native_inventory_passes";
const qui = "qui_torrent_observations";

describe("complete SQLite FK checking with indexed reference groups", () => {
	let db: Database.Database;
	beforeEach(() => {
		db = new Database(":memory:");
		db.pragma("foreign_keys=OFF");
		db.exec(`CREATE TABLE "${pass}"(id TEXT PRIMARY KEY);
			CREATE TABLE User(id TEXT PRIMARY KEY);
			CREATE TABLE "${stage}"(id INTEGER PRIMARY KEY,passId TEXT REFERENCES "${pass}"(id),payload TEXT);
			CREATE INDEX stage_pass ON "${stage}"(passId,id);
			CREATE TABLE "${seen}"(id INTEGER PRIMARY KEY,passId TEXT REFERENCES "${pass}"(id),payload TEXT);
			CREATE INDEX seen_pass ON "${seen}"(passId,id);
			CREATE TABLE "${qui}"(userId TEXT,generation TEXT,infoHash TEXT,
				FOREIGN KEY(userId) REFERENCES User(id),PRIMARY KEY(userId,generation,infoHash));
			INSERT INTO "${pass}" VALUES('valid'); INSERT INTO User VALUES('owner');`);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		if (db.open) db.close();
	});
	function check() {
		db.pragma("foreign_keys=ON");
		db.exec("BEGIN EXCLUSIVE");
		try {
			return checkCompleteSqliteForeignKeys(db);
		} finally {
			db.exec("ROLLBACK");
		}
	}
	const nativeChecks = (calls: unknown[][]) =>
		calls.flatMap(([sql]) =>
			typeof sql === "string" && sql.includes("foreign_key_check") ? [sql] : [],
		);
	it("validates all three supported shapes without a native table scan", () => {
		db.exec(`INSERT INTO "${stage}" VALUES(1,'valid','wide'),(2,NULL,'null');
			INSERT INTO "${seen}" VALUES(1,'valid','wide');
			INSERT INTO "${qui}" VALUES('owner','one','hash');`);
		const pragma = vi.spyOn(db, "pragma");
		expect(check).not.toThrow();
		expect(nativeChecks(pragma.mock.calls)).toEqual([]);
	});
	it.each([stage, seen, qui])("rejects a missing parent for %s", (table) => {
		db.exec(
			table === qui
				? `INSERT INTO "${qui}" VALUES('missing','one','hash')`
				: `INSERT INTO "${table}" VALUES(1,'missing','wide')`,
		);
		expect(db.pragma("foreign_key_check")).toHaveLength(1);
		expect(check).toThrow("Database schema startup is unavailable");
	});
	it.each(["DELETE", "REPLACE"])("detects parent %s without changing child data", (action) => {
		db.exec(`INSERT INTO "${stage}" VALUES(1,'valid','wide')`);
		if (action === "DELETE") db.exec(`DELETE FROM "${pass}"`);
		else {
			db.exec(`ALTER TABLE "${pass}" ADD COLUMN alias TEXT; CREATE UNIQUE INDEX pass_unique ON "${pass}"(alias);
			UPDATE "${pass}" SET alias='same'; INSERT OR REPLACE INTO "${pass}"(id,alias) VALUES('replacement','same')`);
		}
		const before = db.prepare(`SELECT * FROM "${stage}"`).all();
		expect(check).toThrow();
		expect(db.prepare(`SELECT * FROM "${stage}"`).all()).toEqual(before);
	});
	it("retains native checks for every unrelated and composite FK table", () => {
		db.exec(`CREATE TABLE OtherParent(a INTEGER,b INTEGER,PRIMARY KEY(a,b));
			CREATE TABLE OtherChild(a INTEGER,b INTEGER,FOREIGN KEY(a,b) REFERENCES OtherParent(a,b));
			INSERT INTO OtherChild VALUES(NULL,999),(1,999);`);
		const pragma = vi.spyOn(db, "pragma");
		expect(check).toThrow();
		expect(nativeChecks(pragma.mock.calls)).toEqual(['main.foreign_key_check("OtherChild")']);
	});
	it.each([
		"missing",
		"partial",
		"expression",
		"expression-tail",
		"nocase",
		"nocase-tail",
		"descending",
	])("falls back for an unsupported %s child index", (variant) => {
		db.exec("DROP INDEX stage_pass");
		if (variant === "partial") db.exec(`CREATE INDEX stage_pass ON "${stage}"(passId) WHERE id>1`);
		if (variant === "expression") db.exec(`CREATE INDEX stage_pass ON "${stage}"(lower(passId))`);
		if (variant === "expression-tail")
			db.exec(`CREATE INDEX stage_pass ON "${stage}"(passId,lower(payload))`);
		if (variant === "nocase")
			db.exec(`CREATE INDEX stage_pass ON "${stage}"(passId COLLATE NOCASE)`);
		if (variant === "nocase-tail")
			db.exec(`CREATE INDEX stage_pass ON "${stage}"(passId,payload COLLATE NOCASE)`);
		if (variant === "descending") db.exec(`CREATE INDEX stage_pass ON "${stage}"(passId DESC)`);
		db.exec(`INSERT INTO "${stage}" VALUES(1,'missing','wide')`);
		const pragma = vi.spyOn(db, "pragma");
		expect(check).toThrow();
		expect(nativeChecks(pragma.mock.calls)).toContain(`main.foreign_key_check("${stage}")`);
	});
	it.each(["collation", "integer-parent", "multiple", "composite", "different-parent", "implicit"])(
		"retains native semantics for %s reference metadata",
		(variant) => {
			db.exec(`DROP TABLE "${stage}"; DROP TABLE "${seen}"; DROP TABLE "${pass}"`);
			if (variant === "collation") {
				db.exec(`CREATE TABLE "${pass}"(id TEXT COLLATE NOCASE PRIMARY KEY); INSERT INTO "${pass}" VALUES('valid');
			CREATE TABLE "${stage}"(id INTEGER PRIMARY KEY,passId TEXT REFERENCES "${pass}"(id));
			INSERT INTO "${stage}" VALUES(1,'VALID')`);
			} else if (variant === "integer-parent") {
				db.exec(`CREATE TABLE "${pass}"(id INTEGER PRIMARY KEY); INSERT INTO "${pass}" VALUES(1);
			CREATE TABLE "${stage}"(id INTEGER PRIMARY KEY,passId TEXT REFERENCES "${pass}"(id));
			INSERT INTO "${stage}" VALUES(1,'01')`);
			} else if (variant === "composite") {
				db.exec(`CREATE TABLE "${pass}"(id TEXT,extra TEXT,PRIMARY KEY(id,extra)); INSERT INTO "${pass}" VALUES('valid','extra');
			CREATE TABLE "${stage}"(id INTEGER PRIMARY KEY,passId TEXT,extra TEXT,FOREIGN KEY(passId,extra) REFERENCES "${pass}"(id,extra));
			INSERT INTO "${stage}" VALUES(1,'valid','extra')`);
			} else if (variant === "different-parent") {
				db.exec(`CREATE TABLE "${pass}"(id TEXT PRIMARY KEY);CREATE TABLE Different(id TEXT PRIMARY KEY);INSERT INTO Different VALUES('valid');
			CREATE TABLE "${stage}"(id INTEGER PRIMARY KEY,passId TEXT REFERENCES Different(id));INSERT INTO "${stage}" VALUES(1,'valid')`);
			} else {
				db.exec(`CREATE TABLE "${pass}"(id TEXT PRIMARY KEY);INSERT INTO "${pass}" VALUES('valid');
			CREATE TABLE "${stage}"(id INTEGER PRIMARY KEY,passId TEXT REFERENCES "${pass}"${variant === "implicit" ? "" : "(id)"},
			other TEXT${variant === "multiple" ? " REFERENCES User(id)" : ""});INSERT INTO "${stage}" VALUES(1,'valid',NULL)`);
			}
			db.exec(`CREATE INDEX stage_pass ON "${stage}"(passId)`);
			const pragma = vi.spyOn(db, "pragma");
			expect(check).not.toThrow();
			expect(nativeChecks(pragma.mock.calls)).toContain(`main.foreign_key_check("${stage}")`);
		},
	);
	it("checks late distinct keys using covering range seeks and parent PK lookups", () => {
		const insert = db.prepare(`INSERT INTO "${stage}" VALUES(?,?,'${"x".repeat(512)}')`);
		db.transaction(() => {
			for (let n = 0; n < 20000; n++) insert.run(n, "valid");
		})();
		const prepare = vi.spyOn(db, "prepare");
		expect(check).not.toThrow();
		const query = prepare.mock.calls
			.map(([sql]) => sql)
			.find((sql) => sql.startsWith("WITH RECURSIVE") && sql.includes(`main."${stage}"`));
		expect(query).toBeDefined();
		prepare.mockRestore();
		const plan = db.prepare(`EXPLAIN QUERY PLAN ${query!}`).all() as { detail: string }[];
		expect(plan.some((row) => row.detail.includes("COVERING INDEX stage_pass"))).toBe(true);
		expect(
			plan.some((row) => row.detail.includes("SEARCH") && row.detail.includes("passId>?")),
		).toBe(true);
		expect(plan.some((row) => row.detail.includes("SEARCH") && row.detail.includes("id=?"))).toBe(
			true,
		);
		db.pragma("foreign_keys=OFF");
		insert.run(20001, "zz-late-missing");
		expect(check).toThrow();
	});
	it("never reports success from a truncated distinct-key traversal", () => {
		const parent = db.prepare(`INSERT INTO "${pass}" VALUES(?)`),
			child = db.prepare(`INSERT INTO "${stage}" VALUES(?,?,'')`);
		db.transaction(() => {
			for (let n = 0; n < 100001; n++) {
				const key = `key-${String(n).padStart(6, "0")}`;
				parent.run(key);
				child.run(n, key);
			}
		})();
		const pragma = vi.spyOn(db, "pragma");
		expect(check).not.toThrow();
		expect(nativeChecks(pragma.mock.calls)).toContain(`main.foreign_key_check("${stage}")`);
		db.pragma("foreign_keys=OFF");
		child.run(2000000, "zz-after-cap-missing");
		expect(check).toThrow();
		expect(nativeChecks(pragma.mock.calls)).toHaveLength(2);
	});
	it("propagates native fallback failures and preserves transaction/data ownership", () => {
		db.exec(
			`CREATE TABLE Other(parent TEXT REFERENCES User(id));INSERT INTO Other VALUES('owner')`,
		);
		const pragma = db.pragma;
		vi.spyOn(db, "pragma").mockImplementation(function (this: Database.Database, sql, options) {
			if (sql.startsWith("main.foreign_key_check"))
				throw new Error("Synthetic native interruption");
			return pragma.call(this, sql, options);
		});
		const before = db.prepare("SELECT total_changes() AS n").get();
		expect(check).toThrow("Synthetic native interruption");
		expect(db.inTransaction).toBe(false);
		expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
	});
	it("agrees with native SQLite across text, blob, null and undecodable text values", () => {
		const values = [
			{ sql: "?", value: "A" },
			{ sql: "?", value: "a" },
			{ sql: "?", value: "01" },
			{ sql: "?", value: 1 },
			{ sql: "?", value: 1.5 },
			{ sql: "?", value: "" },
			{ sql: "?", value: null },
			{ sql: "?", value: Buffer.from([255]) },
			{ sql: "CAST(? AS TEXT)", value: Buffer.from([255]) },
			{ sql: "?", value: "\ufffd" },
			{ sql: "?", value: "a\0b" },
			{ sql: "?", value: Buffer.from([97, 0, 98]) },
		];
		for (const parent of values)
			for (const child of values) {
				db.pragma("foreign_keys=OFF");
				db.exec(`DELETE FROM "${stage}";DELETE FROM "${pass}"`);
				db.prepare(`INSERT INTO "${pass}" VALUES(${parent.sql})`).run(parent.value);
				db.prepare(`INSERT INTO "${stage}" VALUES(1,${child.sql},'')`).run(child.value);
				const invalid = (db.pragma("foreign_key_check") as unknown[]).length > 0;
				let failed = false;
				try {
					check();
				} catch {
					failed = true;
				}
				expect(failed).toBe(invalid);
			}
	});
});
