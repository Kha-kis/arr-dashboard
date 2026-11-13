import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const apiRoot = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(join(apiRoot, "package.json"));
const actors = {
	SQLITE_RESTORE_ADMISSION_ACTOR_FILE:
		"src/lib/backup/__tests__/fixtures/restore-runtime-admission-actor.ts",
	SQLITE_RESTORE_WORKER_FOLLOWER_ACTOR_FILE:
		"src/lib/backup/__tests__/fixtures/restore-runtime-worker-follower-actor.ts",
	SQLITE_RESTORE_WORKER_EXIT_ACTOR_FILE:
		"src/lib/backup/__tests__/fixtures/restore-runtime-worker-exit-actor.ts",
	SQLITE_RESTORE_ACTUAL_FINALIZER_FILE: "src/lib/jellyfin/jellyfin-episode-finalizer-worker.ts",
	SQLITE_RESTORE_ACTOR_FILE: "src/lib/backup/__tests__/fixtures/restore-runtime-sqlite-actor.ts",
	SQLITE_RESTORE_ENROLLMENT_ACTOR_FILE:
		"src/lib/backup/__tests__/fixtures/restore-runtime-sqlite-enrollment-actor.ts",
	SQLITE_RESTORE_REPLACEMENT_ACTOR_FILE:
		"src/lib/backup/__tests__/fixtures/restore-runtime-replacement-actor.ts",
};

async function prepare(options) {
	const module = await import("./native-test-actors.mjs");
	assert.equal(
		typeof module.prepareNativeTestActors,
		"function",
		"repository-owned preparation required",
	);
	return module.prepareNativeTestActors(options);
}

const cleanEnvironment = () => ({
	PATH: process.env.PATH,
	LANG: "C.UTF-8",
	TZ: "UTC",
	NODE_ENV: "test",
	CI: "true",
	DOTENV_CONFIG_PATH: "/dev/null",
});

function runNativeWitness(environment, config) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[
				join(dirname(require.resolve("vitest/package.json")), "vitest.mjs"),
				"run",
				"--config",
				config,
				"src/lib/backup/__tests__/restore-runtime-sqlite-enrollment.database.test.ts",
				"src/lib/backup/__tests__/restore-runtime-application.database.test.ts",
				"src/lib/backup/__tests__/restore-runtime-replacement.database.test.ts",
				"--maxWorkers=1",
				"-t",
				"independent losing process|real native follower confines admission and physical lifetime: running$|actual DELETE-mode finalizer commits a spilled 500-row batch|reconciles a lost actual SQLite COMMIT acknowledgement without replay",
			],
			{
				cwd: apiRoot,
				env: { ...cleanEnvironment(), ...environment, LOG_DIR: join(dirname(config), "logs") },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += chunk;
		});
		child.stderr.on("data", (chunk) => {
			output += chunk;
		});
		child.once("error", reject);
		child.once("close", (code, signal) => resolve({ code, signal, output }));
	});
}

// Missing actors, bundled native modules, inherited NODE_OPTIONS, stale assets,
// and premature removal all break this real compile/child lifecycle witness.
test("prepares seven portable actors and retains them until native children exited", async (context) => {
	const inherited = process.env.NODE_OPTIONS;
	const previousDirectory = process.cwd();
	let prepared;
	try {
		process.env.NODE_OPTIONS = "--require=/synthetic-invalid-parent-option.cjs";
		process.chdir(tmpdir());
		prepared = await prepare({ apiRoot });
	} finally {
		process.chdir(previousDirectory);
		if (inherited === undefined) delete process.env.NODE_OPTIONS;
		else process.env.NODE_OPTIONS = inherited;
	}
	let childrenExited = true;
	try {
		assert.equal(lstatSync(prepared.directory).mode & 0o777, 0o700);
		assert.deepEqual(Object.keys(prepared.environment).sort(), Object.keys(actors).sort());
		for (const file of Object.values(prepared.environment)) {
			assert.ok(!relative(prepared.directory, file).startsWith(".."));
			assert.ok(lstatSync(file).isFile());
			assert.equal(lstatSync(file).mode & 0o777, 0o600);
		}
		for (const group of ["admission", "workers", "protocol", "replacement"]) {
			const prisma = join(prepared.directory, group, "prisma");
			assert.deepEqual(readdirSync(prisma).sort(), ["runtime-schema", "schema.prisma"]);
			assert.deepEqual(readdirSync(join(prisma, "runtime-schema")).sort(), [
				"postgresql-v1.sql",
				"registry-postgresql-v1.json",
				"registry-sqlite-v1.json",
				"sqlite-v1.sql",
			]);
			assert.deepEqual(
				readFileSync(join(prisma, "schema.prisma")),
				readFileSync(join(apiRoot, "prisma/schema.prisma")),
			);
		}
		await assert.rejects(prepared.dispose(), { code: "children-not-exited" });
		await assert.rejects(prepared.dispose({ childrenExited: false }), {
			code: "children-not-exited",
		});
		assert.ok(existsSync(prepared.directory));
		const config = join(prepared.directory, "vitest.witness.mjs");
		writeFileSync(
			config,
			`export default ${JSON.stringify({ root: apiRoot, envDir: false, cacheDir: join(prepared.directory, "vite") })};\n`,
			{ flag: "wx", mode: 0o600 },
		);
		childrenExited = false;
		const witness = await runNativeWitness(prepared.environment, config);
		childrenExited = true;
		assert.equal(witness.signal, null);
		assert.equal(witness.code, 0, `Native witness failed:\n${witness.output}`);
		assert.match(witness.output, /5 passed/);
		context.diagnostic(
			"Native enrollment, admitted follower, actual DELETE finalizer and WAL/DELETE lost-COMMIT witnesses: 5 passed",
		);
	} finally {
		// Never infer physical closure from elapsed time or a result message.
		if (childrenExited) await prepared.dispose({ childrenExited: true });
	}
	assert.ok(!existsSync(prepared.directory));
	await prepared.dispose({ childrenExited: true });
});

test("fails closed when the actual compiler rejects a current actor source", async () => {
	const directory = mkdtempSync(join(tmpdir(), "native-actors-invalid-source-"));
	chmodSync(directory, 0o700);
	try {
		writeFileSync(join(directory, "package.json"), '{"type":"module"}', { mode: 0o600 });
		symlinkSync(join(apiRoot, "node_modules"), join(directory, "node_modules"), "dir");
		for (const entry of Object.values(actors)) {
			const target = join(directory, entry);
			mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
			if (entry.endsWith("restore-runtime-admission-actor.ts"))
				writeFileSync(target, "export const invalid = ;", { mode: 0o600 });
			else symlinkSync(join(apiRoot, entry), target);
		}
		mkdirSync(join(directory, "prisma"), { mode: 0o700 });
		symlinkSync(join(apiRoot, "prisma/schema.prisma"), join(directory, "prisma/schema.prisma"));
		symlinkSync(
			join(apiRoot, "prisma/runtime-schema"),
			join(directory, "prisma/runtime-schema"),
			"dir",
		);
		await assert.rejects(prepare({ apiRoot: directory }), { code: "actor-build-failed" });
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("requires an explicit existing API source root", async () => {
	await assert.rejects(prepare({}), { code: "actor-input-unavailable" });
	await assert.rejects(prepare({ apiRoot: join(tmpdir(), "synthetic-missing-api-root") }), {
		code: "actor-input-unavailable",
	});
});
