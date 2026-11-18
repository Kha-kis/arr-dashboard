import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	loadRuntimeSchemaRegistry,
	prepareRuntimeSchemaExecution,
} from "../runtime-schema-registry.js";
import { synchronizeSqliteRuntimeSchema } from "../runtime-schema-sqlite.js";
import { isSqliteForeignKeyValidationTrigger } from "../runtime-sqlite-foreign-keys.js";

const date = "2026-11-17T00:00:00.000+00:00";

describe("native startup date and FK checkpoint coordination", () => {
	let directory: string;
	let path: string;
	let url: string;
	function database<T>(action: (db: Database.Database) => T): T {
		const db = new Database(path, { fileMustExist: true, timeout: 0 });
		try {
			return action(db);
		} finally {
			db.close();
		}
	}
	const snapshots = () =>
		database((db) => db.prepare("SELECT * FROM session_snapshots ORDER BY id").all());
	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), "arr-checkpoint-coordination-"));
		chmodSync(directory, 0o700);
		path = join(directory, "owned.db");
		url = `file:${path}`;
		const db = new Database(path);
		try {
			db.pragma("foreign_keys=ON");
			db.exec("BEGIN EXCLUSIVE");
			await prepareRuntimeSchemaExecution(loadRuntimeSchemaRegistry("sqlite"), {
				provider: "sqlite",
				tables: [],
			}).execute((sql) => {
				db.exec(sql);
			});
			// Populate the registered schema before its first runtime enrollment.
			// A second setup startup would already repair the stale date cookie.
			db.exec("DROP TABLE ArrSchemaMigrationReceipt");
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
			db.exec("COMMIT");
		} finally {
			if (db.inTransaction) db.exec("ROLLBACK");
			db.close();
		}
	});
	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(directory, { recursive: true });
	});

	it("seals both checkpoint cookies at the actual schema cookie on the first commit", async () => {
		const before = snapshots();
		await synchronizeSqliteRuntimeSchema(url);
		const checkpoints = database((db) => ({
			actual: db.pragma("main.schema_version", { simple: true }),
			dates: db
				.prepare('SELECT schemaCookie FROM "ArrSnapshotDateValidation" WHERE id=1')
				.pluck()
				.get(),
			foreignKeys: db
				.prepare('SELECT schemaCookie FROM "ArrForeignKeyValidation" WHERE id=1')
				.pluck()
				.get(),
		}));
		expect(snapshots()).toEqual(before);
		expect(checkpoints).toEqual({
			actual: checkpoints.actual,
			dates: checkpoints.actual,
			foreignKeys: checkpoints.actual,
		});
	});

	it("reuses both first-commit checkpoints on immediate reopen without full date or FK scans", async () => {
		await synchronizeSqliteRuntimeSchema(url);
		const before = snapshots();
		const prepare = vi.spyOn(Database.prototype, "prepare");
		const pragma = vi.spyOn(Database.prototype, "pragma");
		await synchronizeSqliteRuntimeSchema(url);
		const queries = prepare.mock.calls.map(([sql]) => sql);
		const fullSnapshotProjections = queries.filter(
			(sql) => sql.includes('FROM main."session_snapshots"') && sql.includes('"capturedAt"'),
		);
		const nativeForeignKeyChecks = pragma.mock.calls
			.map(([sql]) => sql)
			.filter((sql) => sql.includes("foreign_key_check"));
		const indexedForeignKeyChecks = queries.filter((sql) =>
			sql.startsWith("WITH RECURSIVE reference_keys"),
		);
		vi.restoreAllMocks();
		expect(snapshots()).toEqual(before);
		expect(nativeForeignKeyChecks).toEqual([]);
		expect(indexedForeignKeyChecks).toEqual([]);
		expect(fullSnapshotProjections).toEqual([]);
	});

	it.each(["installed", "removed"] as const)(
		"preserves sealed-date refusal with the owned User FK UPDATE guard %s",
		async (guardState) => {
			await synchronizeSqliteRuntimeSchema(url);
			const raw = database((db) => {
				db.pragma("foreign_keys=ON");
				const guards = db
					.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE tbl_name='User'")
					.all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
				const updateGuards = guards.filter(
					(object) =>
						isSqliteForeignKeyValidationTrigger(object) && object.sql?.includes("BEFORE UPDATE"),
				);
				expect(updateGuards).toHaveLength(1);
				if (guardState === "removed") {
					const guard = updateGuards[0]!;
					db.exec(`DROP TRIGGER main."${guard.name}"`);
					expect(
						db
							.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE tbl_name='User'")
							.all(),
					).toEqual(guards.filter((object) => object.name !== guard.name));
				}
				expect(
					db
						.prepare("SELECT dflt_value FROM pragma_table_info('User') WHERE name='createdAt'")
						.get(),
				).toEqual({ dflt_value: "CURRENT_TIMESTAMP" });
				db.prepare(
					"INSERT INTO User(id,username,updatedAt) VALUES('default-owner','default-owner',?)",
				).run(date);
				return db.prepare("SELECT createdAt FROM User WHERE id='default-owner'").pluck().get();
			});
			expect(raw).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
			const state = () =>
				database((db) => ({
					users: db.prepare("SELECT * FROM User ORDER BY id").all(),
					snapshots: db.prepare("SELECT * FROM session_snapshots ORDER BY id").all(),
					schema: db.prepare("SELECT * FROM sqlite_schema ORDER BY type,name").all(),
					cookie: db.pragma("main.schema_version", { simple: true }),
					protocols: Object.fromEntries(
						[
							"ArrRuntimeDataFormatReceipt",
							"ArrSchemaMigrationReceipt",
							"ArrSnapshotDateValidation",
							"ArrSnapshotDateDirty",
							"ArrForeignKeyValidation",
							"SqliteRestoreStorageBinding",
							"RestoreRuntimeControl",
						].map((table) => [table, db.prepare(`SELECT * FROM "${table}" ORDER BY id`).all()]),
					),
				}));
			const before = state();
			await expect(synchronizeSqliteRuntimeSchema(url)).rejects.toMatchObject({
				category: "format-migration-required",
			});
			expect(state()).toEqual(before);
		},
	);
});
