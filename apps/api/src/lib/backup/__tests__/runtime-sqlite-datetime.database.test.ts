import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteDateCompatibilityError } from "../../sqlite-datetime.js";
import {
	loadRuntimeSchemaRegistry,
	prepareRuntimeSchemaExecution,
} from "../runtime-schema-registry.js";
import { applySqliteRuntimeDates, planSqliteRuntimeDates } from "../runtime-sqlite-datetime.js";

const canonical = "2023-11-14T22:13:20.000+00:00";
const registry = loadRuntimeSchemaRegistry("sqlite");
const receiptSql = `CREATE TABLE ArrRuntimeDataFormatReceipt (
	id INTEGER NOT NULL PRIMARY KEY, formatVersion INTEGER NOT NULL,
	dateColumnsDigest TEXT NOT NULL, completedAt TEXT NOT NULL,
	normalizedValues INTEGER NOT NULL)`;

describe("native SQLite date-format transition", () => {
	let db: Database.Database;
	beforeEach(async () => {
		db = new Database(":memory:");
		db.pragma("foreign_keys=ON");
		db.exec("BEGIN");
		await prepareRuntimeSchemaExecution(registry, { provider: "sqlite", tables: [] }).execute(
			async (sql) => {
				db.exec(sql);
			},
		);
		db.exec("DROP TABLE IF EXISTS ArrRuntimeDataFormatReceipt");
		db.exec(receiptSql);
		db.exec("COMMIT");
		db.prepare(
			"INSERT INTO User(id,username,hashedPassword,createdAt,updatedAt) VALUES(?,?,?,?,?)",
		).run("fixture-owner", "fixture-owner", "opaque-password", canonical, canonical);
	});
	afterEach(() => {
		if (db.open) db.close();
	});
	const seed = (id: string, expiresAt: number | string) =>
		db
			.prepare(
				"INSERT INTO sessions(id,userId,expiresAt,createdAt,lastAccessedAt) VALUES(?,?,?,?,?)",
			)
			.run(id, "fixture-owner", expiresAt, canonical, canonical);
	const rows = () => db.prepare("SELECT * FROM sessions ORDER BY id").all();
	const marker = () => db.prepare("SELECT * FROM ArrRuntimeDataFormatReceipt").all();
	const plan = () => planSqliteRuntimeDates(db, registry);
	const apply = async () => {
		db.exec("BEGIN IMMEDIATE");
		const p = plan();
		await applySqliteRuntimeDates(db, p, async () => {});
		return p;
	};

	it("bounds repeated timestamp parsing while still planning every managed row", () => {
		for (let i = 0; i < 20; i++) seed(`repeat-${i}`, canonical);
		db.exec("BEGIN IMMEDIATE");
		const parse = vi.spyOn(Date, "parse");
		try {
			const p = plan();
			expect(p.rowsInspected).toBe(21);
			expect(p.normalizedValues).toBe(0);
			expect(parse.mock.calls.length).toBeLessThanOrEqual(4);
			expect(rows()).toHaveLength(20);
		} finally {
			parse.mockRestore();
		}
	});

	it("bounds repeated timestamp parsing during the independent apply scan", async () => {
		for (let i = 0; i < 20; i++) seed(`repeat-${i}`, canonical);
		const before = rows();
		db.exec("BEGIN IMMEDIATE");
		const p = plan();
		const parse = vi.spyOn(Date, "parse");
		let ownedChecks = 0;
		try {
			await applySqliteRuntimeDates(db, p, async () => {
				ownedChecks++;
			});
			expect(parse.mock.calls.length).toBeLessThanOrEqual(6);
			expect(ownedChecks).toBeGreaterThan(1);
			expect(rows()).toEqual(before);
			expect(marker()).toMatchObject([{ id: 1, formatVersion: 1, normalizedValues: 0 }]);
		} finally {
			parse.mockRestore();
		}
	});

	it("checks every distinct date after repeated parser-cache turnover", async () => {
		for (let i = 0; i < 700; i++) {
			seed(`churn-${String(i).padStart(4, "0")}`, new Date(1700000000000 + i).toISOString());
		}
		// Known valid native forms normalize first, then must remain canonical.
		await apply();
		db.exec("COMMIT; BEGIN IMMEDIATE");
		const p = plan();
		expect(p.rowsInspected).toBe(701);
		expect(p.normalizedValues).toBe(0);
		await applySqliteRuntimeDates(db, p, async () => {});
		expect(rows()).toHaveLength(700);
		expect(db.pragma("foreign_key_check")).toEqual([]);
	});

	it("streams the settled date check in rowid order and preserves exact 64-bit cursor boundaries", async () => {
		for (let i = 0; i < 501; i++) seed(`stable-${501 - i}`, canonical);
		db.exec("UPDATE sessions SET rowid = -9223372036854775808 WHERE id = 'stable-3'");
		db.exec("UPDATE sessions SET rowid = 9223372036854775807 WHERE id = 'stable-4'");
		db.exec("UPDATE sessions SET rowid = 9223372036854775806 WHERE id = 'stable-5'");
		await apply();
		db.exec("COMMIT; BEGIN IMMEDIATE");
		// A compatible custom table may shadow SQLite's table-valued pragma name.
		db.exec("CREATE TABLE pragma_table_list(id INTEGER PRIMARY KEY)");
		const before = rows();
		const receipt = marker();
		const queries = vi.spyOn(db, "prepare");
		try {
			const p = planSqliteRuntimeDates(db, registry, { useTableOrderForCurrentReceipt: true });
			expect(p.rowsInspected).toBe(502);
			await applySqliteRuntimeDates(db, p, async () => {});
			const readQueries = queries.mock.calls
				.map(([sql]) => sql)
				.filter(
					(sql) =>
						/^SELECT .* FROM main\."sessions" ORDER BY /.test(sql) ||
						/^SELECT .* FROM main\."sessions" WHERE .* ORDER BY /.test(sql),
				);
			expect(readQueries).toHaveLength(3);
			expect(readQueries.every((sql) => sql.includes("ORDER BY _rowid_"))).toBe(true);
			expect(rows()).toEqual(before);
			expect(marker()).toEqual(receipt);
			expect(db.inTransaction).toBe(true);
		} finally {
			queries.mockRestore();
		}
	});

	it.each(["missing receipt", "shadowed rowid", "without rowid"] as const)(
		"keeps primary-key traversal for %s",
		async (reason) => {
			if (reason !== "missing receipt") {
				await apply();
				db.exec("COMMIT");
				if (reason === "shadowed rowid") {
					db.exec('ALTER TABLE sessions ADD COLUMN "_RoWiD_" TEXT');
				} else {
					const definition = db
						.prepare("SELECT sql FROM sqlite_schema WHERE name = 'sessions'")
						.pluck()
						.get() as string;
					db.exec("DROP TABLE sessions");
					db.exec(`${definition} WITHOUT ROWID`);
				}
			}
			seed("a", canonical);
			db.exec("BEGIN IMMEDIATE");
			const queries = vi.spyOn(db, "prepare");
			try {
				const p = planSqliteRuntimeDates(db, registry, { useTableOrderForCurrentReceipt: true });
				await applySqliteRuntimeDates(db, p, async () => {});
				const sessionReads = queries.mock.calls
					.map(([sql]) => sql)
					.filter((sql) => /^SELECT .* FROM main\."sessions".* ORDER BY /.test(sql));
				expect(sessionReads).toHaveLength(3);
				expect(sessionReads.every((sql) => sql.includes('ORDER BY "id"'))).toBe(true);
				expect(rows()).toHaveLength(1);
			} finally {
				queries.mockRestore();
			}
		},
	);

	it("rejects an unreadable primary-key index on the settled table-order scan", async () => {
		for (let i = 0; i < 800; i++) seed(`index-${String(i).padStart(4, "0")}`, canonical);
		await apply();
		db.exec("COMMIT");
		const index = (
			db.pragma("main.index_list('sessions')") as { name: string; origin: string }[]
		).find(({ origin }) => origin === "pk");
		expect(index).toBeDefined();
		const page = db
			.prepare(
				"SELECT pageno FROM dbstat WHERE name = ? AND pagetype = 'leaf' ORDER BY path DESC LIMIT 1",
			)
			.pluck()
			.get(index!.name) as number;
		const pageSize = db.pragma("page_size", { simple: true }) as number;
		expect(page).toBeGreaterThan(1);
		const damaged = db.serialize();
		damaged[(page - 1) * pageSize] = 0;
		const copy = new Database(damaged);
		try {
			expect(copy.prepare("SELECT expiresAt FROM sessions ORDER BY _rowid_").all()).toHaveLength(
				800,
			);
			copy.pragma("foreign_keys=ON");
			copy.exec("BEGIN IMMEDIATE");
			expect(() =>
				planSqliteRuntimeDates(copy, registry, { useTableOrderForCurrentReceipt: true }),
			).toThrow(SqliteDateCompatibilityError);
			copy.exec("ROLLBACK");
		} finally {
			copy.close();
		}
	});

	it("rejects canonical value drift on the settled table-order scan", async () => {
		seed("a", canonical);
		await apply();
		db.exec("COMMIT; BEGIN IMMEDIATE");
		const prior = marker();
		const p = planSqliteRuntimeDates(db, registry, { useTableOrderForCurrentReceipt: true });
		db.prepare("UPDATE sessions SET expiresAt=? WHERE id='a'").run("2026-11-01T13:00:00.000+00:00");
		await expect(applySqliteRuntimeDates(db, p, async () => {})).rejects.toBeInstanceOf(
			SqliteDateCompatibilityError,
		);
		expect(marker()).toEqual(prior);
		db.exec("ROLLBACK");
		expect(db.prepare("SELECT expiresAt FROM sessions").get()).toEqual({ expiresAt: canonical });
	});

	it("does not let repeated successful parsing hide a late invalid date", () => {
		for (let i = 0; i < 700; i++) seed(`repeat-${String(i).padStart(4, "0")}`, canonical);
		seed("zz-invalid", "2024-02-30T00:00:00.000+00:00");
		const before = rows();
		db.exec("BEGIN IMMEDIATE");
		expect(plan).toThrow(SqliteDateCompatibilityError);
		expect(rows()).toEqual(before);
		expect(marker()).toEqual([]);
	});

	it("normalizes mixed date representations without changing identity or opaque fields", async () => {
		seed("a", 1700000000000);
		seed("b", "2023-11-15T00:13:20+02:00");
		seed("c", "2023-11-14 22:13:20");
		const beforeUser = db.prepare("SELECT * FROM User").get();
		const roots = db
			.prepare("SELECT name,rootpage FROM sqlite_schema WHERE type='table' ORDER BY name")
			.all();
		const p = await apply();
		expect(p.normalizedValues).toBe(3);
		expect(Object.isFrozen(p)).toBe(true);
		expect(rows()).toEqual(
			["a", "b", "c"].map((id) => ({
				id,
				userId: "fixture-owner",
				expiresAt: canonical,
				createdAt: canonical,
				lastAccessedAt: canonical,
				userAgent: null,
				ipAddress: null,
			})),
		);
		expect(db.prepare("SELECT * FROM User").get()).toEqual(beforeUser);
		expect(
			db.prepare("SELECT name,rootpage FROM sqlite_schema WHERE type='table' ORDER BY name").all(),
		).toEqual(roots);
		expect(marker()).toHaveLength(1);
		expect(marker()[0]).toMatchObject({ id: 1, formatVersion: 1, normalizedValues: 3 });
		expect(db.inTransaction).toBe(true);
		expect(db.pragma("foreign_key_check")).toEqual([]);
		db.exec("COMMIT");
	});

	it("preserves nullable dates and ignores unregistered custom date columns", async () => {
		db.exec("ALTER TABLE User ADD COLUMN privateCustomDate DATETIME");
		db.prepare("UPDATE User SET lockedUntil=?,privateCustomDate=?").run(0, "not-managed");
		await apply();
		expect(db.prepare("SELECT lockedUntil,privateCustomDate FROM User").get()).toEqual({
			lockedUntil: "1970-01-01T00:00:00.000+00:00",
			privateCustomDate: "not-managed",
		});
	});

	it.each([
		"2024-02-30T00:00:00Z",
		"unknown-private-date",
		"2024-02-29T00:00:00.1231Z",
		"+010000-01-01T00:00:00Z",
		"-000001-01-01T00:00:00Z",
	])("refuses a late invalid or unsafe indexed date before normalization: %s", (value) => {
		seed("a", 1700000000000);
		seed("z", value);
		const original = rows();
		db.exec("BEGIN IMMEDIATE");
		expect(plan).toThrow(SqliteDateCompatibilityError);
		expect(rows()).toEqual(original);
		expect(marker()).toEqual([]);
		expect(db.inTransaction).toBe(true);
	});

	it("preserves an unrelated UPDATE OF trigger without invoking it", async () => {
		db.exec(`ALTER TABLE User ADD COLUMN fixtureExtra TEXT;
			CREATE TABLE FixtureAudit(value TEXT);
			CREATE TRIGGER "odd update name" AFTER /* header comment */ UPDATE OF [fixtureExtra]
			ON "User" BEGIN INSERT INTO FixtureAudit VALUES(new.fixtureExtra); END;`);
		db.prepare("UPDATE User SET updatedAt=?").run(1700000000000);
		const objects = db
			.prepare("SELECT name,sql FROM sqlite_schema WHERE type IN ('trigger','table') ORDER BY name")
			.all();
		await apply();
		expect(db.prepare("SELECT count(*) AS n FROM FixtureAudit").get()).toEqual({ n: 0 });
		expect(
			db
				.prepare(
					"SELECT name,sql FROM sqlite_schema WHERE type IN ('trigger','table') ORDER BY name",
				)
				.all(),
		).toEqual(objects);
	});

	it.each([
		"AFTER UPDATE",
		"BEFORE UPDATE OF expiresAt",
		'AFTER UPDATE OF "EXPIRESAT",userAgent',
		"AFTER UPDATE OF `expiresAt`",
		"AFTER UPDATE OF [expiresAt]",
	])("refuses an affected trigger before firing it: %s", (header) => {
		seed("a", 1700000000000);
		db.exec(`CREATE TABLE FixtureAudit(value TEXT);
			CREATE TRIGGER guard ${header} ON sessions BEGIN INSERT INTO FixtureAudit VALUES('effect'); END;`);
		const original = rows();
		db.exec("BEGIN IMMEDIATE");
		expect(plan).toThrow(SqliteDateCompatibilityError);
		expect(rows()).toEqual(original);
		expect(db.prepare("SELECT count(*) AS n FROM FixtureAudit").get()).toEqual({ n: 0 });
		expect(marker()).toEqual([]);
	});

	it("does not rewrite a canonical fixed point or replace its positive receipt on restart", async () => {
		seed("a", canonical);
		await apply();
		db.exec("COMMIT");
		const original = rows(),
			prior = marker();
		const p = await apply();
		expect(p.normalizedValues).toBe(0);
		expect(rows()).toEqual(original);
		expect(marker()).toEqual(prior);
	});

	it("refuses a temporary update trigger on the same native connection", () => {
		seed("a", 1700000000000);
		db.exec(`CREATE TABLE FixtureAudit(value TEXT);
			CREATE TEMP TRIGGER temp_guard AFTER UPDATE ON main.sessions BEGIN INSERT INTO FixtureAudit VALUES('effect'); END;
			BEGIN IMMEDIATE`);
		expect(plan).toThrow(SqliteDateCompatibilityError);
		expect(db.prepare("SELECT count(*) AS n FROM FixtureAudit").get()).toEqual({ n: 0 });
	});

	it("refuses normalization that could cascade into an unregistered table", () => {
		db.prepare("UPDATE User SET updatedAt=?").run(1700000000000);
		db.exec(`CREATE UNIQUE INDEX fixture_date_parent ON User(updatedAt);
			CREATE TABLE FixtureChild(id INTEGER PRIMARY KEY,stamp DATETIME REFERENCES User(updatedAt) ON UPDATE CASCADE);
			INSERT INTO FixtureChild VALUES(1,1700000000000); BEGIN IMMEDIATE`);
		expect(plan).toThrow(SqliteDateCompatibilityError);
		expect(db.prepare("SELECT stamp FROM FixtureChild").get()).toEqual({ stamp: 1700000000000 });
	});

	it("does not use a positive marker to repair contradictory later data silently", async () => {
		seed("a", canonical);
		await apply();
		db.exec("COMMIT");
		db.prepare("UPDATE sessions SET expiresAt=?").run(1700000000000);
		const prior = marker();
		db.exec("BEGIN IMMEDIATE");
		expect(plan).toThrow(SqliteDateCompatibilityError);
		expect(marker()).toEqual(prior);
		expect(db.prepare("SELECT typeof(expiresAt) AS kind FROM sessions").get()).toEqual({
			kind: "integer",
		});
	});

	it.each([
		"formatVersion=2",
		"dateColumnsDigest='invalid'",
		"normalizedValues=-1",
		"completedAt='invalid'",
	])("refuses a malformed existing marker: %s", async (change) => {
		await apply();
		db.exec("COMMIT");
		db.exec(`UPDATE ArrRuntimeDataFormatReceipt SET ${change}; BEGIN IMMEDIATE`);
		expect(plan).toThrow(SqliteDateCompatibilityError);
	});

	it("requires an existing caller transaction and foreign-key enforcement", () => {
		expect(plan).toThrow(SqliteDateCompatibilityError);
		db.pragma("foreign_keys=OFF");
		db.exec("BEGIN IMMEDIATE");
		expect(plan).toThrow(SqliteDateCompatibilityError);
	});

	it("rejects forged plans and plans created by a different native connection", async () => {
		db.exec("BEGIN IMMEDIATE");
		const p = plan();
		await expect(applySqliteRuntimeDates(db, { ...p }, async () => {})).rejects.toBeInstanceOf(
			SqliteDateCompatibilityError,
		);
		const other = new Database(":memory:");
		other.pragma("foreign_keys=ON");
		other.exec("BEGIN");
		try {
			await expect(applySqliteRuntimeDates(other, p, async () => {})).rejects.toBeInstanceOf(
				SqliteDateCompatibilityError,
			);
		} finally {
			other.close();
		}
	});

	it("rejects value drift between validation and apply before producing a marker", async () => {
		seed("a", 1700000000000);
		db.exec("BEGIN IMMEDIATE");
		const p = plan();
		db.prepare("UPDATE sessions SET expiresAt=?").run(1700000000001);
		await expect(applySqliteRuntimeDates(db, p, async () => {})).rejects.toBeInstanceOf(
			SqliteDateCompatibilityError,
		);
		expect(marker()).toEqual([]);
		db.exec("ROLLBACK");
		expect(db.prepare("SELECT expiresAt FROM sessions").get()).toEqual({
			expiresAt: 1700000000000,
		});
	});

	it("leaves real unique-constraint failure rollback and marker publication to one transaction", async () => {
		seed("a", 1700000000001);
		seed("b", 1700000000000);
		seed("c", "2023-11-14 22:13:20");
		db.exec("CREATE UNIQUE INDEX fixture_unique_date ON sessions(expiresAt)");
		const original = rows();
		db.exec("BEGIN IMMEDIATE");
		const p = plan();
		await expect(applySqliteRuntimeDates(db, p, async () => {})).rejects.toBeInstanceOf(
			SqliteDateCompatibilityError,
		);
		expect(marker()).toEqual([]);
		expect(db.inTransaction).toBe(true);
		db.exec("ROLLBACK");
		expect(rows()).toEqual(original);
	});

	it("rolls all changed values back when the ownership callback refuses after admitted work", async () => {
		for (let i = 0; i < 600; i++) seed(String(i).padStart(4, "0"), 1700000000000 + i);
		const original = rows();
		db.exec("BEGIN IMMEDIATE");
		const p = plan();
		let checks = 0;
		await expect(
			applySqliteRuntimeDates(db, p, async () => {
				if (++checks === 3) throw Error("lost claim");
			}),
		).rejects.toBeInstanceOf(SqliteDateCompatibilityError);
		expect(
			db.prepare("SELECT count(*) AS n FROM sessions WHERE typeof(expiresAt)='text'").get(),
		).toMatchObject({ n: 250 });
		expect(marker()).toEqual([]);
		db.exec("ROLLBACK");
		expect(rows()).toEqual(original);
	});

	it("does not commit or leak a plan after it has already been applied", async () => {
		seed("a", 1700000000000);
		const p = await apply();
		const prior = marker();
		await expect(applySqliteRuntimeDates(db, p, async () => {})).rejects.toBeInstanceOf(
			SqliteDateCompatibilityError,
		);
		expect(marker()).toEqual(prior);
		expect(db.inTransaction).toBe(true);
	});

	it("keeps normal temporal comparisons correct at equality and millisecond boundaries", async () => {
		seed("a", 1700000000000);
		seed("b", 1700000000001);
		seed("c", "2023-11-14T23:13:19.999+01:00");
		await apply();
		expect(
			db.prepare("SELECT id FROM sessions WHERE expiresAt < ? ORDER BY expiresAt").all(canonical),
		).toEqual([{ id: "c" }]);
		expect(db.prepare("SELECT id FROM sessions WHERE expiresAt = ?").all(canonical)).toEqual([
			{ id: "a" },
		]);
		expect(db.prepare("SELECT id FROM sessions WHERE expiresAt > ?").all(canonical)).toEqual([
			{ id: "b" },
		]);
	});

	it("traverses a sizeable population without retaining raw rows in its plan", async () => {
		db.exec("BEGIN");
		for (let i = 0; i < 100_000; i++) seed(String(i).padStart(6, "0"), 1700000000000 + i);
		db.exec("COMMIT");
		const started = performance.now(),
			before = process.memoryUsage().heapUsed;
		const p = await apply();
		expect(p.normalizedValues).toBe(100_000);
		expect(
			db.prepare("SELECT count(*) AS n FROM sessions WHERE typeof(expiresAt)='text'").get(),
		).toEqual({ n: 100_000 });
		expect(JSON.stringify(p).length).toBeLessThan(1000);
		expect(process.memoryUsage().heapUsed - before).toBeLessThan(128 * 1024 * 1024);
		expect(performance.now() - started).toBeLessThan(30_000);
	}, 60_000);
});
