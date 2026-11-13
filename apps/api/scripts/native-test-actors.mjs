import { spawn } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const groups = [
	[
		"admission",
		[
			[
				"SQLITE_RESTORE_ADMISSION_ACTOR_FILE",
				"src/lib/backup/__tests__/fixtures/restore-runtime-admission-actor.ts",
			],
		],
	],
	[
		"workers",
		[
			[
				"SQLITE_RESTORE_WORKER_FOLLOWER_ACTOR_FILE",
				"src/lib/backup/__tests__/fixtures/restore-runtime-worker-follower-actor.ts",
			],
			[
				"SQLITE_RESTORE_WORKER_EXIT_ACTOR_FILE",
				"src/lib/backup/__tests__/fixtures/restore-runtime-worker-exit-actor.ts",
			],
			[
				"SQLITE_RESTORE_ACTUAL_FINALIZER_FILE",
				"src/lib/jellyfin/jellyfin-episode-finalizer-worker.ts",
			],
		],
	],
	[
		"protocol",
		[
			[
				"SQLITE_RESTORE_ACTOR_FILE",
				"src/lib/backup/__tests__/fixtures/restore-runtime-sqlite-actor.ts",
			],
			[
				"SQLITE_RESTORE_ENROLLMENT_ACTOR_FILE",
				"src/lib/backup/__tests__/fixtures/restore-runtime-sqlite-enrollment-actor.ts",
			],
		],
	],
	[
		"replacement",
		[
			[
				"SQLITE_RESTORE_REPLACEMENT_ACTOR_FILE",
				"src/lib/backup/__tests__/fixtures/restore-runtime-replacement-actor.ts",
			],
		],
	],
];
const assets = [
	"prisma/schema.prisma",
	"prisma/runtime-schema/sqlite-v1.sql",
	"prisma/runtime-schema/postgresql-v1.sql",
	"prisma/runtime-schema/registry-sqlite-v1.json",
	"prisma/runtime-schema/registry-postgresql-v1.json",
];

function unavailable(code) {
	const error = new Error("Native test actor preparation is unavailable");
	error.code = code;
	return error;
}

// Deliberately do not forward NODE_OPTIONS, database URLs, provider credentials,
// actor overrides, dotenv, npm configuration, or other inherited build inputs.
function compilerEnvironment() {
	return {
		PATH: process.env.PATH ?? dirname(process.execPath),
		LANG: "C.UTF-8",
		TZ: "UTC",
		NODE_ENV: "test",
		CI: "true",
		DOTENV_CONFIG_PATH: "/dev/null",
	};
}

function compile(cli, entries, outDir, config, apiRoot) {
	return new Promise((resolveBuild, reject) => {
		const child = spawn(
			process.execPath,
			[cli, ...entries, "--format", "esm", "--out-dir", outDir, "--config", config],
			{
				cwd: apiRoot,
				env: compilerEnvironment(),
				stdio: "ignore",
			},
		);
		let failed = false;
		child.once("error", () => {
			failed = true;
		});
		// The close event joins physical compiler exit and its stdio handles.
		// There is no guessed deadline that could delete an executing actor tree.
		child.once("close", (code, signal) => {
			if (failed || code !== 0 || signal !== null) reject(unavailable("actor-build-failed"));
			else resolveBuild();
		});
	});
}

function outputFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const file = join(directory, entry.name);
		if (entry.isDirectory()) {
			chmodSync(file, 0o700);
			return outputFiles(file);
		}
		if (!entry.isFile()) throw unavailable("actor-output-unavailable");
		chmodSync(file, 0o600);
		return [file];
	});
}

/**
 * Compile current repository actors without touching installed dependencies.
 * The caller owns all actors it launches and must join their physical exits
 * before dispose({ childrenExited: true }). Unknown closure retains the tree.
 */
