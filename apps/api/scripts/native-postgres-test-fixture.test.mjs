import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { lstat, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";
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
		assert.deepEqual(
			(await client.query('SELECT * FROM public."RestoreRuntimeControl"')).rows,
			[
				{
					id: 1,
					protocolVersion: 1,
					phase: "idle",
					runtimeEpoch: null,
					ownerBackendPid: null,
					activeRestoreId: null,
					lastCommittedRestoreId: null,
					lastCommittedAt: null,
					destinationInstallationId: null,
				},
			],
			"Fresh fixture consumers require the initialized idle singleton before any suite runs.",
		);
		await assert.rejects(prepared.dispose(), { code: "children-not-exited" });
		assert.equal(existsSync(prepared.project), true);
	} finally {
		await client?.end();
		await prepared?.dispose({ childrenExited: true });
	}
	assert.equal(existsSync(prepared.directory), false);
});

for (const state of ["populated-control", "native-receipt"]) {
	test(`native PG preparation refuses ${state} before initializing its protocol row`, async () => {
		const originalExecute = childProcess.execFile;
		const originalClient = pg.Client;
		const commands = [];
		const queries = [];
		let nonce;
		let directory;
		let owned;
		let clientsClosed = 0;
		const execute = () => {};
		execute[promisify.custom] = async (file, args, options) => {
			commands.push(args[0]);
			if (file === "docker") {
				if (args[0] === "run") {
					nonce = args[args.indexOf("--label") + 1].split("=")[1];
					return { stdout: "a".repeat(64) };
				}
				if (args[0] === "port") return { stdout: "127.0.0.1:54321\n" };
				if (args[0] === "inspect") return { stdout: nonce };
				if (args[0] === "rm") return { stdout: "" };
				throw new Error("Unexpected fixture command");
			}
			directory = join(options.cwd, "../..");
			owned ??= await lstat(directory, { bigint: true });
			return { stdout: "" };
		};
		// Replace the execFile function itself so promisify uses this double's
		// custom implementation rather than the real execFile custom symbol.
		childProcess.execFile = execute;
		pg.Client = class {
			on() {}
			async connect() {}
			async end() {
				clientsClosed++;
			}
			async query(sql) {
				queries.push(sql);
				if (
					sql === "SELECT 1" ||
					sql === "BEGIN" ||
					sql === "ROLLBACK" ||
					sql.startsWith("LOCK TABLE ")
				)
					return { rows: [] };
				if (sql.includes("pg_catalog.pg_class"))
					return { rows: [{ present: state === "native-receipt" }] };
				if (sql.includes("count(*)") && sql.includes('"RestoreRuntimeControl"'))
					return { rows: [{ count: state === "populated-control" ? "1" : "0" }] };
				throw new Error("Unexpected fixture query");
			}
		};
		syncBuiltinESMExports();
		try {
			const isolated = await import(`./native-postgres-test-fixture.mjs?guard=${state}`);
			await assert.rejects(
				isolated.prepareNativePostgresFixture({
					sourceApiRoot: fileURLToPath(new URL("..", import.meta.url)),
				}),
				(error) =>
					error.message ===
						"Native PostgreSQL fixture preparation failed; private preparation retained." &&
					!Object.hasOwn(error, "cause"),
			);
			assert.ok(queries.includes("BEGIN"));
			assert.ok(queries.some((sql) => sql.includes("pg_catalog.pg_class")));
			assert.ok(queries.some((sql) => sql.includes("count(*)")));
			assert.ok(queries.includes("ROLLBACK"));
			assert.equal(
				queries.some((sql) => /^(DROP|INSERT)/.test(sql)),
				false,
			);
			assert.equal(queries.includes("COMMIT"), false);
			assert.equal(clientsClosed, 2, "Readiness and bootstrap clients must both close.");
			assert.ok(commands.includes("inspect"));
			assert.ok(commands.includes("rm"));
		} finally {
			childProcess.execFile = originalExecute;
			pg.Client = originalClient;
			syncBuiltinESMExports();
			if (directory && owned) {
				const current = await lstat(directory, { bigint: true });
				assert.equal(current.dev, owned.dev);
				assert.equal(current.ino, owned.ino);
				await rm(directory, { recursive: true });
			}
		}
	});
}
