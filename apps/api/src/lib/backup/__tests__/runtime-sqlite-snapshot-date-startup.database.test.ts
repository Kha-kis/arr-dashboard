import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import { synchronizeSqliteRuntimeSchema } from "../runtime-schema-sqlite.js";

const date = "2026-11-17T00:00:00.000+00:00";

describe("snapshot date validation across native startup", () => {
	let directory: string;
	let path: string;
	let url: string;
	function database<T>(action: (db: Database.Database) => T): T {
		const db = new Database(path, { timeout: 0 });
		try {
			return action(db);
		} finally {
			db.close();
		}
	}
	const snapshots = () =>
		database((db) => db.prepare("SELECT * FROM session_snapshots ORDER BY id").all());
	const dirty = () =>
		database((db) => db.prepare('SELECT id FROM "ArrSnapshotDateDirty" ORDER BY id').pluck().all());
	const writeDate = (value: string) =>
		database((db) =>
			db.prepare("UPDATE session_snapshots SET capturedAt=? WHERE id='snapshot'").run(value),
		);
	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), "arr-snapshot-date-startup-"));
		chmodSync(directory, 0o700);
		path = join(directory, "owned.db");
		url = `file:${path}`;
		await synchronizeSqliteRuntimeSchema(url);
		database((db) => {
			db.prepare(
				"INSERT INTO User(id,username,createdAt,updatedAt) VALUES('owner','owner',?,?)",
			).run(date, date);
			db.prepare(
				"INSERT INTO ServiceInstance(id,userId,service,label,baseUrl,encryptedApiKey,encryptionIv,createdAt,updatedAt) " +
					"VALUES('source','owner','PLEX','synthetic','http://unopened.invalid','opaque','opaque',?,?)",
			).run(date, date);
			db.prepare(
				"INSERT INTO session_snapshots(id,instanceId,capturedAt,concurrentStreams,sessionsJson) " +
					"VALUES('snapshot','source',?,0,'opaque session payload')",
			).run(date);
		});
		await synchronizeSqliteRuntimeSchema(url);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(directory, { recursive: true });
	});
	it("reopens unchanged history without another timestamp table scan", async () => {
		const before = snapshots();
		const queries = vi.spyOn(Database.prototype, "prepare");
		await synchronizeSqliteRuntimeSchema(url);
		const projections = queries.mock.calls
			.map(([sql]) => sql)
			.filter(
				(sql) => sql.includes('FROM main."session_snapshots"') && sql.includes('"capturedAt"'),
			);
		expect(projections).toEqual([]);
		queries.mockRestore();
		expect(snapshots()).toEqual(before);
	});
	it("validates a changed timestamp by its key before clearing its durable marker", async () => {
		writeDate("2026-11-17T00:01:00.000+00:00");
		const before = snapshots();
		const queries = vi.spyOn(Database.prototype, "prepare");
		await synchronizeSqliteRuntimeSchema(url);
		const projections = queries.mock.calls
			.map(([sql]) => sql)
			.filter(
				(sql) => sql.includes('FROM main."session_snapshots"') && sql.includes('"capturedAt"'),
			);
		expect(projections.length).toBeGreaterThan(0);
		expect(projections.every((sql) => sql.includes('WHERE "id" IS ?'))).toBe(true);
		queries.mockRestore();
		expect(dirty()).toEqual([]);
		expect(snapshots()).toEqual(before);
	});
	it("tracks the real Prisma snapshot creation and date serialization path", async () => {
		const prisma = createTestPrismaClient(path);
		try {
			await prisma.sessionSnapshot.create({
				data: {
					id: "prisma-snapshot",
					instanceId: "source",
					concurrentStreams: 0,
					sessionsJson: "opaque",
				},
			});
		} finally {
			await prisma.$disconnect();
		}
		expect(dirty()).toEqual(["prisma-snapshot"]);
		const stored = database((db) =>
			db.prepare("SELECT capturedAt FROM session_snapshots WHERE id='prisma-snapshot'").get(),
		) as { capturedAt: string };
		expect(stored.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00$/);
		await synchronizeSqliteRuntimeSchema(url);
		expect(dirty()).toEqual([]);
	});
	it("rejects an invalid raw timestamp and keeps it pending after failed startup", async () => {
		writeDate("synthetic-invalid-date");
		const before = snapshots();
		await expect(synchronizeSqliteRuntimeSchema(url)).rejects.toMatchObject({
			category: "format-migration-required",
		});
		expect(dirty()).toEqual(["snapshot"]);
		expect(snapshots()).toEqual(before);
		writeDate(date);
		await synchronizeSqliteRuntimeSchema(url);
		expect(dirty()).toEqual([]);
	});
	it("keeps markers when the native foreign-key check rejects a later startup phase", async () => {
		writeDate("2026-11-17T00:01:00.000+00:00");
		database((db) => {
			db.pragma("foreign_keys=OFF");
			db.exec(
				"CREATE TABLE DateProofParent(id INTEGER PRIMARY KEY); " +
					"CREATE TABLE DateProofChild(id INTEGER PRIMARY KEY,parent INTEGER REFERENCES DateProofParent(id)); " +
					"INSERT INTO DateProofChild VALUES(1,404)",
			);
		});
		await expect(synchronizeSqliteRuntimeSchema(url)).rejects.toMatchObject({
			category: "startup-unavailable",
		});
		expect(dirty()).toEqual(["snapshot"]);
		database((db) => db.exec("DELETE FROM DateProofChild"));
		await synchronizeSqliteRuntimeSchema(url);
		expect(dirty()).toEqual([]);
	});
	it("installs tracking after validating the existing predecessor history", async () => {
		database((db) => {
			db.exec(
				"DROP TRIGGER arr_snapshot_dates_insert; DROP TRIGGER arr_snapshot_dates_update; " +
					'DROP TRIGGER arr_snapshot_dates_delete; DROP TABLE "ArrSnapshotDateDirty"; DROP TABLE "ArrSnapshotDateValidation"',
			);
		});
		const before = snapshots();
		await synchronizeSqliteRuntimeSchema(url);
		expect(snapshots()).toEqual(before);
		expect(dirty()).toEqual([]);
		await synchronizeSqliteRuntimeSchema(url);
		expect(snapshots()).toEqual(before);
	});
	it("deduplicates updates and removes pending keys when their snapshots are deleted", async () => {
		writeDate("2026-11-17T00:01:00.000+00:00");
		writeDate("2026-11-17T00:02:00.000+00:00");
		expect(dirty()).toEqual(["snapshot"]);
		database((db) => db.prepare("DELETE FROM session_snapshots WHERE id='snapshot'").run());
		expect(dirty()).toEqual([]);
		await synchronizeSqliteRuntimeSchema(url);
		expect(snapshots()).toEqual([]);
	});
	it("rolls back invalidation together with an abandoned snapshot write", async () => {
		database((db) => {
			db.exec("BEGIN");
			db.prepare(
				"UPDATE session_snapshots SET capturedAt='invalid-date' WHERE id='snapshot'",
			).run();
			expect(db.prepare('SELECT id FROM "ArrSnapshotDateDirty"').pluck().all()).toEqual([
				"snapshot",
			]);
			db.exec("ROLLBACK");
		});
		expect(dirty()).toEqual([]);
		await synchronizeSqliteRuntimeSchema(url);
		expect(snapshots()).toEqual([expect.objectContaining({ capturedAt: date })]);
	});
	it("refuses a missing tracking trigger without repairing its evidence", async () => {
		database((db) => db.exec("DROP TRIGGER arr_snapshot_dates_update"));
		writeDate("synthetic-invalid-date");
		const before = snapshots();
		await expect(synchronizeSqliteRuntimeSchema(url)).rejects.toMatchObject({
			category: "format-migration-required",
		});
		expect(snapshots()).toEqual(before);
		expect(
			database((db) =>
				db.prepare("SELECT 1 FROM sqlite_schema WHERE name='arr_snapshot_dates_update'").get(),
			),
		).toBeUndefined();
	});
	it("refuses marker corruption while preserving the affected data", async () => {
		writeDate("2026-11-17T00:01:00.000+00:00");
		database((db) => db.exec('UPDATE "ArrSnapshotDateValidation" SET dirtyCount=dirtyCount+1'));
		const before = snapshots();
		await expect(synchronizeSqliteRuntimeSchema(url)).rejects.toMatchObject({
			category: "format-migration-required",
		});
		expect(snapshots()).toEqual(before);
		expect(dirty()).toEqual(["snapshot"]);
	});
	it("refuses a dangling dirty key instead of clearing unverified evidence", async () => {
		writeDate("synthetic-invalid-date");
		database((db) => db.exec("UPDATE \"ArrSnapshotDateDirty\" SET id='missing-snapshot'"));
		const before = snapshots();
		await expect(synchronizeSqliteRuntimeSchema(url)).rejects.toMatchObject({
			category: "format-migration-required",
		});
		expect(snapshots()).toEqual(before);
		expect(dirty()).toEqual(["missing-snapshot"]);
	});
	it("revalidates history after a tracking trigger is removed and recreated identically", async () => {
		database((db) => {
			const { sql } = db
				.prepare("SELECT sql FROM sqlite_schema WHERE name='arr_snapshot_dates_update'")
				.get() as { sql: string };
			db.exec("DROP TRIGGER arr_snapshot_dates_update");
			db.prepare(
				"UPDATE session_snapshots SET capturedAt='synthetic-invalid-date' WHERE id='snapshot'",
			).run();
			db.exec(sql);
		});
		expect(dirty()).toEqual([]);
		const before = snapshots();
		await expect(synchronizeSqliteRuntimeSchema(url)).rejects.toMatchObject({
			category: "format-migration-required",
		});
		expect(snapshots()).toEqual(before);
	});
	it("applies the full validator's four-digit-year rule to dirty timestamps", async () => {
		writeDate("+010000-01-01T00:00:00.000+00:00");
		const before = snapshots();
		await expect(synchronizeSqliteRuntimeSchema(url)).rejects.toMatchObject({
			category: "format-migration-required",
		});
		expect(dirty()).toEqual(["snapshot"]);
		expect(snapshots()).toEqual(before);
	});
	it("retains one pending key after an SQLite replace operation", async () => {
		writeDate("2026-11-17T00:01:00.000+00:00");
		database((db) =>
			db
				.prepare(
					"INSERT OR REPLACE INTO session_snapshots(id,instanceId,capturedAt,concurrentStreams,sessionsJson) VALUES('snapshot','source',?,0,'replaced opaque')",
				)
				.run(date),
		);
		expect(dirty()).toEqual(["snapshot"]);
		await synchronizeSqliteRuntimeSchema(url);
		expect(dirty()).toEqual([]);
		expect(snapshots()).toEqual([
			expect.objectContaining({ capturedAt: date, sessionsJson: "replaced opaque" }),
		]);
	});
	it("bounds dirty keys and performs a full validation after capacity is exhausted", async () => {
		database((db) =>
			db.exec(`WITH RECURSIVE sequence(n) AS
			(VALUES(1) UNION ALL SELECT n+1 FROM sequence WHERE n<100001)
			INSERT INTO session_snapshots(id,instanceId,capturedAt,concurrentStreams,sessionsJson)
			SELECT 'capacity-'||n,'source','${date}',0,'opaque' FROM sequence`),
		);
		expect(
			database((db) =>
				db.prepare('SELECT dirtyCount,fullScanRequired FROM "ArrSnapshotDateValidation"').get(),
			),
		).toEqual({ dirtyCount: 100000, fullScanRequired: 1 });
		const queries = vi.spyOn(Database.prototype, "prepare");
		await synchronizeSqliteRuntimeSchema(url);
		expect(
			queries.mock.calls.some(([sql]) =>
				sql.includes('FROM main."session_snapshots" ORDER BY _rowid_'),
			),
		).toBe(true);
		queries.mockRestore();
		expect(dirty()).toEqual([]);
		expect(
			database((db) => db.prepare("SELECT COUNT(*) AS count FROM session_snapshots").get()),
		).toEqual({ count: 100002 });
	}, 20_000);
});
