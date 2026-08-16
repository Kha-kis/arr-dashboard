import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const postgresUrl = process.env.TEST_POSTGRES_URL;
const describePostgres = postgresUrl ? describe : describe.skip;

describePostgres("PostgreSQL v2.24 list-cache pre-sync migration", () => {
	const schema = `pre_sync_${randomUUID().replaceAll("-", "")}`;
	const migration = readFileSync(
		resolve(process.cwd(), "prisma/pre-sync/postgresql-v2.24-list-cache-identity.sql"),
		"utf8",
	);
	let admin: Client;

	beforeAll(async () => {
		admin = new Client({ connectionString: postgresUrl });
		await admin.connect();
		await admin.query(`CREATE SCHEMA "${schema}"`);
		await admin.query(`
			CREATE TABLE "${schema}"."tmdb_list_cache" (
				"userId" text NOT NULL,
				"listId" text NOT NULL,
				"mediaType" text NOT NULL,
				"tmdbId" integer NOT NULL
			);
			CREATE UNIQUE INDEX "tmdb_list_cache_userId_listId_tmdbId_key"
				ON "${schema}"."tmdb_list_cache" ("userId", "listId", "tmdbId");
			CREATE TABLE "${schema}"."trakt_list_cache" (
				"userId" text NOT NULL,
				"listSlug" text NOT NULL,
				"mediaType" text NOT NULL,
				"tmdbId" integer NOT NULL
			);
			CREATE UNIQUE INDEX "trakt_list_cache_userId_listSlug_tmdbId_key"
				ON "${schema}"."trakt_list_cache" ("userId", "listSlug", "tmdbId");
			INSERT INTO "${schema}"."tmdb_list_cache"
			SELECT 'user', 'list', 'movie', value FROM generate_series(1, 1000) AS value;
			INSERT INTO "${schema}"."trakt_list_cache"
			SELECT 'user', 'owner/list', 'series', value FROM generate_series(1, 1000) AS value;
		`);
	});

	afterAll(async () => {
		if (admin) {
			await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
			await admin.end();
		}
	});

	it("allows two startup attempts to reconcile the same populated schema", async () => {
		const runMigration = async () => {
			const client = new Client({ connectionString: postgresUrl });
			await client.connect();
			try {
				await client.query(`SET search_path TO "${schema}"`);
				await client.query(migration);
			} finally {
				await client.end();
			}
		};

		await Promise.all([runMigration(), runMigration()]);

		const result = await admin.query<{ indexname: string }>(
			`SELECT indexname
			 FROM pg_indexes
			 WHERE schemaname = $1
			   AND tablename IN ('tmdb_list_cache', 'trakt_list_cache')
			   AND indexname LIKE '%_key'
			 ORDER BY indexname`,
			[schema],
		);

		expect(result.rows.map((row) => row.indexname)).toEqual([
			"tmdb_list_cache_userId_listId_mediaType_tmdbId_key",
			"trakt_list_cache_userId_listSlug_mediaType_tmdbId_key",
		]);
	});
});
