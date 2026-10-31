import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	chmod,
	copyFile,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { prepareNativeTestActors } from "./native-test-actors.mjs";

const execute = promisify(execFile);
// Same immutable PostgreSQL 16 image used by the repository's PG contract job.
const image = "postgres@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685";
const label = "com.arr-dashboard.native-test-owner";
const cleanEnvironment = () => ({
	PATH: process.env.PATH,
	HOME: process.env.HOME,
	LANG: "C.UTF-8",
	TZ: "UTC",
	NODE_ENV: "test",
	CI: "true",
	DOTENV_CONFIG_PATH: "/dev/null",
	CHECKPOINT_DISABLE: "1",
	TRASH_UPDATE_SCHEDULER_ENABLED: "false",
	DISABLE_QUI_CACHE_PREWARM: "true",
});

async function command(file, args, options = {}) {
	try {
		return await execute(file, args, {
			env: cleanEnvironment(),
			timeout: 60_000,
			maxBuffer: 4 * 1024 * 1024,
			...options,
		});
	} catch {
		throw new Error("Native PostgreSQL fixture command did not complete.");
	}
}

async function copyPublicTree(source, destination) {
	const stat = await lstat(source);
	if (stat.isSymbolicLink()) throw new Error("Native test source must not contain a symlink.");
	if (stat.isDirectory()) {
		await mkdir(destination, { mode: 0o700 });
		for (const name of await readdir(source)) {
			// Provider client is privately regenerated, never copied or rewritten.
			if (name === "generated") continue;
			await copyPublicTree(join(source, name), join(destination, name));
		}
	} else if (stat.isFile()) {
		await copyFile(source, destination);
		await chmod(destination, 0o600);
	} else throw new Error("Native test source must be a regular file or directory.");
}

