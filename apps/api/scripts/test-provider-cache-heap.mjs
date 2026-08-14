import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-cache-heap-"));
const databasePath = path.join(testDir, "provider-cache.db");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(command, args, env = {}) {
	const result = spawnSync(command, args, {
		cwd: apiDir,
		env: { ...process.env, ...env },
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) process.exitCode = result.status ?? 1;
	return result.status === 0;
}

try {
	const initialized = run(
		pnpm,
		["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"],
		{ DATABASE_URL: `file:${databasePath}` },
	);
	if (initialized) {
		run(
			process.execPath,
			[
				"node_modules/vitest/vitest.mjs",
				"run",
				"src/lib/plex/__tests__/provider-cache-heap.test.ts",
				"--execArgv=--expose-gc",
				"--maxWorkers=1",
				"--no-file-parallelism",
				"--disableConsoleIntercept",
			],
			{
				TEST_HEAP: "true",
				PROVIDER_CACHE_TEST_DB_PATH: databasePath,
			},
		);
	}
} finally {
	fs.rmSync(testDir, { recursive: true, force: true });
}
