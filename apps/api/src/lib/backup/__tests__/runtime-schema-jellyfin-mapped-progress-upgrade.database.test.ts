import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { readPostgresRuntimeSchemaCatalog } from "../runtime-schema-postgres.js";
import {
	loadRuntimeSchemaRegistry,
	prepareRuntimeSchemaExecution,
	readRuntimeSchemaRegistryTargets,
	type RuntimeSchemaExecution,
} from "../runtime-schema-registry.js";
import { readSqliteRuntimeSchemaCatalog } from "../runtime-schema-sqlite.js";

const table = "jellyfin_episode_generation_show_receipts";
const addColumn = `ALTER TABLE "${table}" ADD COLUMN "mappedProgressJson" TEXT;`;
const seed = `
INSERT INTO "User" ("id","username","updatedAt") VALUES ('owner','synthetic-owner','2026-11-11T12:00:00Z');
INSERT INTO "ServiceInstance" ("id","userId","service","label","baseUrl","encryptedApiKey","encryptionIv","updatedAt") VALUES ('instance','owner','JELLYFIN','Synthetic','http://synthetic.invalid','synthetic-cipher','synthetic-iv','2026-11-11T12:00:00Z');
INSERT INTO "${table}" ("id","instanceId","generationId","showTmdbId","rowCount","contentFingerprint") VALUES ('receipt','instance','old-generation',123,1,'synthetic-fingerprint');
INSERT INTO "jellyfin_episode_generation_rows" ("id","instanceId","generationId","showTmdbId","seasonNumber","episodeNumber","jellyfinId","title","watched","watchedByUsers","connectionGeneration","identityGeneration") VALUES ('episode','instance','old-generation',123,1,2,'synthetic-episode','Synthetic',true,'[]',1,2);
`;

async function proveAdditiveUpgrade(
	prepare: () => Promise<RuntimeSchemaExecution>,
	execute: (sql: string) => Promise<void>,
	readRows: (sql: string) => Promise<unknown[]>,
	readRelations: () => Promise<unknown[]>,
) {
	await (await prepare()).execute(execute);
	await execute(`ALTER TABLE "${table}" DROP COLUMN "mappedProgressJson";`);
	await execute(seed);
	const receipts = () => readRows(`SELECT * FROM "${table}" ORDER BY "id"`);
	const protectedRows = () =>
		Promise.all(
			["User", "ServiceInstance", "jellyfin_episode_generation_rows"].map((name) =>
				readRows(`SELECT * FROM "${name}" ORDER BY "id"`),
			),
		);
	const previousReceipts = await receipts();
	const previousProtectedRows = await protectedRows();
	const previousRelations = await readRelations();
	expect(previousReceipts).toHaveLength(1);
	expect(previousProtectedRows.map((rows) => rows.length)).toEqual([1, 1, 1]);

	await execute("SAVEPOINT interrupted_upgrade");
	const interrupted = await prepare();
	expect(interrupted.statementCount).toBe(1);
	const attempted: string[] = [];
	await expect(
		interrupted.execute(async (sql) => {
			await execute(sql);
			attempted.push(sql);
			throw new Error("synthetic failure after DDL");
		}),
	).rejects.toThrow("Database schema registry is unavailable.");
	expect(attempted).toEqual([addColumn]);
	await execute("ROLLBACK TO SAVEPOINT interrupted_upgrade");
	await execute("RELEASE SAVEPOINT interrupted_upgrade");
	expect(await receipts()).toEqual(previousReceipts);
	expect(await protectedRows()).toEqual(previousProtectedRows);
	expect(await readRelations()).toEqual(previousRelations);

	const upgrade = await prepare();
	expect(upgrade.statementCount).toBe(1);
	const applied: string[] = [];
	await upgrade.execute(async (sql) => {
		applied.push(sql);
		await execute(sql);
	});
	expect(applied).toEqual([addColumn]);
	expect(await receipts()).toEqual([
		{ ...(previousReceipts[0] as object), mappedProgressJson: null },
	]);
	expect(await protectedRows()).toEqual(previousProtectedRows);
	expect(await readRelations()).toEqual(previousRelations);
	expect(await prepare()).toMatchObject({ result: "ready", statementCount: 0 });
}

describe("Jellyfin mapped progress upgrade on populated synthetic native schemas", () => {
	it("preserves SQLite table and index root pages and rolls back after DDL", async () => {
		const database = new Database(":memory:");
		try {
			database.pragma("foreign_keys=ON");
			database.exec("BEGIN EXCLUSIVE");
			const registry = loadRuntimeSchemaRegistry("sqlite");
			const { tables } = readRuntimeSchemaRegistryTargets(registry);
			await proveAdditiveUpgrade(
				async () =>
					prepareRuntimeSchemaExecution(registry, readSqliteRuntimeSchemaCatalog(database, tables)),
				async (sql) => {
					database.exec(sql);
				},
				async (sql) => database.prepare(sql).all(),
				async () =>
					database
						.prepare(
							"SELECT name, rootpage FROM sqlite_schema WHERE type IN ('table', 'index') ORDER BY name",
						)
						.all(),
			);
			database.exec("COMMIT");
			expect(database.pragma("foreign_key_check")).toEqual([]);
		} finally {
			database.close();
		}
	});

	const connectionString = process.env.RUNTIME_SCHEMA_TEST_DATABASE_URL;
	it.skipIf(!connectionString)(
		"preserves PostgreSQL relation storage and rolls back after DDL",
		async () => {
			const database = new Client({
				connectionString,
				connectionTimeoutMillis: 5000,
				query_timeout: 5000,
				statement_timeout: 4000,
			});
			const namespace = `jellyfin_progress_${randomUUID().replaceAll("-", "")}`;
			try {
				await database.connect();
				await database.query("BEGIN");
				await database.query(`CREATE SCHEMA "${namespace}"`);
				await database.query(`SET LOCAL search_path TO "${namespace}"`);
				const registry = loadRuntimeSchemaRegistry("postgresql");
				const { tables, indexes, enums } = readRuntimeSchemaRegistryTargets(registry);
				await proveAdditiveUpgrade(
					async () => {
						const { catalog, missingEnums } = await readPostgresRuntimeSchemaCatalog(
							database,
							tables,
							enums,
							indexes,
						);
						return prepareRuntimeSchemaExecution(registry, catalog, missingEnums);
					},
					async (sql) => {
						await database.query(sql);
					},
					async (sql) => (await database.query(sql)).rows,
					async () =>
						(
							await database.query(
								`SELECT relname, oid::text, pg_relation_filenode(oid)::text AS filenode
							FROM pg_catalog.pg_class WHERE relnamespace = current_schema()::regnamespace
							AND relkind IN ('r', 'i') ORDER BY relname`,
							)
						).rows,
				);
			} finally {
				try {
					await database.query("ROLLBACK");
				} finally {
					await database.end();
				}
			}
		},
	);
});
