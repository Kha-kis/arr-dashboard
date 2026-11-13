import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSchemaFixture } from "./sqlite-schema-fixture.js";

const directories: string[] = [];
const templates: SqliteSchemaFixture[] = [];

function destination(name = "copy.db") {
	const directory = mkdtempSync(join(tmpdir(), "sqlite-schema-copy-test-"));
	directories.push(directory);
	return join(directory, name);
}

function initializeEmpty(path: string) {
	const db = new Database(path);
	try {
		db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
	} finally {
		db.close();
	}
}

function template(initialize = initializeEmpty) {
	const fixture = new SqliteSchemaFixture(initialize);
	templates.push(fixture);
	return fixture;
}

afterEach(() => {
	for (const fixture of templates.splice(0)) fixture.dispose();
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("disposable SQLite schema fixture", () => {
	it("initializes once and copies independent empty databases without sharing file identity", () => {
		let initializations = 0;
		const fixture = template((path) => {
			initializations++;
			initializeEmpty(path);
		});
		fixture.initialize();
		const first = destination();
		const second = destination();
		fixture.copyTo(first);
		fixture.copyTo(second);
		const writer = new Database(first);
		const reader = new Database(second);
		try {
			writer.prepare("INSERT INTO entries (value) VALUES (?)").run("first only");
			expect(reader.prepare("SELECT * FROM entries").all()).toEqual([]);
			expect(statSync(first).ino).not.toBe(statSync(second).ino);
			expect(statSync(first).nlink).toBe(1);
			expect(statSync(second).nlink).toBe(1);
			const third = destination();
			fixture.copyTo(third);
			const later = new Database(third);
			try {
				expect(later.prepare("SELECT * FROM entries").all()).toEqual([]);
			} finally {
				later.close();
			}
			expect(initializations).toBe(1);
			expect(() => fixture.initialize()).toThrow();
			expect(initializations).toBe(1);
		} finally {
			writer.close();
			reader.close();
		}
	});

	it("refuses copies before initialization and while initialization is still running", () => {
		const path = destination();
		const fixture = template((databasePath) => {
			initializeEmpty(databasePath);
			expect(() => fixture.copyTo(path)).toThrow();
			expect(existsSync(path)).toBe(false);
		});
		expect(() => fixture.copyTo(path)).toThrow();
		expect(existsSync(path)).toBe(false);
		fixture.initialize();
		fixture.copyTo(path);
		expect(existsSync(path)).toBe(true);
	});

	it("disposes only its template while an independently owned clone remains open and writable", () => {
		let templatePath = "";
		const fixture = template((path) => {
			templatePath = path;
			initializeEmpty(path);
		});
		fixture.initialize();
		const path = destination();
		fixture.copyTo(path);
		const db = new Database(path);
		try {
			fixture.dispose();
			fixture.dispose();
			expect(existsSync(dirname(templatePath))).toBe(false);
			db.exec("INSERT INTO entries (value) VALUES ('still owned by caller')");
			expect(db.prepare("SELECT value FROM entries").all()).toEqual([
				{ value: "still owned by caller" },
			]);
			expect(() => fixture.copyTo(destination())).toThrow();
			expect(() => fixture.initialize()).toThrow();
		} finally {
			db.close();
		}
	});

	it("cannot initialize or copy after disposal before setup", () => {
		const fixture = template();
		fixture.dispose();
		expect(() => fixture.initialize()).toThrow();
		const path = destination();
		expect(() => fixture.copyTo(path)).toThrow();
		expect(existsSync(path)).toBe(false);
	});

	it("removes a partial failed template without deleting caller data or allowing a retry/copy", () => {
		const unrelated = destination();
		initializeEmpty(unrelated);
		let partial = "";
		const fixture = template((path) => {
			partial = path;
			initializeEmpty(path);
			throw new Error("schema initialization failed");
		});
		expect(() => fixture.initialize()).toThrow("schema initialization failed");
		expect(existsSync(dirname(partial))).toBe(false);
		expect(existsSync(unrelated)).toBe(true);
		const path = destination();
		expect(() => fixture.copyTo(path)).toThrow();
		expect(() => fixture.initialize()).toThrow();
		expect(existsSync(path)).toBe(false);
	});

	it.each(["missing", "invalid", "no schema", "populated", "journal", "wal"])(
		"refuses a %s initializer result before exposing any copy",
		(kind) => {
			let initialized = "";
			const fixture = template((path) => {
				initialized = path;
				if (kind === "missing") return;
				if (kind === "invalid") {
					writeFileSync(path, "not a SQLite database");
					return;
				}
				const db = new Database(path);
				try {
					if (kind !== "no schema") db.exec("CREATE TABLE entries (value TEXT)");
					if (kind === "populated") db.exec("INSERT INTO entries VALUES ('contamination')");
				} finally {
					db.close();
				}
				if (kind === "journal" || kind === "wal") writeFileSync(`${path}-${kind}`, "incomplete");
			});
			expect(() => fixture.initialize()).toThrow();
			expect(existsSync(dirname(initialized))).toBe(false);
			const path = destination();
			expect(() => fixture.copyTo(path)).toThrow();
			expect(existsSync(path)).toBe(false);
		},
	);

	it("refuses a template whose schema still depends on a real uncheckpointed WAL", () => {
		const fixture = template((path) => {
			const db = new Database(path);
			let main: Buffer;
			let wal: Buffer;
			try {
				db.pragma("journal_mode = WAL");
				db.exec("CREATE TABLE entries (value TEXT)");
				expect(db.prepare("SELECT * FROM entries").all()).toEqual([]);
				main = readFileSync(path);
				wal = readFileSync(`${path}-wal`);
			} finally {
				db.close();
			}
			// Recreate the incomplete snapshot after closing the writer, with no live driver.
			writeFileSync(path, main);
			writeFileSync(`${path}-wal`, wal);
		});
		expect(() => fixture.initialize()).toThrow("sidecar");
		const path = destination();
		expect(() => fixture.copyTo(path)).toThrow();
		expect(existsSync(path)).toBe(false);
	});

	it("refuses a template contaminated after setup without exposing a new copy", () => {
		let templatePath = "";
		const fixture = template((path) => {
			templatePath = path;
			initializeEmpty(path);
		});
		fixture.initialize();
		const db = new Database(templatePath);
		try {
			db.exec("INSERT INTO entries (value) VALUES ('not pristine')");
		} finally {
			db.close();
		}
		const path = destination();
		expect(() => fixture.copyTo(path)).toThrow();
		expect(existsSync(path)).toBe(false);
	});

	it("does not overwrite a database already owned by the caller", () => {
		const fixture = template();
		fixture.initialize();
		const path = destination();
		initializeEmpty(path);
		const db = new Database(path);
		try {
			db.exec("INSERT INTO entries (value) VALUES ('caller data')");
			expect(() => fixture.copyTo(path)).toThrow();
			expect(db.prepare("SELECT value FROM entries").all()).toEqual([{ value: "caller data" }]);
		} finally {
			db.close();
		}
	});
});
