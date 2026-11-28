import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeSchemaPlanError } from "../runtime-schema-catalog.js";
import { readSqliteRuntimeSchemaCatalog } from "../runtime-schema-sqlite.js";

describe("native SQLite runtime schema catalog", () => {
	let database: Database.Database;
	beforeEach(() => {
		database = new Database(":memory:");
		database.pragma("foreign_keys = ON");
	});
	afterEach(() => database.close());
	const read = (targets: readonly string[] = []) => {
		database.exec("BEGIN");
		try {
			return readSqliteRuntimeSchemaCatalog(database, targets);
		} finally {
			database.exec("ROLLBACK");
		}
	};
	const refuse = (targets: readonly string[] = []) => {
		expect(() => read(targets)).toThrow(RuntimeSchemaPlanError);
		try {
			read(targets);
		} catch (error) {
			expect(error).toMatchObject({ category: "unknown-schema-state" });
			expect(error).not.toHaveProperty("cause");
			expect(String(error)).not.toMatch(/Private|secret|SELECT|CREATE/);
		}
	};

	it("reports real row counts and native column semantics, not optimistic emptiness", () => {
		database.exec(`CREATE TABLE Parent(id TEXT NOT NULL PRIMARY KEY);
			CREATE TABLE Child(id INTEGER PRIMARY KEY, parentId TEXT,
				completedPages INTEGER NOT NULL DEFAULT (0), enabled BOOLEAN DEFAULT false,
				createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
				FOREIGN KEY(parentId) REFERENCES Parent(id) ON DELETE SET NULL ON UPDATE CASCADE);
			CREATE UNIQUE INDEX Child_parentId_key ON Child(parentId);
			INSERT INTO Parent VALUES('synthetic');
			INSERT INTO Child(parentId) VALUES('synthetic'),(NULL);`);
		const catalog = read(["Parent", "Child"]);
		expect(catalog.provider).toBe("sqlite");
		expect(catalog.tables.find((table) => table.name === "Child")).toEqual({
			name: "Child",
			rowCount: 2,
			columns: [
				{ name: "id", type: "INTEGER;ROWID", nullable: false, defaultValue: null },
				{ name: "parentId", type: "TEXT", nullable: true, defaultValue: null },
				{ name: "completedPages", type: "INTEGER", nullable: false, defaultValue: "0" },
				{ name: "enabled", type: "BOOLEAN", nullable: true, defaultValue: "FALSE" },
				{ name: "createdAt", type: "DATETIME", nullable: true, defaultValue: "CURRENT_TIMESTAMP" },
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
		expect(catalog.tables.find((table) => table.name === "Parent")?.indexes).toEqual([]);
	});

	it("does not call a nullable TEXT primary key non-null", () => {
		database.exec("CREATE TABLE Private(id TEXT PRIMARY KEY); INSERT INTO Private VALUES(NULL)");
		expect(read().tables[0]?.columns[0]?.nullable).toBe(true);
	});

	it("orders composite primary keys and implicit foreign-key targets by native ordinals", () => {
		database.exec(`CREATE TABLE Parent(a TEXT NOT NULL,b INTEGER NOT NULL,PRIMARY KEY(b,a)) WITHOUT ROWID;
			CREATE TABLE Child(id TEXT NOT NULL PRIMARY KEY,x INTEGER,y TEXT,
				FOREIGN KEY(x,y) REFERENCES Parent ON DELETE RESTRICT ON UPDATE NO ACTION);`);
		const catalog = read();
		expect(catalog.tables.find((table) => table.name === "Parent")?.primaryKey).toEqual(["b", "a"]);
		expect(catalog.tables.find((table) => table.name === "Child")?.foreignKeys).toEqual([
			{
				columns: ["x", "y"],
				targetTable: "Parent",
				targetColumns: ["b", "a"],
				onDelete: "RESTRICT",
				onUpdate: "NO ACTION",
			},
		]);
	});

	it("preserves ordinary extra tables and quoted names without executing name text", () => {
		database.exec(`CREATE TABLE "Private'""secret"("id""x" TEXT NOT NULL PRIMARY KEY);
			CREATE TABLE Marker(id INTEGER PRIMARY KEY); INSERT INTO Marker VALUES(7);`);
		expect(read().tables.map((table) => table.name)).toEqual(["Marker", "Private'\"secret"]);
		expect(database.prepare("SELECT id FROM Marker").get()).toEqual({ id: 7 });
	});

	it("does not change schema, data, foreign-key mode, or the caller's transaction", () => {
		database.exec("CREATE TABLE Marker(id INTEGER PRIMARY KEY); INSERT INTO Marker VALUES(7)");
		const schema = database.prepare("SELECT * FROM sqlite_schema").all();
		database.exec("BEGIN");
		readSqliteRuntimeSchemaCatalog(database, ["Marker"]);
		expect(database.inTransaction).toBe(true);
		expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
		expect(database.prepare("SELECT * FROM sqlite_schema").all()).toEqual(schema);
		expect(database.prepare("SELECT id FROM Marker").get()).toEqual({ id: 7 });
		database.exec("ROLLBACK");
	});

	it("requires a caller-owned snapshot instead of combining unrelated reads", () => {
		expect(() => readSqliteRuntimeSchemaCatalog(database, [])).toThrow(RuntimeSchemaPlanError);
	});

	it("refuses a target-name view rather than misclassifying it as a missing table", () => {
		database.exec("CREATE VIEW Private AS SELECT 1 AS id");
		refuse(["Private"]);
	});

	it("refuses case-insensitive target collisions", () => {
		database.exec("CREATE TABLE private(id INTEGER PRIMARY KEY)");
		refuse(["Private"]);
	});

	it("refuses temporary target shadowing", () => {
		database.exec(
			"CREATE TABLE Private(id INTEGER PRIMARY KEY); CREATE TEMP TABLE Private(id TEXT)",
		);
		refuse(["Private"]);
	});

	it("does not return zero rows when the native connection cannot be read", () => {
		database.close();
		expect(() => readSqliteRuntimeSchemaCatalog(database, [])).toThrow(RuntimeSchemaPlanError);
		database = new Database(":memory:");
	});

	it("refuses expression indexes whose key semantics cannot be represented", () => {
		database.exec(
			"CREATE TABLE Private(id INTEGER PRIMARY KEY,value TEXT); CREATE INDEX Private_expression ON Private(lower(value))",
		);
		refuse();
	});

	it("refuses descending or collated indexes rather than falsely equating keys", () => {
		database.exec(
			"CREATE TABLE Private(id INTEGER PRIMARY KEY,value TEXT); CREATE INDEX Private_desc ON Private(value DESC)",
		);
		refuse();
		database.exec(
			"DROP INDEX Private_desc; CREATE INDEX Private_collation ON Private(value COLLATE NOCASE)",
		);
		refuse();
	});

	it("reports partial-index predicates rather than equating them to complete indexes", () => {
		database.exec(
			"CREATE TABLE Private(id INTEGER PRIMARY KEY,value TEXT); CREATE INDEX Private_partial ON Private(value) WHERE value IS NOT NULL",
		);
		expect(read().tables[0]?.indexes[0]?.predicate).toBe("value IS NOT NULL");
	});

	it("refuses unrepresented table constraints rather than certifying weaker semantics", () => {
		database.exec("CREATE TABLE Private(id INTEGER PRIMARY KEY,value TEXT CHECK(length(value)>0))");
		refuse();
	});

	it("does not mistake constraint words inside string literals for SQL syntax", () => {
		database.exec(
			"CREATE TABLE Private(id INTEGER PRIMARY KEY,value TEXT DEFAULT 'CHECK COLLATE secret')",
		);
		expect(read().tables[0]?.columns[1]?.defaultValue).toBe("'CHECK COLLATE secret'");
	});

	it("distinguishes AUTOINCREMENT, rowid aliases, and ordinary INTEGER keys", () => {
		database.exec(`CREATE TABLE Auto(id INTEGER PRIMARY KEY AUTOINCREMENT);
			CREATE TABLE Rowid(id INTEGER PRIMARY KEY);
			CREATE TABLE Ordinary(id INTEGER PRIMARY KEY) WITHOUT ROWID;`);
		const catalog = read();
		expect(catalog.tables.find((table) => table.name === "Auto")?.columns[0]?.type).toBe(
			"INTEGER;ROWID;AUTOINCREMENT",
		);
		expect(catalog.tables.find((table) => table.name === "Rowid")?.columns[0]?.type).toBe(
			"INTEGER;ROWID",
		);
		expect(catalog.tables.find((table) => table.name === "Ordinary")?.columns[0]?.type).toBe(
			"INTEGER",
		);
		expect(catalog.tables.some((table) => table.name === "sqlite_sequence")).toBe(false);
	});

	it("refuses an implicit descending primary-key index instead of discarding its semantics", () => {
		database.exec("CREATE TABLE Private(id TEXT NOT NULL PRIMARY KEY DESC)");
		refuse();
	});

	it("retains quotes and nested parentheses in native literal defaults", () => {
		database.exec(
			`CREATE TABLE Private(id INTEGER PRIMARY KEY, value TEXT DEFAULT (('literal ) '' CHECK')))`,
		);
		expect(read().tables[0]?.columns[1]?.defaultValue).toBe("'literal ) '' CHECK'");
	});

	it("refuses deferred foreign keys whose enforcement timing is outside the projection", () => {
		database.exec(`CREATE TABLE Parent(id INTEGER PRIMARY KEY);
			CREATE TABLE Private(id INTEGER PRIMARY KEY,parentId INTEGER REFERENCES Parent(id) DEFERRABLE INITIALLY DEFERRED)`);
		refuse();
	});

	it("refuses unrepresented conflict policies instead of certifying ordinary constraints", () => {
		database.exec("CREATE TABLE Private(id TEXT NOT NULL PRIMARY KEY ON CONFLICT REPLACE)");
		refuse();
	});
});
