import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareNativeTestActors } from "./native-test-actors.mjs";
import { prepareNativePostgresFixture } from "./native-postgres-test-fixture.mjs";

const apiRoot = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(join(apiRoot, "package.json"));
const vitest = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const cleanEnvironment = () => ({
	PATH: process.env.PATH,
	HOME: process.env.HOME,
	LANG: "C.UTF-8",
	TZ: "UTC",
	NODE_ENV: "test",
	CI: "true",
	DOTENV_CONFIG_PATH: "/dev/null",
	TRASH_UPDATE_SCHEDULER_ENABLED: "false",
	DISABLE_QUI_CACHE_PREWARM: "true",
});

function run(args, cwd, environment) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(process.execPath, [vitest, ...args], {
			cwd,
			env: environment,
			stdio: "inherit",
		});
		const forward = (signal) => child.kill(signal);
		const interrupt = () => forward("SIGINT"),
			terminate = () => forward("SIGTERM");
		process.on("SIGINT", interrupt);
		process.on("SIGTERM", terminate);
		let failed;
		child.once("error", (error) => {
			failed = error;
		});
		child.once("close", (code, signal) => {
			process.off("SIGINT", interrupt);
			process.off("SIGTERM", terminate);
			if (failed || code !== 0 || signal !== null)
				reject(new Error("Native API test phase did not pass; private fixture files retained."));
			else resolveRun();
		});
	});
}

const argumentsForVitest = process.argv
	.slice(2)
	.filter((argument) => !["run", "--run"].includes(argument));
if (argumentsForVitest.some((argument) => ["--watch", "--ui"].includes(argument)))
	throw new Error("The API gate is noninteractive so native child exit can be joined.");
const pgOnlySuites = [
	"src/lib/backup/__tests__/restore-runtime-postgres-client.database.test.ts",
	"src/lib/backup/__tests__/restore-runtime-postgres-application.database.test.ts",
	"src/lib/backup/__tests__/restore-runtime-replacement.postgres.database.test.ts",
];
// These use node:test and already run in the API package's Node test phase.
// Vitest must not import them again as application suites.
const nodeOnlySuites = [
	"scripts/native-test-actors.test.mjs",
	"scripts/native-postgres-test-fixture.test.mjs",
];
let actors,
	postgres,
	sqlitePassed = false,
	postgresPassed = false;
try {
	actors = await prepareNativeTestActors({ apiRoot });
	const sqliteConfig = join(actors.directory, "vitest.sqlite.mjs");
	await writeFile(
		sqliteConfig,
		`export default ${JSON.stringify({ root: apiRoot, envDir: false, cacheDir: join(actors.directory, "vite") })};\n`,
		{ flag: "wx", mode: 0o600 },
	);
	// Preparation occurs INSIDE the Turbo task; no inherited private actor paths.
	await run(
		[
			"run",
			"--config",
			sqliteConfig,
			...argumentsForVitest,
			"--maxWorkers=2",
			...pgOnlySuites.flatMap((suite) => ["--exclude", suite]),
			...nodeOnlySuites.flatMap((suite) => ["--exclude", suite]),
		],
		apiRoot,
		{ ...cleanEnvironment(), ...actors.environment, LOG_DIR: join(actors.directory, "logs") },
	);
	sqlitePassed = true;
	postgres = await prepareNativePostgresFixture({ sourceApiRoot: apiRoot });
	// PostgreSQL-only cases are executed, not skipped, with provider-native code.
	await run(["run", "--config", postgres.config], postgres.project, postgres.environment);
	// The shared startup file's SQLite group is covered above. Its native PG
	// writer contracts need an explicit owned-provider route, never an app URL.
	await run(
		["run", "--config", postgres.schemaStartupConfig],
		postgres.project,
		postgres.environment,
	);
	// This file also contains SQLite cold-enrollment cases, covered above. Select
	// its common admission contract for a second, real PostgreSQL provider run.
	await run(["run", "--config", postgres.admissionConfig], postgres.project, {
		...postgres.environment,
		RESTORE_RUNTIME_ENGINE: "postgres",
	});
	postgresPassed = true;
} catch {
	process.stderr.write(
		"API gate failed. Native fixture files remain private; no passing full gate is claimed.\n",
	);
	process.exitCode = 1;
} finally {
	if (postgres) {
		if (postgresPassed) await postgres.dispose({ childrenExited: true });
		else await postgres.stopDatabase(); // Physical DB shutdown; keep uncertain file/child state.
	}
	if (actors && sqlitePassed) await actors.dispose({ childrenExited: true });
}
