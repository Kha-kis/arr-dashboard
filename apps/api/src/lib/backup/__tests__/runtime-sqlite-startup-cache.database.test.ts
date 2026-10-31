import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { provisionSqliteRestoreRuntimeSchema } from "../restore-runtime-sqlite-enrollment.js";
import { synchronizeSqliteRuntimeSchema } from "../runtime-schema-sqlite.js";
import { applySqliteStartupCacheHint } from "../runtime-sqlite-startup-cache.js";

describe.skipIf(process.platform !== "linux")("native startup page-cache budget", () => {
	let directory: string;
	let path: string;
	let url: string;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "arr-startup-cache-"));
		chmodSync(directory, 0o700);
		path = join(directory, "main.db");
		url = `file:${path}`;
		vi.spyOn(process, "constrainedMemory").mockReturnValue(3221225472);
		vi.spyOn(process, "availableMemory").mockReturnValue(1995345920);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(directory, { recursive: true });
	});
	function database<T>(action: (db: Database.Database) => T): T {
		const db = new Database(path);
		try {
			return action(db);
		} finally {
			db.close();
		}
	}
	const rows = (table: string) =>
		database((db) => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
	it.each(["delete", "wal"])(
		"applies the hint on the %s startup writer and closes it without persisting the hint",
		async (mode) => {
			database((db) => db.pragma(`journal_mode=${mode}`));
			await synchronizeSqliteRuntimeSchema(url);
			database((db) =>
				db.exec(
					"INSERT INTO User(id,username,createdAt,updatedAt) VALUES('owner','owner','2026-01-01T00:00:00.000+00:00','2026-01-01T00:00:00.000+00:00')",
				),
			);
			const before = {
				binding: rows("SqliteRestoreStorageBinding"),
				receipts: rows("ArrSchemaMigrationReceipt"),
				dates: rows("ArrRuntimeDataFormatReceipt"),
				users: rows("User"),
				journal: rows("RestoreRuntimeControl"),
			};
			const defaultCache = database((db) => db.pragma("cache_size", { simple: true }));
			let observed: unknown;
			let writer: Database.Database | undefined;
			const runtimeEpoch = randomUUID();
			await provisionSqliteRestoreRuntimeSchema(
				url,
				{ runtimeEpoch },
				{
					preflight(main) {
						writer = main;
						observed = main.pragma("cache_size", { simple: true });
						expect(main.inTransaction).toBe(true);
						expect(main.pragma("foreign_keys", { simple: true })).toBe(1);
						expect(main.pragma("synchronous", { simple: true })).toBe(2);
						expect(main.pragma("journal_mode", { simple: true })).toBe(mode);
					},
					async apply() {},
					finish() {
						return { apiPort: null, webPort: null, listenAddress: null };
					},
				},
			);
			expect(writer?.open).toBe(false);
			expect(observed).toBe(-65536);
			expect(database((db) => db.pragma("cache_size", { simple: true }))).toBe(defaultCache);
			expect(rows("SqliteRestoreStorageBinding")).toEqual(before.binding);
			expect(rows("ArrSchemaMigrationReceipt")).toEqual(before.receipts);
			expect(rows("ArrRuntimeDataFormatReceipt")).toEqual(before.dates);
			expect(rows("User")).toEqual(before.users);
			expect(rows("RestoreRuntimeControl")).toEqual(
				before.journal.map((row) => ({ ...(row as object), runtimeEpoch })),
			);
			database((db) => {
				expect(db.pragma("journal_mode", { simple: true })).toBe(mode);
				db.exec("BEGIN EXCLUSIVE; ROLLBACK");
			});
		},
	);

	function seedReferences() {
		database((db) => {
			db.pragma("foreign_keys=ON");
			db.exec(`CREATE TABLE CacheParent(id INTEGER PRIMARY KEY);
				CREATE TABLE CacheCompositeParent(a INTEGER,b INTEGER,PRIMARY KEY(a,b));
				CREATE TABLE CacheChild(id INTEGER PRIMARY KEY,parent INTEGER REFERENCES CacheParent(id));
				CREATE TABLE CacheCompositeChild(id INTEGER PRIMARY KEY,a INTEGER,b INTEGER,FOREIGN KEY(a,b) REFERENCES CacheCompositeParent(a,b));
				INSERT INTO CacheParent VALUES(1);
				INSERT INTO CacheCompositeParent VALUES(1,2);
				INSERT INTO CacheChild VALUES(1,NULL),(2,1);
				INSERT INTO CacheCompositeChild VALUES(1,NULL,999),(2,999,NULL),(3,1,2);`);
			const scalar = db.prepare("INSERT INTO CacheChild VALUES(?,1)");
			const composite = db.prepare("INSERT INTO CacheCompositeChild VALUES(?,1,2)");
			db.transaction(() => {
				for (let id = 10; id < 1010; id++) {
					scalar.run(id);
					composite.run(id);
				}
			})();
		});
	}
	it("accepts populated valid and nullable scalar/composite references through actual startup", async () => {
		await synchronizeSqliteRuntimeSchema(url);
		seedReferences();
		const scalar = rows("CacheChild"),
			composite = rows("CacheCompositeChild");
		await expect(synchronizeSqliteRuntimeSchema(url)).resolves.toEqual({
			apiPort: null,
			webPort: null,
			listenAddress: null,
		});
		expect(rows("CacheChild")).toEqual(scalar);
		expect(rows("CacheCompositeChild")).toEqual(composite);
		expect(database((db) => db.pragma("foreign_key_check"))).toEqual([]);
	});
	it.each(["scalar", "composite"])(
		"refuses a late %s FK violation and rolls back the prepared receipt and journal",
		async (kind) => {
			await synchronizeSqliteRuntimeSchema(url);
			seedReferences();
			database((db) => {
				db.pragma("foreign_keys=OFF");
				db.exec(
					kind === "scalar"
						? "INSERT INTO CacheChild VALUES(999999,999)"
						: "INSERT INTO CacheCompositeChild VALUES(999999,1,999)",
				);
			});
			const before = {
				binding: rows("SqliteRestoreStorageBinding"),
				journal: rows("RestoreRuntimeControl"),
				receipts: rows("ArrSchemaMigrationReceipt"),
				dates: rows("ArrRuntimeDataFormatReceipt"),
				scalar: rows("CacheChild"),
				composite: rows("CacheCompositeChild"),
			};
			let observed:
				| { cache: unknown; violations: unknown; receipts: unknown[]; journal: unknown[] }
				| undefined;
			let writer: Database.Database | undefined;
			const pragma = Database.prototype.pragma;
			vi.spyOn(Database.prototype, "pragma").mockImplementation(function (
				this: Database.Database,
				source,
				options,
			) {
				const result = pragma.call(this, source, options);
				if (source === "foreign_key_check") {
					writer = this;
					observed = {
						cache: pragma.call(this, "main.cache_size", { simple: true }),
						violations: result,
						receipts: this.prepare("SELECT * FROM ArrSchemaMigrationReceipt ORDER BY id").all(),
						journal: this.prepare("SELECT * FROM RestoreRuntimeControl ORDER BY id").all(),
					};
				}
				return result;
			});
			await expect(synchronizeSqliteRuntimeSchema(url)).rejects.toMatchObject({
				category: "startup-unavailable",
			});
			expect(observed?.cache).toBe(-65536);
			expect(observed?.violations).toEqual([
				{
					table: kind === "scalar" ? "CacheChild" : "CacheCompositeChild",
					rowid: 999999,
					parent: kind === "scalar" ? "CacheParent" : "CacheCompositeParent",
					fkid: 0,
				},
			]);
			expect(observed?.receipts).toHaveLength(before.receipts.length + 1);
			expect(observed?.journal).not.toEqual(before.journal);
			expect(writer?.open).toBe(false);
			vi.restoreAllMocks();
			expect(rows("SqliteRestoreStorageBinding")).toEqual(before.binding);
			expect(rows("RestoreRuntimeControl")).toEqual(before.journal);
			expect(rows("ArrSchemaMigrationReceipt")).toEqual(before.receipts);
			expect(rows("ArrRuntimeDataFormatReceipt")).toEqual(before.dates);
			expect(rows("CacheChild")).toEqual(before.scalar);
			expect(rows("CacheCompositeChild")).toEqual(before.composite);
			database((db) => db.exec("BEGIN EXCLUSIVE; ROLLBACK"));
		},
	);
	it.each(["constrainedMemory", "availableMemory"] as const)(
		"preserves the native cache when %s is missing or throws",
		(method) => {
			database((db) => {
				db.pragma("cache_size=-12345");
				vi.spyOn(process, method).mockImplementation(() => {
					throw new Error("resource unavailable");
				});
				applySqliteStartupCacheHint(db);
				expect(db.pragma("cache_size", { simple: true })).toBe(-12345);
				const descriptor = Object.getOwnPropertyDescriptor(process, method)!;
				try {
					Object.defineProperty(process, method, { ...descriptor, value: undefined });
					applySqliteStartupCacheHint(db);
					expect(db.pragma("cache_size", { simple: true })).toBe(-12345);
				} finally {
					Object.defineProperty(process, method, descriptor);
				}
			});
		},
	);
	it("does not swallow native descriptor errors as an optimization fallback", () => {
		const db = new Database(path);
		db.close();
		expect(() => applySqliteStartupCacheHint(db)).toThrow();
	});
	it("samples fresh resources and preserves a larger operator page budget on the native connection", () => {
		database((db) => {
			vi.spyOn(process, "constrainedMemory").mockReturnValue(536870912);
			vi.spyOn(process, "availableMemory").mockReturnValue(268435456);
			applySqliteStartupCacheHint(db);
			expect(db.pragma("cache_size", { simple: true })).toBe(-16384);
			vi.spyOn(process, "constrainedMemory").mockReturnValue(3221225472);
			vi.spyOn(process, "availableMemory").mockReturnValue(1995345920);
			applySqliteStartupCacheHint(db);
			expect(db.pragma("cache_size", { simple: true })).toBe(-65536);
			db.pragma("cache_size=32768");
			applySqliteStartupCacheHint(db);
			expect(db.pragma("cache_size", { simple: true })).toBe(32768);
			vi.spyOn(process, "availableMemory").mockReturnValue(0);
			db.pragma("cache_size=-12345");
			applySqliteStartupCacheHint(db);
			expect(db.pragma("cache_size", { simple: true })).toBe(-12345);
		});
	});
	it("retains SQLite's nullable and collated-reference semantics in the actual writer's full FK check", async () => {
		await synchronizeSqliteRuntimeSchema(url);
		database((db) => {
			db.pragma("foreign_keys=ON");
			db.exec(`CREATE TABLE CacheTextParent(id TEXT COLLATE NOCASE PRIMARY KEY);
				CREATE TABLE CacheTextChild(id INTEGER PRIMARY KEY,parent TEXT REFERENCES CacheTextParent(id));
				INSERT INTO CacheTextParent VALUES('Canonical');
				INSERT INTO CacheTextChild VALUES(1,'CANONICAL'),(2,NULL);`);
		});
		await expect(
			provisionSqliteRestoreRuntimeSchema(
				url,
				{ runtimeEpoch: randomUUID() },
				{
					preflight(main) {
						expect(main.pragma("cache_size", { simple: true })).toBe(-65536);
					},
					async apply() {},
					finish() {
						return { apiPort: null, webPort: null, listenAddress: null };
					},
				},
			),
		).resolves.toEqual({ apiPort: null, webPort: null, listenAddress: null });
		expect(rows("CacheTextChild")).toEqual([
			{ id: 1, parent: "CANONICAL" },
			{ id: 2, parent: null },
		]);
	});
});