export async function prepareNativeTestActors({ apiRoot } = {}) {
	let root;
	try {
		if (typeof apiRoot !== "string" || apiRoot.length === 0)
			throw unavailable("actor-input-unavailable");
		root = realpathSync(resolve(apiRoot));
		for (const file of [
			...groups.flatMap(([, entries]) => entries.map(([, entry]) => entry)),
			...assets,
		]) {
			if (!lstatSync(realpathSync(join(root, file))).isFile())
				throw unavailable("actor-input-unavailable");
		}
	} catch {
		throw unavailable("actor-input-unavailable");
	}
	let cli, sqlite, pg;
	try {
		const require = createRequire(join(root, "package.json"));
		const tsupPackage = require.resolve("tsup/package.json");
		const tsup = JSON.parse(readFileSync(tsupPackage, "utf8"));
		cli = resolve(dirname(tsupPackage), tsup.bin.tsup);
		sqlite = require.resolve("better-sqlite3");
		const pgPackage = require.resolve("pg/package.json");
		const pgMetadata = JSON.parse(readFileSync(pgPackage, "utf8"));
		pg = resolve(dirname(pgPackage), pgMetadata.exports["."].import);
		for (const file of [cli, sqlite, pg])
			if (!lstatSync(file).isFile()) throw unavailable("actor-dependencies-unavailable");
	} catch {
		throw unavailable("actor-dependencies-unavailable");
	}
	const directory = mkdtempSync(join(tmpdir(), "arr-native-test-actors-"));
	chmodSync(directory, 0o700);
	const owned = lstatSync(directory, { bigint: true });
	let disposed = false;
	const removeOwnedTree = () => {
		if (disposed) return;
		const current = lstatSync(directory, { bigint: true });
		if (!current.isDirectory() || current.dev !== owned.dev || current.ino !== owned.ino)
			throw unavailable("owned-directory-changed");
		rmSync(directory, { recursive: true, force: true });
		disposed = true;
	};
	try {
		// Absolute installed-package exports prevent tsup's test-fixture bundling
		// from relocating native bindings or choosing pg's CJS namespace surface.
		const config = join(directory, "tsup.config.mjs");
		writeFileSync(
			config,
			`export default { noExternal: ["better-sqlite3", "pg"], esbuildPlugins: [{ name: "installed-native-test-packages", setup(build) { build.onResolve({ filter: /^(better-sqlite3|pg)$/ }, args => ({ path: args.path === "pg" ? ${JSON.stringify(pg)} : ${JSON.stringify(sqlite)}, external: true })); } }] };\n`,
			{ mode: 0o600 },
		);
		symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), "dir");
		const environment = {};
		for (const [group, entries] of groups) {
			const target = join(directory, group);
			mkdirSync(target, { mode: 0o700 });
			writeFileSync(join(target, "package.json"), '{"type":"module"}\n', { mode: 0o600 });
			await compile(
				cli,
				entries.map(([, entry]) => entry),
				join(target, "dist"),
				config,
				root,
			);
			let files;
			try {
				files = outputFiles(join(target, "dist"));
			} catch {
				throw unavailable("actor-output-unavailable");
			}
			for (const [key, entry] of entries) {
				const name = `${basename(entry, ".ts")}.js`;
				const matches = files.filter((file) => basename(file) === name);
				if (matches.length !== 1) throw unavailable("actor-output-unavailable");
				environment[key] = matches[0];
			}
			for (const asset of assets) {
				const next = join(target, asset);
				mkdirSync(dirname(next), { recursive: true, mode: 0o700 });
				copyFileSync(join(root, asset), next);
				chmodSync(next, 0o600);
			}
		}
		return Object.freeze({
			directory,
			environment: Object.freeze(environment),
			async dispose({ childrenExited } = {}) {
				if (childrenExited !== true) throw unavailable("children-not-exited");
				removeOwnedTree();
			},
		});
	} catch (error) {
		// No consumer has received the paths, and every compiler was joined on
		// close before rejection. Never traverse the dependency symlink.
		removeOwnedTree();
		throw error;
	}
}
