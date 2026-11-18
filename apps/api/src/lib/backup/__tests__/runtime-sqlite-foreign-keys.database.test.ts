import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { synchronizeSqliteRuntimeSchema } from "../runtime-schema-sqlite.js";
import * as completeForeignKeys from "../runtime-sqlite-foreign-key-check.js";
import {
	prepareTrackedSqliteForeignKeySchema,
	validateTrackedSqliteForeignKeys,
} from "../runtime-sqlite-foreign-keys.js";

describe("foreign-key schema preparation before checkpointing", () => {
	let db: Database.Database;
	const binding = ["owned-descriptor", 123] as const;
	const validate = () =>
		validateTrackedSqliteForeignKeys(db, binding, undefined, { requirePreparedSchema: true });
	const objects = () =>
		db.prepare("SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name").all();
	const stamp = () => ({
		objects: objects(),
		cookie: db.pragma("main.schema_version", { simple: true }),
		changes: db.prepare("SELECT total_changes()").pluck().get(),
		state: db.prepare("SELECT * FROM ArrForeignKeyValidation").all(),
	});
	function dropInsertGuard() {
		const name = db
			.prepare(
				"SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='Child' AND sql LIKE '%BEFORE INSERT%'",
			)
			.pluck()
			.get() as string;
		db.exec(`DROP TRIGGER "${name}"`);
	}
	beforeEach(() => {
		db = new Database(":memory:");
		db.pragma("foreign_keys=ON");
		db.exec(`CREATE TABLE Parent(id INTEGER PRIMARY KEY);
			CREATE TABLE Child(id INTEGER PRIMARY KEY,parent INTEGER REFERENCES Parent(id),createdAt TEXT);
			INSERT INTO Parent VALUES(1); INSERT INTO Child VALUES(1,1,'2026-11-01T00:00:00.000Z');
			BEGIN EXCLUSIVE`);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		db.close();
	});
	it("requires preparation, leaves new evidence unvalidated, then seals the actual binding without DDL", () => {
		const original = objects();
		expect(validate).toThrow();
		expect(objects()).toEqual(original);
		const check = vi.spyOn(completeForeignKeys, "checkCompleteSqliteForeignKeys");
		prepareTrackedSqliteForeignKeySchema(db);
		expect(check).not.toHaveBeenCalled();
		expect(db.prepare("SELECT dirty,bindingDigest FROM ArrForeignKeyValidation").get()).toEqual({
			dirty: 1,
			bindingDigest: "0".repeat(64),
		});
		const prepared = objects();
		const schemaCookie = db.pragma("main.schema_version", { simple: true });
		expect(validate()).toBe("full");
		expect(check).toHaveBeenCalledTimes(1);
		expect(objects()).toEqual(prepared);
		expect(db.pragma("main.schema_version", { simple: true })).toBe(schemaCookie);
		expect(db.prepare("SELECT dirty,bindingDigest FROM ArrForeignKeyValidation").get()).toEqual({
			dirty: 0,
			bindingDigest: createHash("sha256").update(JSON.stringify(binding)).digest("hex"),
		});
		expect(validate()).toBe("reused");
		expect(check).toHaveBeenCalledTimes(1);
		expect(db.prepare("SELECT * FROM Child").all()).toEqual([
			{ id: 1, parent: 1, createdAt: "2026-11-01T00:00:00.000Z" },
		]);
	});
	it.each([false, true])(
		"does not write complete schema or proof when validated=%s",
		(validated) => {
			prepareTrackedSqliteForeignKeySchema(db);
			if (validated) validate();
			const before = stamp();
			prepareTrackedSqliteForeignKeySchema(db);
			expect(stamp()).toEqual(before);
		},
	);
	it.each(["missing", "renamed"])(
		"strict validation refuses %s guards without repairing them",
		(mode) => {
			prepareTrackedSqliteForeignKeySchema(db);
			validate();
			if (mode === "missing") dropInsertGuard();
			else db.exec("ALTER TABLE Child RENAME TO PriorChild");
			const before = stamp();
			const check = vi.spyOn(completeForeignKeys, "checkCompleteSqliteForeignKeys");
			expect(validate).toThrow();
			expect(stamp()).toEqual(before);
			expect(check).not.toHaveBeenCalled();
		},
	);
	it("prepares missing guards as dirty and rejects orphan data at final validation", () => {
		prepareTrackedSqliteForeignKeySchema(db);
		validate();
		db.exec("COMMIT");
		dropInsertGuard();
		db.pragma("foreign_keys=OFF");
		db.exec("INSERT INTO Child VALUES(2,999,'unchanged')");
		db.pragma("foreign_keys=ON");
		db.exec("BEGIN EXCLUSIVE");
		const rows = db.prepare("SELECT * FROM Child ORDER BY id").all();
		prepareTrackedSqliteForeignKeySchema(db);
		expect(db.prepare("SELECT dirty FROM ArrForeignKeyValidation").pluck().get()).toBe(1);
		expect(validate).toThrow();
		expect(db.prepare("SELECT dirty FROM ArrForeignKeyValidation").pluck().get()).toBe(1);
		expect(db.prepare("SELECT * FROM Child ORDER BY id").all()).toEqual(rows);
	});
	it("checks renamed guards before retirement and rolls preparation back with its caller", () => {
		prepareTrackedSqliteForeignKeySchema(db);
		validate();
		db.exec("COMMIT; ALTER TABLE Child RENAME TO PriorChild");
		const before = stamp();
		db.exec("BEGIN EXCLUSIVE");
		const check = vi
			.spyOn(completeForeignKeys, "checkCompleteSqliteForeignKeys")
			.mockImplementationOnce(() => {
				expect(stamp()).toEqual(before);
				throw new Error("Synthetic native interruption");
			});
		expect(() => prepareTrackedSqliteForeignKeySchema(db)).toThrow("Synthetic native interruption");
		expect(stamp()).toEqual(before);
		check.mockRestore();
		prepareTrackedSqliteForeignKeySchema(db);
		expect(db.prepare("SELECT dirty FROM ArrForeignKeyValidation").pluck().get()).toBe(1);
		expect(
			db
				.prepare(
					"SELECT COUNT(*) FROM sqlite_schema WHERE type='trigger' AND tbl_name='PriorChild'",
				)
				.pluck()
				.get(),
		).toBe(3);
		db.exec("ROLLBACK");
		expect(objects()).toEqual(before.objects);
		expect(db.prepare("SELECT * FROM ArrForeignKeyValidation").all()).toEqual(before.state);
	});
	it("does not retire renamed guards when the native FK check finds an orphan", () => {
		prepareTrackedSqliteForeignKeySchema(db);
		validate();
		db.exec("COMMIT");
		db.pragma("foreign_keys=OFF");
		db.exec("INSERT INTO Child VALUES(2,999,'unchanged'); ALTER TABLE Child RENAME TO PriorChild");
		db.pragma("foreign_keys=ON");
		db.exec("BEGIN EXCLUSIVE");
		const before = stamp();
		expect(() => prepareTrackedSqliteForeignKeySchema(db)).toThrow();
		expect(stamp()).toEqual(before);
		expect(db.prepare("SELECT parent FROM PriorChild WHERE id=2").pluck().get()).toBe(999);
	});
	it.each([
		"UPDATE ArrForeignKeyValidation SET dirty=7",
		"DELETE FROM ArrForeignKeyValidation",
		"CREATE TEMP TABLE Child(id INTEGER)",
		"CREATE TEMP TABLE pragma_foreign_keys(foreign_keys INTEGER)",
		"CREATE TABLE pragma_defer_foreign_keys(defer_foreign_keys INTEGER)",
		"PRAGMA defer_foreign_keys=ON",
	])("refuses malformed or shadowed evidence without repair: %s", (mutation) => {
		prepareTrackedSqliteForeignKeySchema(db);
		db.exec(mutation);
		const before = stamp();
		expect(() => prepareTrackedSqliteForeignKeySchema(db)).toThrow();
		expect(validate).toThrow();
		expect(stamp()).toEqual(before);
	});
});

