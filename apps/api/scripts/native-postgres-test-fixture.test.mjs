import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import pg from "pg";
import { prepareNativePostgresFixture } from "./native-postgres-test-fixture.mjs";

test("native PG preparation creates a fresh database and private application directory without a supplied database URL", async () => {
	const sourceApiRoot = fileURLToPath(new URL("..", import.meta.url));
	let prepared;
	await assert.doesNotReject(async () => {
		prepared = await prepareNativePostgresFixture({ sourceApiRoot });
	});
	let client;
	try {
		assert.equal(lstatSync(prepared.directory).mode & 0o777, 0o700);
		assert.equal(lstatSync(prepared.project).mode & 0o777, 0o700);
		assert.equal(existsSync(`${prepared.project}/data/secrets.json`), false);
		assert.equal(prepared.environment.RESTORE_RUNTIME_TEST_PROJECT, prepared.project);
		const providerConfig = (await import(pathToFileURL(prepared.config).href)).default;
		assert.ok(
			providerConfig.test.include.includes(
				"src/lib/backup/__tests__/runtime-schema-postgres.database.test.ts",
			),
			"The owned provider gate must execute the native PG schema catalog suite.",
		);
		assert.ok(
			providerConfig.test.include.includes(
				"src/lib/backup/__tests__/restore-runtime-replacement.postgres.database.test.ts",
			),
			"The owned provider gate must execute PostgreSQL replacement, not skip it.",
		);
		const replacementActor = prepared.environment.POSTGRES_RESTORE_REPLACEMENT_ACTOR_FILE;
		assert.equal(typeof replacementActor, "string", "A current PG replacement actor is required.");
		assert.equal(replacementActor, prepared.environment.SQLITE_RESTORE_REPLACEMENT_ACTOR_FILE);
		assert.equal(lstatSync(replacementActor).isFile(), true);
		assert.equal(lstatSync(replacementActor).mode & 0o777, 0o600);
		const actorSchema = join(replacementActor, "../../prisma/schema.prisma");
		assert.equal(relative(prepared.project, replacementActor).startsWith(".."), true);
		assert.deepEqual(
			readFileSync(actorSchema),
			readFileSync(join(prepared.project, "prisma/schema.prisma")),
		);
		assert.match(readFileSync(actorSchema, "utf8"), /provider = "postgresql"/);
		const startupConfig = (await import(pathToFileURL(prepared.schemaStartupConfig).href)).default;
		assert.deepEqual(startupConfig.test.include, [
			"src/lib/backup/__tests__/runtime-schema-startup.database.test.ts",
		]);
		assert.equal(startupConfig.test.testNamePattern, "native PostgreSQL schema startup writer");
		assert.equal(startupConfig.test.maxWorkers, 1);
		assert.equal(startupConfig.test.fileParallelism, false);
		const url = new URL(prepared.environment.RESTORE_RUNTIME_TEST_PG_URL);
		assert.equal(url.hostname, "127.0.0.1");
		assert.match(url.pathname, /^\/arr_native_[a-f0-9]+_test$/);
		assert.equal(url.search, "");
		client = new pg.Client({ connectionString: url.href });
		await client.connect();
		assert.deepEqual((await client.query('SELECT count(*) AS count FROM "User"')).rows, [
			{ count: "0" },
		]);
		await assert.rejects(prepared.dispose(), { code: "children-not-exited" });
		assert.equal(existsSync(prepared.project), true);
	} finally {
		await client?.end();
		await prepared?.dispose({ childrenExited: true });
	}
	assert.equal(existsSync(prepared.directory), false);
});
