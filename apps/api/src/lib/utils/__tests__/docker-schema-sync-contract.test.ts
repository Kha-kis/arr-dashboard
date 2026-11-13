import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Docker schema synchronization contract", () => {
	// Native-before-listen, one owner, handoff-before-health/web, and failure
	// closure run in combined-startup-api.test.ts and docker/test-combined-startup.cjs.
	// The shell no longer owns an independent pre-launch schema/settings actor.
	const startupScript = readFileSync(
		resolve(process.cwd(), "../../docker/start-combined.sh"),
		"utf8",
	);
	const postgresListCacheMigration = readFileSync(
		resolve(process.cwd(), "prisma/pre-sync/postgresql-v2.24-list-cache-identity.sql"),
		"utf8",
	);
	const dockerfile = readFileSync(resolve(process.cwd(), "../../Dockerfile"), "utf8");
	const runtimeValidator = readFileSync(
		resolve(process.cwd(), "../../docker/validate-runtime.sh"),
		"utf8",
	);
	const apiPackage = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));

	it("uses runtime-selected port metadata for database-independent image liveness", () => {
		expect(dockerfile).toContain("docker/runtime-health.cjs");
		expect(dockerfile).toContain("CMD node /app/runtime-health.cjs check");
		expect(runtimeValidator).toContain('check_file "/app/runtime-health.cjs"');
	});

	it("builds the native actor and does not ship or retain the independent legacy I/O helpers", () => {
		expect(apiPackage.scripts.build).toContain("src/schema-startup.ts");
		expect(runtimeValidator).toContain("for provider in sqlite postgresql");
		expect(runtimeValidator).toContain('"$API_DIR/providers/$provider" "$provider"');
		expect(runtimeValidator).toContain("validate-provider-runtime.cjs");
		for (const file of ["read-base-path.cjs", "sync-postgresql-schema.cjs"]) {
			expect(dockerfile).not.toContain(`docker/${file}`);
			expect(runtimeValidator).not.toContain(file);
			expect(existsSync(resolve(process.cwd(), `../../docker/${file}`))).toBe(false);
		}
	});

	it("does not invoke a destination schema engine or permit destructive CLI overrides", () => {
		expect(startupScript).not.toMatch(/prisma\s+(?:db\s+(?:push|execute)|migrate)/);
		expect(startupScript).not.toContain("--accept-data-loss");
		expect(startupScript).not.toContain("sync-postgresql-schema.cjs");
		expect(startupScript).not.toContain("read-base-path.cjs");
	});

	it("validates the fixed provider package as the effective user", () => {
		expect(startupScript).toContain('API_RUNTIME_DIR="/app/api/providers/$DB_PROVIDER"');
		expect(startupScript).toContain("readonly API_RUNTIME_DIR");
		expect(startupScript).toContain(
			'run_as_user node /app/api/validate-provider-runtime.cjs "$API_RUNTIME_DIR" "$DB_PROVIDER"',
		);
	});

	it("rejects an unsupported URL scheme instead of treating it as SQLite", () => {
		expect(startupScript).toContain('case "$DATABASE_URL" in');
		expect(startupScript).toContain('file:*) DB_PROVIDER="sqlite"');
		expect(startupScript).toContain(
			"ERROR: Unsupported database provider; services were not started",
		);
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

	it("generates provider packages during image build, never mutates runtime application code", () => {
		expect(dockerfile).toContain("node /tmp/provider-build/prepare-provider-runtimes.cjs");
		expect(dockerfile).toContain("COPY --from=builder --chown=root:root /app/deploy-api ./api");
		expect(startupScript).not.toMatch(
			/prisma\s+generate|patch-prisma-provider-bundles|chown[^\n]*\/app\/api|sed[^\n]*schema\.prisma/,
		);
	});

	it("keeps an actionable fail-closed message for unsupported destructive transitions", () => {
		expect(startupScript).toContain(
			"Destructive schema changes are intentionally rejected at startup",
		);
		expect(startupScript).toContain("consult the release notes for an explicit upgrade path");
	});

	it("does not blindly retry an unknown migration outcome or claim rollback", () => {
		expect(startupScript).toContain("An unacknowledged commit is unknown; do not assume rollback");
		expect(startupScript).not.toContain("Existing constraints were preserved");
		expect(startupScript).not.toContain("maxSchemaPushAttempts");
	});

	it("does not echo any portion of DATABASE_URL on synchronization failure", () => {
		expect(startupScript).not.toContain("Current DATABASE_URL");
		expect(startupScript).not.toContain("DATABASE_URL%%");
		expect(startupScript).toContain("Detected database provider: $DB_PROVIDER");
	});
});