describe.skipIf(process.platform !== "linux")("durable native foreign-key validation", () => {
	let directory: string;
	let path: string;
	let fullChecks: number;
	const start = () => synchronizeSqliteRuntimeSchema(`file:${path}`);
	function database<T>(run: (db: Database.Database) => T): T {
		const db = new Database(path);
		try {
			return run(db);
		} finally {
			db.close();
		}
	}
	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), "arr-fk-proof-"));
		chmodSync(directory, 0o700);
		path = join(directory, "main.db");
		await start();
		database((db) =>
			db.exec(`CREATE TABLE ProofParent(id INTEGER PRIMARY KEY, name TEXT UNIQUE);
			CREATE TABLE ProofChild(id INTEGER PRIMARY KEY, parent INTEGER REFERENCES ProofParent(id));
			CREATE TABLE ProofCompositeParent(a INTEGER,b INTEGER,PRIMARY KEY(a,b));
			CREATE TABLE ProofCompositeChild(id INTEGER PRIMARY KEY,a INTEGER,b INTEGER,
				FOREIGN KEY(a,b) REFERENCES ProofCompositeParent(a,b));
			INSERT INTO ProofParent VALUES(1,'one'); INSERT INTO ProofChild VALUES(1,1);
			INSERT INTO ProofCompositeParent VALUES(1,2);
			INSERT INTO ProofCompositeChild VALUES(1,1,2),(2,NULL,999),(3,999,NULL);`),
		);
		await start();
		fullChecks = 0;
		const check = completeForeignKeys.checkCompleteSqliteForeignKeys;
		vi.spyOn(completeForeignKeys, "checkCompleteSqliteForeignKeys").mockImplementation((main) => {
			fullChecks++;
			return check(main);
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(directory, { recursive: true });
	});
	it("reuses a committed proof on an unchanged populated restart", async () => {
		await expect(start()).resolves.toMatchObject({ apiPort: null });
		expect(fullChecks).toBe(0);
		expect(
			database((db) => db.prepare("SELECT COUNT(*) AS n FROM ProofCompositeChild").get()),
		).toEqual({ n: 3 });
	});
	it("preserves reuse after enforced writes and rejected constraints", async () => {
		database((db) => {
			db.pragma("foreign_keys=ON");
			db.exec("INSERT INTO ProofChild VALUES(2,1),(3,NULL)");
			expect(() => db.exec("INSERT INTO ProofChild VALUES(4,999)")).toThrow();
		});
		await start();
		expect(fullChecks).toBe(0);
	});
	it("revalidates a valid outside unenforced write once before reusing again", async () => {
		database((db) => {
			db.pragma("foreign_keys=OFF");
			db.exec("INSERT INTO ProofChild VALUES(2,1)");
		});
		await start();
		expect(fullChecks).toBe(1);
		await start();
		expect(fullChecks).toBe(1);
	});
	it.each(["orphan", "parent-delete", "parent-replace", "deferred"])(
		"refuses %s corruption without changing rows",
		async (mode) => {
			database((db) => {
				if (mode === "deferred") {
					db.pragma("foreign_keys=ON");
					db.exec(
						"BEGIN; PRAGMA defer_foreign_keys=ON; INSERT INTO ProofChild VALUES(2,999); PRAGMA defer_foreign_keys=OFF; COMMIT",
					);
				} else {
					db.pragma("foreign_keys=OFF");
					db.exec(
						mode === "orphan"
							? "INSERT INTO ProofChild VALUES(2,999)"
							: mode === "parent-delete"
								? "DELETE FROM ProofParent WHERE id=1"
								: "INSERT OR REPLACE INTO ProofParent VALUES(2,'one')",
					);
				}
			});
			const before = database((db) => db.prepare("SELECT * FROM ProofChild ORDER BY id").all());
			await expect(start()).rejects.toThrow();
			expect(fullChecks).toBe(1);
			expect(database((db) => db.prepare("SELECT * FROM ProofChild ORDER BY id").all())).toEqual(
				before,
			);
			await expect(start()).rejects.toThrow();
		},
	);
	it("rolls back invalidation with its unenforced write", async () => {
		database((db) => {
			db.pragma("foreign_keys=OFF");
			db.exec("BEGIN; INSERT INTO ProofChild VALUES(2,999); ROLLBACK");
		});
		await start();
		expect(fullChecks).toBe(0);
	});
	it("rechecks changed schema and then reuses its new proof", async () => {
		database((db) => db.exec("CREATE INDEX proof_parent_lookup ON ProofChild(parent)"));
		await start();
		expect(fullChecks).toBe(1);
		await start();
		expect(fullChecks).toBe(1);
	});
	it.each(["ProofParent", "ProofChild"])(
		"revalidates renamed %s before reusing its new proof",
		async (target) => {
			database((db) => db.exec(`ALTER TABLE "${target}" RENAME TO "Renamed${target}"`));
			await expect(start()).resolves.toMatchObject({ apiPort: null });
			// Check before retiring renamed guards, then seal the final prepared schema.
			expect(fullChecks).toBe(2);
			expect(
				database((db) =>
					db
						.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='trigger' AND tbl_name=?")
						.get(`Renamed${target}`),
				),
			).toEqual({ n: 3 });
			await start();
			expect(fullChecks).toBe(2);
		},
	);
	it("does not trust a dropped trigger after an unenforced orphan write", async () => {
		database((db) => {
			const trigger = db
				.prepare(
					"SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='ProofChild' AND sql LIKE '%BEFORE INSERT%'",
				)
				.pluck()
				.get();
			expect(typeof trigger).toBe("string");
			db.exec(`DROP TRIGGER "${String(trigger).replaceAll('"', '""')}"`);
			db.pragma("foreign_keys=OFF");
			db.exec("INSERT INTO ProofChild VALUES(2,999)");
		});
		await expect(start()).rejects.toThrow();
	});
	it("revalidates a renamed child when normal DDL reuses its original table name", async () => {
		database((db) =>
			db.exec(`ALTER TABLE ProofChild RENAME TO PriorProofChild;
			CREATE TABLE ProofChild(id INTEGER PRIMARY KEY,parent INTEGER REFERENCES ProofParent(id));
			INSERT INTO ProofChild VALUES(2,1);`),
		);
		await expect(start()).resolves.toMatchObject({ apiPort: null });
		// Check before retiring renamed guards, then seal the final prepared schema.
		expect(fullChecks).toBe(2);
		expect(database((db) => db.prepare("SELECT * FROM PriorProofChild").all())).toEqual([
			{ id: 1, parent: 1 },
		]);
		expect(database((db) => db.prepare("SELECT * FROM ProofChild").all())).toEqual([
			{ id: 2, parent: 1 },
		]);
		await start();
		expect(fullChecks).toBe(2);
	});
	it("refuses a malformed proof without repairing it", async () => {
		database((db) => db.exec("UPDATE ArrForeignKeyValidation SET dirty=7"));
		await expect(start()).rejects.toThrow();
		expect(
			database((db) => db.prepare("SELECT dirty FROM ArrForeignKeyValidation").pluck().get()),
		).toBe(7);
	});
	it.each([
		["bindingDigest", "0".repeat(64)],
		["schemaDigest", "0".repeat(64)],
		["schemaCookie", 0],
		["sqliteVersion", "0.0.0"],
	] as const)(
		"revalidates a mismatched %s before sealing the current proof",
		async (field, value) => {
			database((db) => db.prepare(`UPDATE ArrForeignKeyValidation SET "${field}"=?`).run(value));
			await start();
			expect(fullChecks).toBe(1);
			await start();
			expect(fullChecks).toBe(1);
		},
	);
	it("invalidates proof after an identically recreated trigger", async () => {
		database((db) => {
			const trigger = db
				.prepare(
					"SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='ProofChild' AND sql LIKE '%BEFORE INSERT%'",
				)
				.get() as { name: string; sql: string };
			db.exec(`DROP TRIGGER "${trigger.name}"`);
			db.pragma("foreign_keys=OFF");
			db.exec("INSERT INTO ProofChild VALUES(2,999)");
			db.exec(trigger.sql);
		});
		await expect(start()).rejects.toThrow();
		expect(fullChecks).toBe(1);
	});
	it("refuses an altered owned trigger body instead of treating it as a rename", async () => {
		database((db) => {
			const name = db
				.prepare(
					"SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='ProofChild' AND sql LIKE '%BEFORE INSERT%'",
				)
				.pluck()
				.get() as string;
			db.exec(
				`DROP TRIGGER "${name}"; CREATE TRIGGER "${name}" BEFORE INSERT ON ProofChild BEGIN SELECT 1; END`,
			);
		});
		await expect(start()).rejects.toThrow();
		expect(fullChecks).toBe(0);
	});
	it("refuses a missing proof row and leaves the database unchanged", async () => {
		database((db) => db.exec("DELETE FROM ArrForeignKeyValidation"));
		await expect(start()).rejects.toThrow();
		expect(
			database((db) => db.prepare("SELECT COUNT(*) AS n FROM ArrForeignKeyValidation").get()),
		).toEqual({ n: 0 });
	});
	it("does not reuse proof across an unrecognized application trigger", async () => {
		database((db) =>
			db.exec(`CREATE TRIGGER unknown_proof_writer AFTER INSERT ON ProofChild
			BEGIN UPDATE ArrForeignKeyValidation SET dirty=0; END`),
		);
		await start();
		fullChecks = 0;
		database((db) => {
			db.pragma("foreign_keys=OFF");
			db.exec("INSERT INTO ProofChild VALUES(2,999)");
		});
		await expect(start()).rejects.toThrow();
		expect(fullChecks).toBe(1);
	});
	it("never seals an interrupted full check", async () => {
		database((db) => {
			db.pragma("foreign_keys=OFF");
			db.exec("INSERT INTO ProofChild VALUES(2,1)");
		});
		const pragma = Database.prototype.pragma;
		const interrupt = vi.spyOn(Database.prototype, "pragma").mockImplementation(function (
			this: Database.Database,
			source,
			options,
		) {
			if (source.startsWith("main.foreign_key_check"))
				throw new Error("Synthetic native interruption");
			return pragma.call(this, source, options);
		});
		await expect(start()).rejects.toThrow();
		interrupt.mockRestore();
		expect(
			database((db) => db.prepare("SELECT dirty FROM ArrForeignKeyValidation").pluck().get()),
		).toBe(1);
		await start();
	});
	it("refuses schema-trigger execution with trusted_schema off instead of weakening that setting", async () => {
		database((db) => {
			db.pragma("trusted_schema=OFF");
			db.pragma("foreign_keys=OFF");
			expect(() => db.exec("INSERT INTO ProofChild VALUES(2,999)")).toThrow();
			expect(db.pragma("trusted_schema", { simple: true })).toBe(0);
		});
		await start();
		expect(fullChecks).toBe(0);
	});
});