/** No supplied connection URL is accepted: this owns a new local container. */
export async function prepareNativePostgresFixture({ sourceApiRoot }) {
	const source = resolve(sourceApiRoot);
	if (
		(await lstat(source)).isSymbolicLink() ||
		!(await lstat(join(source, "src/server.ts"))).isFile()
	)
		throw new Error("Explicit API test source required.");
	const directory = await mkdtemp(join(tmpdir(), "arr-native-postgres-test-"));
	await chmod(directory, 0o700);
	const owned = await lstat(directory, { bigint: true });
	const artifacts = join(directory, "artifacts");
	await mkdir(artifacts, { mode: 0o700 });
	// Preserve the application's existing private-cwd bootstrap safety contract.
	const project = join(artifacts, "restore-application-admission-native");
	await mkdir(project, { mode: 0o700 });
	const nonce = randomBytes(16).toString("hex");
	const database = `arr_native_${nonce}_test`;
	const password = randomBytes(24).toString("hex");
	let containerId;
	let actors;
	let disposed = false;
	async function stopOwnedContainer() {
		if (!containerId) return;
		const proof = await command("docker", [
			"inspect",
			"--format",
			`{{ index .Config.Labels "${label}" }}`,
			containerId,
		]);
		if (proof.stdout.trim() !== nonce)
			throw new Error("Native fixture container ownership is unverified.");
		await command("docker", ["rm", "--force", "--volumes", containerId]);
		containerId = undefined;
	}
	async function dispose(options) {
		if (options?.childrenExited !== true)
			throw Object.assign(
				new Error("Confirm native test children exited before fixture cleanup."),
				{ code: "children-not-exited" },
			);
		if (disposed) return;
		await stopOwnedContainer();
		await actors?.dispose({ childrenExited: true });
		const current = await lstat(directory, { bigint: true });
		if (!current.isDirectory() || current.dev !== owned.dev || current.ino !== owned.ino)
			throw new Error("Native fixture directory ownership is unverified.");
		// This exact tree was created here; no externally supplied cleanup target.
		await rm(directory, { recursive: true });
		disposed = true;
	}
	try {
		await copyPublicTree(join(source, "src"), join(project, "src"));
		await mkdir(join(project, "prisma"), { mode: 0o700 });
		// Never copy ignored databases, dotenv, or local provider configuration.
		await copyFile(join(source, "prisma/schema.prisma"), join(project, "prisma/schema.prisma"));
		await chmod(join(project, "prisma/schema.prisma"), 0o600);
		await copyPublicTree(
			join(source, "prisma/runtime-schema"),
			join(project, "prisma/runtime-schema"),
		);
		for (const name of ["package.json", "tsconfig.json", "prisma.config.ts"]) {
			await copyFile(join(source, name), join(project, name));
			await chmod(join(project, name), 0o600);
		}
		await copyFile(join(source, "../../tsconfig.base.json"), join(directory, "tsconfig.base.json"));
		await chmod(join(directory, "tsconfig.base.json"), 0o600);
		await symlink(join(source, "node_modules"), join(project, "node_modules"), "dir");
		const schemaFile = join(project, "prisma/schema.prisma");
		const schema = await readFile(schemaFile, "utf8");
		const datasource = /datasource db \{\s*provider = "sqlite"\s*\}/;
		if (!datasource.test(schema)) throw new Error("Canonical SQLite schema input required.");
		await writeFile(
			schemaFile,
			schema.replace(datasource, 'datasource db {\n  provider = "postgresql"\n}'),
			{ mode: 0o600 },
		);
		const result = await command("docker", [
			"run",
			"--detach",
			"--name",
			`arr-native-test-${nonce}`,
			"--label",
			`${label}=${nonce}`,
			"--publish",
			"127.0.0.1::5432",
			"--env",
			`POSTGRES_USER=${database}`,
			"--env",
			`POSTGRES_DB=${database}`,
			"--env",
			`POSTGRES_PASSWORD=${password}`,
			image,
		]);
		containerId = result.stdout.trim();
		if (!/^[a-f0-9]{64}$/.test(containerId))
			throw new Error("Native fixture container creation is unverified.");
		const portResult = await command("docker", ["port", containerId, "5432/tcp"]);
		const port = /^127\.0\.0\.1:(\d+)\s*$/.exec(portResult.stdout)?.[1];
		if (!port) throw new Error("Native fixture must publish exactly one loopback port.");
		const url = `postgresql://${database}:${password}@127.0.0.1:${port}/${database}`;
		const deadline = Date.now() + 30_000;
		let ready = false;
		while (Date.now() < deadline) {
			const probe = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1000 });
			probe.on("error", () => {});
			try {
				await probe.connect();
				await probe.query("SELECT 1");
				ready = true;
			} catch {
				/* Fresh owned service may not be ready yet. */
			} finally {
				await probe.end().catch(() => {});
			}
			if (ready) break;
			await new Promise((resolveWait) => setTimeout(resolveWait, 100));
		}
		if (!ready) throw new Error("Native PostgreSQL fixture did not become ready.");
		const environment = {
			...cleanEnvironment(),
			LOG_DIR: join(directory, "logs"),
			DATABASE_URL: url,
			RESTORE_RUNTIME_TEST_PROJECT: project,
			RESTORE_RUNTIME_TEST_PG_URL: url,
			TEST_DATABASE_URL: url,
			RUNTIME_SCHEMA_TEST_DATABASE_URL: url,
		};
		await command(
			process.execPath,
			[
				join(source, "node_modules/prisma/build/index.js"),
				"generate",
				"--schema",
				"prisma/schema.prisma",
			],
			{ cwd: project, env: environment },
		);
		await command(
			process.execPath,
			[
				join(source, "node_modules/prisma/build/index.js"),
				"db",
				"push",
				"--schema",
				"prisma/schema.prisma",
			],
			{ cwd: project, env: environment },
		);
		// Failed physical PG-close witnesses run the shared admission actor. Its
		// bundled client must be generated for PG, not the default SQLite source.
		actors = await prepareNativeTestActors({ apiRoot: project });
		Object.assign(environment, actors.environment, {
			// The same source actor supports both engines. Compile it from this
			// privately regenerated PG project, never the SQLite application's client.
			POSTGRES_RESTORE_REPLACEMENT_ACTOR_FILE:
				actors.environment.SQLITE_RESTORE_REPLACEMENT_ACTOR_FILE,
		});
		const config = join(project, "vitest.native.mjs");
		await writeFile(
			config,
			`export default ${JSON.stringify({
				envDir: false,
				cacheDir: join(directory, "vite"),
				test: {
					environment: "node",
					maxWorkers: 1,
					fileParallelism: false,
					include: [
						"src/lib/backup/__tests__/restore-runtime-postgres-client.database.test.ts",
						"src/lib/backup/__tests__/restore-runtime-postgres-application.database.test.ts",
						"src/lib/backup/__tests__/restore-runtime-replacement.postgres.database.test.ts",
						"src/lib/backup/__tests__/restore-runtime-postgres-namespace.database.test.ts",
						"src/lib/backup/__tests__/restore-runtime-postgres.database.test.ts",
						"src/lib/backup/__tests__/runtime-schema-postgres.database.test.ts",
					],
				},
			})};\n`,
			{ flag: "wx", mode: 0o600 },
		);
		const schemaStartupConfig = join(project, "vitest.schema-startup.mjs");
		await writeFile(
			schemaStartupConfig,
			`export default ${JSON.stringify({ envDir: false, cacheDir: join(directory, "vite-schema-startup"), test: { environment: "node", maxWorkers: 1, fileParallelism: false, include: ["src/lib/backup/__tests__/runtime-schema-startup.database.test.ts"], testNamePattern: "native PostgreSQL schema startup writer" } })};\n`,
			{ flag: "wx", mode: 0o600 },
		);
		const admissionConfig = join(project, "vitest.admission.mjs");
		await writeFile(
			admissionConfig,
			`export default ${JSON.stringify({ envDir: false, cacheDir: join(directory, "vite-admission"), test: { environment: "node", maxWorkers: 1, fileParallelism: false, include: ["src/lib/backup/__tests__/restore-runtime-admission.database.test.ts"], testNamePattern: "actor-owned restore runtime operation admission" } })};\n`,
			{ flag: "wx", mode: 0o600 },
		);
		return Object.freeze({
			directory,
			project,
			config,
			schemaStartupConfig,
			admissionConfig,
			environment: Object.freeze(environment),
			stopDatabase: stopOwnedContainer,
			dispose,
		});
	} catch {
		// No test child has been launched here; stop only our newly created DB.
		await stopOwnedContainer();
		await actors?.dispose({ childrenExited: true });
		// Retain failed preparation source for diagnosis; do not guess at cleanup.
		throw new Error("Native PostgreSQL fixture preparation failed; private preparation retained.");
	}
}
