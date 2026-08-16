import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Docker schema synchronization contract", () => {
	const startupScript = readFileSync(
		resolve(process.cwd(), "../../docker/start-combined.sh"),
		"utf8",
	);
	const postgresListCacheMigration = readFileSync(
		resolve(process.cwd(), "prisma/pre-sync/postgresql-v2.24-list-cache-identity.sql"),
		"utf8",
	);
	const postgresSchemaSync = readFileSync(
		resolve(process.cwd(), "../../docker/sync-postgresql-schema.cjs"),
		"utf8",
	);

	it("synchronizes the runtime schema without approving data loss", () => {
		const schemaSyncCommand = startupScript
			.split("\n")
			.find((line) => line.includes("prisma db push"));

		expect(schemaSyncCommand).toContain("prisma db push --schema prisma/schema.prisma");
		expect(schemaSyncCommand).not.toContain("--accept-data-loss");
	});

	it("runs the reviewed PostgreSQL list-cache migration before schema synchronization", () => {
		const migration = postgresSchemaSync.indexOf(
			"prisma/pre-sync/postgresql-v2.24-list-cache-identity.sql",
		);
		const schemaSync = postgresSchemaSync.indexOf('"db", "push"');

		expect(startupScript).toContain('if [ "$DB_PROVIDER" = "postgresql" ]; then');
		expect(startupScript).toContain("node /app/api/sync-postgresql-schema.cjs");
		expect(migration).toBeGreaterThan(-1);
		expect(schemaSync).toBeGreaterThan(migration);
		expect(postgresSchemaSync).not.toContain("--accept-data-loss");
	});

	it.each([
		[
			"tmdb_list_cache",
			"tmdb_list_cache_userId_listId_mediaType_tmdbId_key",
			"tmdb_list_cache_userId_listId_tmdbId_key",
		],
		[
			"trakt_list_cache",
			"trakt_list_cache_userId_listSlug_mediaType_tmdbId_key",
			"trakt_list_cache_userId_listSlug_tmdbId_key",
		],
	])(
		"creates the %s replacement index before dropping its stricter predecessor",
		(table, replacement, predecessor) => {
			const tableGuard = postgresListCacheMigration.indexOf(`'${table}'`);
			const createReplacement = postgresListCacheMigration.indexOf(`'${replacement}'`);
			const dropPredecessor = postgresListCacheMigration.indexOf(`'${predecessor}'`);

			expect(tableGuard).toBeGreaterThan(-1);
			expect(createReplacement).toBeGreaterThan(tableGuard);
			expect(dropPredecessor).toBeGreaterThan(createReplacement);
		},
	);

	it("keeps the PostgreSQL index replacement atomic and non-destructive", () => {
		expect(postgresListCacheMigration.trimStart()).toMatch(/^BEGIN;/);
		expect(postgresListCacheMigration.trimEnd()).toMatch(/COMMIT;$/);
		expect(postgresListCacheMigration).not.toMatch(/\b(?:DELETE|TRUNCATE|DROP TABLE)\b/i);
	});

	it("serializes concurrent PostgreSQL list-cache migrations", () => {
		const advisoryLock = postgresListCacheMigration.indexOf("pg_advisory_xact_lock");
		const firstIndexCreation = postgresListCacheMigration.indexOf(
			"CREATE UNIQUE INDEX IF NOT EXISTS",
		);

		expect(advisoryLock).toBeGreaterThan(-1);
		expect(firstIndexCreation).toBeGreaterThan(advisoryLock);
	});

	it("retries PostgreSQL schema reconciliation after concurrent DDL conflicts", () => {
		const migration = postgresSchemaSync.indexOf(
			"prisma/pre-sync/postgresql-v2.24-list-cache-identity.sql",
		);
		const retryLimit = postgresSchemaSync.indexOf("maxSchemaPushAttempts = 5");
		const schemaSync = postgresSchemaSync.indexOf('"db", "push"');

		expect(retryLimit).toBeGreaterThan(-1);
		expect(migration).toBeGreaterThan(-1);
		expect(schemaSync).toBeGreaterThan(migration);
		expect(postgresSchemaSync).toContain("attempt <= maxSchemaPushAttempts");
		expect(postgresSchemaSync).not.toContain("--accept-data-loss");
	});

	it("hands the runtime schema to a remapped PUID before synchronization", () => {
		const ownershipHandoff = startupScript.indexOf(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: This must match the literal shell expansion in the startup script.
			'chown "${PUID}:${PGID}" /app/api/prisma/schema.prisma',
		);
		const schemaSync = startupScript.indexOf("prisma db push --schema prisma/schema.prisma");

		expect(ownershipHandoff).toBeGreaterThan(-1);
		expect(schemaSync).toBeGreaterThan(ownershipHandoff);
	});

	it("restores schema ownership before regenerating for a provider switch", () => {
		const providerSwitch = startupScript.indexOf('echo "  - Schema updated successfully"');
		const ownershipHandoff = startupScript.indexOf(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: This must match the literal shell expansion in the startup script.
			'chown "${PUID}:${PGID}" /app/api/prisma/schema.prisma',
			providerSwitch,
		);
		const clientGeneration = startupScript.indexOf(
			"run_as_user ./node_modules/.bin/prisma generate --schema prisma/schema.prisma",
			providerSwitch,
		);

		expect(providerSwitch).toBeGreaterThan(-1);
		expect(ownershipHandoff).toBeGreaterThan(providerSwitch);
		expect(clientGeneration).toBeGreaterThan(ownershipHandoff);
	});

	it("keeps an actionable fail-closed message for destructive changes", () => {
		expect(startupScript).toContain(
			"Destructive schema changes are intentionally rejected at startup",
		);
		expect(startupScript).toContain("consult the release notes for an explicit upgrade path");
	});

	it("reports an unknown migration outcome without claiming rollback", () => {
		expect(startupScript).toContain(
			"The migration outcome may be unknown; the next startup will reconcile it safely",
		);
		expect(startupScript).not.toContain("Existing constraints were preserved");
	});

	it("does not echo any portion of DATABASE_URL on synchronization failure", () => {
		expect(startupScript).not.toContain("Current DATABASE_URL");
		expect(startupScript).not.toContain("DATABASE_URL%%");
		expect(startupScript).toContain("Detected database provider: $DB_PROVIDER");
	});
});
