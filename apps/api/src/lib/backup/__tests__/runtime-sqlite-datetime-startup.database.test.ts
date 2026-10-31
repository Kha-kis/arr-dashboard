import { existsSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadRuntimeSchemaRegistry,
	prepareRuntimeSchemaExecution,
} from "../runtime-schema-registry.js";
import { synchronizeSqliteRuntimeSchema } from "../runtime-schema-sqlite.js";

describe("SQLite date-format startup admission", () => {
	let directory: string;
	let path: string;
	let url: string;
	const connect = () => new Database(path, { fileMustExist: true, timeout: 0 });
	const read = (sql: string) => {
		const db = connect();
		try {
			return db.prepare(sql).all();
		} finally {
			db.close();
		}
	};
	const change = (sql: string) => {
		const db = connect();
		try {
			db.exec(sql);
		} finally {
			db.close();
		}
	};
	const previousGrabDigest = "3da1d2a3f20b99398c59d5dd2e9e42c58c52b42fab85eec3f2b8a0ff8f48d13c";
	const previousOutboxDigest = "b6e86495dde99cde0a3f93fddb35afabfbfed5b7f66afb0a14143c2306c0d798";
	const previousQuiDigest = "dfff1559e9d891f254c5c830d36ec7d8e188c5e342d1bdb840baa33437a555c1";
	const currentDateDigest = "059526a07e5f503d51c02273353515471d0d4b6f3d65ffbb40b8e612d5fd0889";
	async function previousGrabSchema(dropTables = true) {
		await synchronizeSqliteRuntimeSchema(url);
		// The historical receipt predates all three additions, not just Grab. Preserve
		// existing enrolled population while recreating its exact old table set.
		change(`${dropTables ? "DROP TABLE qui_torrent_observations; DROP TABLE qui_observation_publications; DROP TABLE NotificationOutboxDelivery; DROP TABLE NotificationOutboxEvent; DROP TABLE SearchGrabClaim; DROP TABLE SearchGrabAttempt; DROP INDEX ServiceInstance_id_userId_key;" : ""}
			UPDATE ArrRuntimeDataFormatReceipt SET dateColumnsDigest='${previousGrabDigest}'`);
	}
	async function previousOutboxSchema(remainingTable?: "event" | "delivery") {
		await synchronizeSqliteRuntimeSchema(url);
		change(`DROP TABLE qui_torrent_observations; DROP TABLE qui_observation_publications;
			${remainingTable === "delivery" ? "" : "DROP TABLE NotificationOutboxDelivery;"}
			${remainingTable === "event" ? "" : "DROP TABLE NotificationOutboxEvent;"}
			UPDATE ArrRuntimeDataFormatReceipt SET dateColumnsDigest='${previousOutboxDigest}'`);
	}
	async function previousQuiSchema(remainingTable?: "publication" | "observations") {
		await synchronizeSqliteRuntimeSchema(url);
		change(`${remainingTable === "observations" ? "" : "DROP TABLE qui_torrent_observations;"}
			${remainingTable === "publication" ? "" : "DROP TABLE qui_observation_publications;"}
			UPDATE ArrRuntimeDataFormatReceipt SET dateColumnsDigest='${previousQuiDigest}'`);
	}
	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), "arr-date-startup-"));
		path = join(directory, "main.db");
		url = `file:${path}`;
		const db = new Database(path);
		try {
			db.pragma("foreign_keys=ON");
			db.pragma("journal_mode=WAL");
			db.exec("BEGIN EXCLUSIVE");
			await prepareRuntimeSchemaExecution(loadRuntimeSchemaRegistry("sqlite"), {
				provider: "sqlite",
				tables: [],
			}).execute((sql) => {
				db.exec(sql);
			});
			db.exec(`DROP TABLE ArrSchemaMigrationReceipt;
				DROP TABLE IF EXISTS ArrRuntimeDataFormatReceipt;
				INSERT INTO User(id,username,hashedPassword,createdAt,updatedAt)
				VALUES('fixture-owner','fixture-owner','opaque-password',0,'2023-11-14T22:13:20.000+00:00');
				INSERT INTO sessions(id,userId,expiresAt,createdAt,lastAccessedAt)
				VALUES('fixture-session','fixture-owner',1893456000123,'2023-11-14 22:13:20','2023-11-14T22:13:20.000+00:00');
				CREATE TABLE FixtureCustom(id INTEGER PRIMARY KEY,unmanagedDate DATETIME);
				INSERT INTO FixtureCustom VALUES(7,'not-managed');
				COMMIT;`);
		} finally {
			db.close();
		}
	});
	afterEach(() => {
		expect(directory.startsWith(join(tmpdir(), "arr-date-startup-"))).toBe(true);
		expect(lstatSync(directory).isSymbolicLink()).toBe(false);
		rmSync(directory, { recursive: true });
	});
	it("preserves a valid numeric future session before returning physically closed startup", async () => {
		const inode = lstatSync(path).ino;
		const roots = read("SELECT name,rootpage FROM sqlite_schema WHERE type='table' ORDER BY name");
		await expect(synchronizeSqliteRuntimeSchema(url)).resolves.toEqual({
			apiPort: null,
			webPort: null,
			listenAddress: null,
		});
		expect(read("SELECT id,userId,expiresAt,createdAt,lastAccessedAt FROM sessions")).toEqual([
			{
				id: "fixture-session",
				userId: "fixture-owner",
				expiresAt: "2030-01-01T00:00:00.123+00:00",
				createdAt: "2023-11-14T22:13:20.000+00:00",
				lastAccessedAt: "2023-11-14T22:13:20.000+00:00",
			},
		]);
		expect(read("SELECT id,hashedPassword,createdAt,updatedAt FROM User")).toEqual([
			{
				id: "fixture-owner",
				hashedPassword: "opaque-password",
				createdAt: "1970-01-01T00:00:00.000+00:00",
				updatedAt: "2023-11-14T22:13:20.000+00:00",
			},
		]);
		expect(read("SELECT * FROM FixtureCustom")).toEqual([{ id: 7, unmanagedDate: "not-managed" }]);
		expect(read("SELECT formatVersion,normalizedValues FROM ArrRuntimeDataFormatReceipt")).toEqual([
			{ formatVersion: 1, normalizedValues: 3 },
		]);
		const after = read("SELECT name,rootpage FROM sqlite_schema WHERE type='table' ORDER BY name");
		for (const row of roots) expect(after).toContainEqual(row);
		expect(lstatSync(path).ino).toBe(inode);
		const probe = connect();
		try {
			probe.exec("BEGIN EXCLUSIVE; ROLLBACK");
			expect(probe.pragma("foreign_key_check")).toEqual([]);
		} finally {
			probe.close();
		}
	});
	it.each([
		["index", "sessions_userId_idx"],
		["index", "SESSIONS_USERID_IDX"],
		["table", "sessions_userId_idx"],
		["table", "SESSIONS_USERID_IDX"],
		["view", "sessions_userId_idx"],
		["view", "SESSIONS_USERID_IDX"],
	])(
		"refuses a registered index name occupied by a custom %s before cold coordination: %s",
		async (type, name) => {
			change(`DROP INDEX sessions_userId_idx;
			${type === "index" ? `CREATE INDEX "${name}" ON FixtureCustom(id)` : type === "table" ? `CREATE TABLE "${name}"(id INTEGER PRIMARY KEY)` : `CREATE VIEW "${name}" AS SELECT id FROM FixtureCustom`}`);
			const sessions = read("SELECT * FROM sessions");
			const custom = read("SELECT * FROM FixtureCustom");
			const objects = read("SELECT name,type,sql FROM sqlite_schema ORDER BY name");
			await expect(synchronizeSqliteRuntimeSchema(url)).rejects.toMatchObject({
				category: "startup-unavailable",
			});
			expect(read("SELECT * FROM sessions")).toEqual(sessions);
			expect(read("SELECT * FROM FixtureCustom")).toEqual(custom);
			expect(read("SELECT name,type,sql FROM sqlite_schema ORDER BY name")).toEqual(objects);
			expect(existsSync(`${path}.arr-restore-runtime`)).toBe(false);
			expect(read("SELECT * FROM RestoreRuntimeControl")).toEqual([]);
			expect(read("SELECT * FROM SqliteRestoreStorageBinding")).toEqual([]);
			change(`DROP ${type.toUpperCase()} "${name}"`);
			await expect(synchronizeSqliteRuntimeSchema(url)).resolves.toEqual({
				apiPort: null,
				webPort: null,
				listenAddress: null,
			});
			expect(read("SELECT * FROM FixtureCustom")).toEqual(custom);
			expect(read("SELECT id,expiresAt FROM sessions")).toEqual([
				{ id: "fixture-session", expiresAt: "2030-01-01T00:00:00.123+00:00" },
			]);
		},
	);
	it("retains a compatible custom trigger in SQLite's separate index-name namespace", async () => {
		change(`DROP INDEX sessions_userId_idx;
			CREATE TRIGGER sessions_userId_idx AFTER INSERT ON FixtureCustom BEGIN SELECT 1; END`);
		await synchronizeSqliteRuntimeSchema(url);
		expect(
			read(
				"SELECT type,tbl_name FROM sqlite_schema WHERE name='sessions_userId_idx' ORDER BY type",
			),
		).toEqual([
			{ type: "index", tbl_name: "sessions" },
			{ type: "trigger", tbl_name: "FixtureCustom" },
		]);
		expect(read("SELECT * FROM FixtureCustom")).toEqual([{ id: 7, unmanagedDate: "not-managed" }]);
	});
	it("retains the exact format receipt and physical binding across a same-volume restart", async () => {
		await synchronizeSqliteRuntimeSchema(url);
		const receipt = read("SELECT * FROM ArrRuntimeDataFormatReceipt");
		const binding = read("SELECT * FROM SqliteRestoreStorageBinding");
		const sessions = read("SELECT * FROM sessions");
		await synchronizeSqliteRuntimeSchema(url);
		expect(read("SELECT * FROM ArrRuntimeDataFormatReceipt")).toEqual(receipt);
		expect(read("SELECT * FROM SqliteRestoreStorageBinding")).toEqual(binding);
		expect(read("SELECT * FROM sessions")).toEqual(sessions);
		expect(read("SELECT count(*) AS n FROM ArrSchemaMigrationReceipt")).toEqual([{ n: 2 }]);
	});
	it("advances only the exact pre-Grab date receipt while conserving enrolled population and binding", async () => {
		await previousGrabSchema();
		const prior = read("SELECT * FROM ArrRuntimeDataFormatReceipt");
		const users = read("SELECT * FROM User");
		const sessions = read("SELECT * FROM sessions");
		const binding = read("SELECT * FROM SqliteRestoreStorageBinding");
		await synchronizeSqliteRuntimeSchema(url);
		expect(read("SELECT * FROM User")).toEqual(users);
		expect(read("SELECT * FROM sessions")).toEqual(sessions);
		expect(read("SELECT * FROM SqliteRestoreStorageBinding")).toEqual(binding);
		expect(
			read(
				"SELECT formatVersion,dateColumnsDigest,normalizedValues FROM ArrRuntimeDataFormatReceipt",
			),
		).toEqual([
			{
				formatVersion: 1,
				dateColumnsDigest: currentDateDigest,
				normalizedValues: 3,
			},
		]);
		expect(prior).toHaveLength(1);
		expect(read("SELECT count(*) AS n FROM SearchGrabAttempt")).toEqual([{ n: 0 }]);
		expect(read("SELECT count(*) AS n FROM SearchGrabClaim")).toEqual([{ n: 0 }]);
		const advanced = read("SELECT * FROM ArrRuntimeDataFormatReceipt");
		await synchronizeSqliteRuntimeSchema(url);
		expect(read("SELECT * FROM ArrRuntimeDataFormatReceipt")).toEqual(advanced);
	});
	it("advances the exact pre-Outbox receipt without rewriting enrolled population or binding", async () => {
		await previousOutboxSchema();
		const inode = lstatSync(path).ino;
		const users = read("SELECT * FROM User");
		const sessions = read("SELECT * FROM sessions");
		const binding = read("SELECT * FROM SqliteRestoreStorageBinding");
		const roots = read("SELECT name,rootpage FROM sqlite_schema WHERE type='table' ORDER BY name");
		await synchronizeSqliteRuntimeSchema(url);
		expect(read("SELECT * FROM User")).toEqual(users);
		expect(read("SELECT * FROM sessions")).toEqual(sessions);
		expect(read("SELECT * FROM SqliteRestoreStorageBinding")).toEqual(binding);
		expect(lstatSync(path).ino).toBe(inode);
		const after = read("SELECT name,rootpage FROM sqlite_schema WHERE type='table' ORDER BY name");
		for (const original of roots) expect(after).toContainEqual(original);
		expect(read("SELECT * FROM FixtureCustom")).toEqual([{ id: 7, unmanagedDate: "not-managed" }]);
		expect(read("SELECT count(*) AS n FROM NotificationOutboxEvent")).toEqual([{ n: 0 }]);
		expect(read("SELECT count(*) AS n FROM NotificationOutboxDelivery")).toEqual([{ n: 0 }]);
		expect(
			read(
				"SELECT formatVersion,dateColumnsDigest,normalizedValues FROM ArrRuntimeDataFormatReceipt",
			),
		).toEqual([
			{
				formatVersion: 1,
				dateColumnsDigest: currentDateDigest,
				normalizedValues: 3,
			},
		]);
		const receipt = read("SELECT * FROM ArrRuntimeDataFormatReceipt");
		await synchronizeSqliteRuntimeSchema(url);
		expect(read("SELECT * FROM ArrRuntimeDataFormatReceipt")).toEqual(receipt);
		expect(read("SELECT * FROM sessions")).toEqual(sessions);
		const probe = connect();
		try {
			probe.exec("BEGIN EXCLUSIVE; ROLLBACK");
			expect(probe.pragma("foreign_key_check")).toEqual([]);
		} finally {
			probe.close();
		}
	});
	it("advances the exact pre-qUI receipt and preserves enrolled data through restart", async () => {
		await previousQuiSchema();
		const inode = lstatSync(path).ino;
		const users = read("SELECT * FROM User");
		const sessions = read("SELECT * FROM sessions");
		const binding = read("SELECT * FROM SqliteRestoreStorageBinding");
		const custom = read("SELECT * FROM FixtureCustom");
		const roots = read("SELECT name,rootpage FROM sqlite_schema WHERE type='table' ORDER BY name");
		await synchronizeSqliteRuntimeSchema(url);
		expect(read("SELECT * FROM User")).toEqual(users);
		expect(read("SELECT * FROM sessions")).toEqual(sessions);
		expect(read("SELECT * FROM SqliteRestoreStorageBinding")).toEqual(binding);
		expect(read("SELECT * FROM FixtureCustom")).toEqual(custom);
		expect(lstatSync(path).ino).toBe(inode);
		const after = read("SELECT name,rootpage FROM sqlite_schema WHERE type='table' ORDER BY name");
		for (const original of roots) expect(after).toContainEqual(original);
		expect(read("SELECT count(*) AS n FROM qui_observation_publications")).toEqual([{ n: 0 }]);
		expect(read("SELECT count(*) AS n FROM qui_torrent_observations")).toEqual([{ n: 0 }]);
		expect(
			read(
				"SELECT formatVersion,dateColumnsDigest,normalizedValues FROM ArrRuntimeDataFormatReceipt",
			),
		).toEqual([{ formatVersion: 1, dateColumnsDigest: currentDateDigest, normalizedValues: 3 }]);
		const receipt = read("SELECT * FROM ArrRuntimeDataFormatReceipt");
		await synchronizeSqliteRuntimeSchema(url);
		expect(read("SELECT * FROM ArrRuntimeDataFormatReceipt")).toEqual(receipt);
		expect(read("SELECT * FROM sessions")).toEqual(sessions);
		expect(read("SELECT * FROM SqliteRestoreStorageBinding")).toEqual(binding);
	});
	it.each(["publication", "observations"] as const)(
		"refuses a retained qUI table while conserving the predecessor database: %s",
		async (remainingTable) => {
			await previousQuiSchema(remainingTable);
			const objects = read("SELECT name,type,sql FROM sqlite_schema ORDER BY name");
			const receipt = read("SELECT * FROM ArrRuntimeDataFormatReceipt");
			const sessions = read("SELECT * FROM sessions");
			const binding = read("SELECT * FROM SqliteRestoreStorageBinding");
			await expect(synchronizeSqliteRuntimeSchema(url)).rejects.toMatchObject({
				category: "format-migration-required",
			});
			expect(read("SELECT name,type,sql FROM sqlite_schema ORDER BY name")).toEqual(objects);
			expect(read("SELECT * FROM ArrRuntimeDataFormatReceipt")).toEqual(receipt);
			expect(read("SELECT * FROM sessions")).toEqual(sessions);
			expect(read("SELECT * FROM SqliteRestoreStorageBinding")).toEqual(binding);
		},
	);
	it("rolls back the qUI tables and receipt advancement when final settings refuse startup", async () => {
		await previousQuiSchema();
		change(
			"INSERT INTO system_settings(id,apiPort,createdAt,updatedAt) VALUES(1,0,'2023-11-14T22:13:20.000+00:00','2023-11-14T22:13:20.000+00:00')",
		);
		const objects = read("SELECT name,type,sql FROM sqlite_schema ORDER BY name");
		const receipt = read("SELECT * FROM ArrRuntimeDataFormatReceipt");
		const sessions = read("SELECT * FROM sessions");
		const binding = read("SELECT * FROM SqliteRestoreStorageBinding");
		await expect(synchronizeSqliteRuntimeSchema(url)).rejects.toMatchObject({
			category: "startup-unavailable",
		});
		expect(read("SELECT name,type,sql FROM sqlite_schema ORDER BY name")).toEqual(objects);
		expect(read("SELECT * FROM ArrRuntimeDataFormatReceipt")).toEqual(receipt);
		expect(read("SELECT * FROM sessions")).toEqual(sessions);
		expect(read("SELECT * FROM SqliteRestoreStorageBinding")).toEqual(binding);
	});
	it.each(["event", "delivery", "receipt", "date"] as const)(
		"refuses an inconsistent pre-Outbox transition and conserves the original database: %s",
		async (inconsistency) => {
			await previousOutboxSchema(
				inconsistency === "event" || inconsistency === "delivery" ? inconsistency : undefined,
			);
			if (inconsistency === "receipt")
				change("UPDATE ArrRuntimeDataFormatReceipt SET dateColumnsDigest='invalid'");
			if (inconsistency === "date") change("UPDATE sessions SET expiresAt=1893456000123");
			const objects = read("SELECT name,type,sql FROM sqlite_schema ORDER BY name");
			const receipt = read("SELECT * FROM ArrRuntimeDataFormatReceipt");
			const users = read("SELECT * FROM User");
			const sessions = read("SELECT * FROM sessions");
			const binding = read("SELECT * FROM SqliteRestoreStorageBinding");
			await expect(synchronizeSqliteRuntimeSchema(url)).rejects.toMatchObject({
				// A retained delivery table references the absent event table, so the
				// native schema preflight refuses before date-receipt admission.
				category:
					inconsistency === "delivery" ? "startup-unavailable" : "format-migration-required",
			});
			expect(read("SELECT name,type,sql FROM sqlite_schema ORDER BY name")).toEqual(objects);
			expect(read("SELECT * FROM ArrRuntimeDataFormatReceipt")).toEqual(receipt);
			expect(read("SELECT * FROM User")).toEqual(users);
			expect(read("SELECT * FROM sessions")).toEqual(sessions);
			expect(read("SELECT * FROM SqliteRestoreStorageBinding")).toEqual(binding);
		},
	);
	it.each([
		"UPDATE ArrRuntimeDataFormatReceipt SET dateColumnsDigest='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'",
		"UPDATE sessions SET expiresAt=1893456000123",
	])(
		"refuses an unverified additive transition without changing data or schema: %s",
		async (sql) => {
			await previousGrabSchema();
			change(sql);
			const objects = read("SELECT name,type,sql FROM sqlite_schema ORDER BY name");
			const receipt = read("SELECT * FROM ArrRuntimeDataFormatReceipt");
			const sessions = read("SELECT * FROM sessions");
			const journal = read("SELECT * FROM RestoreRuntimeControl");
			await expect(synchronizeSqliteRuntimeSchema(url)).rejects.toMatchObject({
				category: "format-migration-required",
			});
			expect(read("SELECT name,type,sql FROM sqlite_schema ORDER BY name")).toEqual(objects);
			expect(read("SELECT * FROM ArrRuntimeDataFormatReceipt")).toEqual(receipt);
			expect(read("SELECT * FROM sessions")).toEqual(sessions);
			expect(read("SELECT * FROM RestoreRuntimeControl")).toEqual(journal);
		},
	);
	it("refuses predecessor-receipt adoption when the new tables already exist", async () => {
		await previousGrabSchema(false);
		const receipt = read("SELECT * FROM ArrRuntimeDataFormatReceipt");
		await expect(synchronizeSqliteRuntimeSchema(url)).rejects.toMatchObject({
			category: "format-migration-required",
		});
		expect(read("SELECT * FROM ArrRuntimeDataFormatReceipt")).toEqual(receipt);
	});
	it("rolls back the additive tables and receipt advancement if final settings refuse startup", async () => {
		await previousGrabSchema();
		change(
			"INSERT INTO system_settings(id,apiPort,createdAt,updatedAt) VALUES(1,0,'2023-11-14T22:13:20.000+00:00','2023-11-14T22:13:20.000+00:00')",
		);
		const objects = read("SELECT name,type,sql FROM sqlite_schema ORDER BY name");
		const receipt = read("SELECT * FROM ArrRuntimeDataFormatReceipt");
		const sessions = read("SELECT * FROM sessions");
		await expect(synchronizeSqliteRuntimeSchema(url)).rejects.toMatchObject({
			category: "startup-unavailable",
		});
		expect(read("SELECT name,type,sql FROM sqlite_schema ORDER BY name")).toEqual(objects);
		expect(read("SELECT * FROM ArrRuntimeDataFormatReceipt")).toEqual(receipt);
		expect(read("SELECT * FROM sessions")).toEqual(sessions);
	});
	it.each([
		"UPDATE sessions SET expiresAt='invalid-private-date'",
		"CREATE TRIGGER FixtureAffected AFTER UPDATE OF expiresAt ON sessions BEGIN UPDATE User SET hashedPassword='changed'; END",
	])(
		"refuses incompatible date effects before coordination, DDL or data changes: %s",
		async (sql) => {
			change(sql);
			const rows = read("SELECT * FROM sessions");
			const objects = read("SELECT name,type,sql FROM sqlite_schema ORDER BY name");
			await expect(synchronizeSqliteRuntimeSchema(url)).rejects.toMatchObject({
				category: "format-migration-required",
			});
			expect(read("SELECT * FROM sessions")).toEqual(rows);
			expect(read("SELECT name,type,sql FROM sqlite_schema ORDER BY name")).toEqual(objects);
			expect(existsSync(`${path}.arr-restore-runtime`)).toBe(false);
			expect(read("SELECT * FROM RestoreRuntimeControl")).toEqual([]);
			expect(read("SELECT * FROM SqliteRestoreStorageBinding")).toEqual([]);
		},
	);
	it("refuses noncanonical writes after publication rather than repairing a contradicted receipt", async () => {
		await synchronizeSqliteRuntimeSchema(url);
		change("UPDATE sessions SET expiresAt=1893456000123");
		const receipt = read("SELECT * FROM ArrRuntimeDataFormatReceipt");
		const journal = read("SELECT * FROM RestoreRuntimeControl");
		await expect(synchronizeSqliteRuntimeSchema(url)).rejects.toMatchObject({
			category: "format-migration-required",
		});
		expect(read("SELECT * FROM ArrRuntimeDataFormatReceipt")).toEqual(receipt);
		expect(read("SELECT * FROM RestoreRuntimeControl")).toEqual(journal);
		expect(read("SELECT expiresAt FROM sessions")).toEqual([{ expiresAt: 1893456000123 }]);
	});
	it("does not adopt a positive format receipt after its physical anchor was removed", async () => {
		await synchronizeSqliteRuntimeSchema(url);
		change(
			"DELETE FROM SqliteRestoreStorageBinding; DELETE FROM RestoreRuntimeControl; DROP TABLE ArrSchemaMigrationReceipt",
		);
		rmSync(`${path}.arr-restore-runtime`, { recursive: true });
		const objects = read("SELECT name,type,sql FROM sqlite_schema ORDER BY name");
		const receipt = read("SELECT * FROM ArrRuntimeDataFormatReceipt");
		await expect(synchronizeSqliteRuntimeSchema(url)).rejects.toMatchObject({
			category: "startup-unavailable",
		});
		expect(read("SELECT * FROM ArrRuntimeDataFormatReceipt")).toEqual(receipt);
		expect(read("SELECT name,type,sql FROM sqlite_schema ORDER BY name")).toEqual(objects);
		expect(read("SELECT * FROM SqliteRestoreStorageBinding")).toEqual([]);
		expect(existsSync(`${path}.arr-restore-runtime`)).toBe(false);
	});
	it("rolls back normalized values and the format marker when final settings are invalid", async () => {
		change(
			"INSERT INTO system_settings(id,apiPort,createdAt,updatedAt) VALUES(1,0,'2023-11-14T22:13:20.000+00:00','2023-11-14T22:13:20.000+00:00')",
		);
		const sessions = read("SELECT * FROM sessions");
		const users = read("SELECT * FROM User");
		const objects = read("SELECT name,type,sql FROM sqlite_schema ORDER BY name");
		await expect(synchronizeSqliteRuntimeSchema(url)).rejects.toMatchObject({
			category: "startup-unavailable",
		});
		expect(read("SELECT * FROM sessions")).toEqual(sessions);
		expect(read("SELECT * FROM User")).toEqual(users);
		expect(read("SELECT name,type,sql FROM sqlite_schema ORDER BY name")).toEqual(objects);
		expect(read("SELECT * FROM SqliteRestoreStorageBinding")).toEqual([]);
		expect(read("SELECT * FROM RestoreRuntimeControl")).toEqual([]);
	});
});
