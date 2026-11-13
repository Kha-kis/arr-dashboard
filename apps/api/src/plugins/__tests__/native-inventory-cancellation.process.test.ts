import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteSchemaFixture } from "../../lib/__tests__/sqlite-schema-fixture.js";

const require = createRequire(import.meta.url);
const actor = fileURLToPath(
	new URL("./fixtures/native-inventory-cancellation-actor.ts", import.meta.url),
);
const schemaFixture = new SqliteSchemaFixture();
beforeAll(() => schemaFixture.initialize(), 60_000);
afterAll(() => schemaFixture.dispose());

describe("native scheduler SIGTERM cancellation", () => {
	for (const service of ["PLEX", "JELLYFIN", "EMBY"])
		for (const phase of ["identity", "discovery", "page"]) {
			it(`${service} ${phase}: closes Fastify and registry after joining the physical read`, async () => {
				const directory = mkdtempSync(join(tmpdir(), "native-shutdown-actor-"));
				try {
					const dbPath = join(directory, "test.db");
					schemaFixture.copyTo(dbPath);
					const child = spawn(
						process.execPath,
						["--import", require.resolve("tsx"), actor, service, phase, dbPath],
						{
							env: { ...process.env, NODE_ENV: "test", DOTENV_CONFIG_PATH: "/dev/null" },
							stdio: ["ignore", "pipe", "pipe", "ipc"],
						},
					);
					let stdout = "",
						stderr = "";
					child.stdout!.on("data", (value) => {
						stdout += String(value);
					});
					child.stderr!.on("data", (value) => {
						stderr += String(value);
					});
					const closed = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
						child.once("close", (code, signal) => resolve([code, signal]));
					});
					let watchdogExpired = false;
					const timeout = setTimeout(() => {
						watchdogExpired = true;
						child.kill("SIGKILL");
					}, 15_000);
					try {
						await new Promise<void>((resolve, reject) => {
							child.once("message", () => resolve());
							child.once("error", reject);
							child.once("close", (code, signal) =>
								reject(
									new Error(
										`Fixture exited before ready: code=${code}, signal=${signal}, watchdogExpired=${watchdogExpired}: ${stderr}`,
									),
								),
							);
						});
						child.kill("SIGTERM");
						const [code, signal] = await closed;
						expect(signal).toBeNull();
						expect(code, stderr).toBe(0);
						const result = JSON.parse(stdout.trim());
						expect(result).toMatchObject({
							service,
							phase,
							joined: true,
							yielded: true,
							failureCount: 0,
							snapshots: 0,
							noNextTick: true,
						});
						expect(result.elapsedMs).toBeLessThan(5_000);
					} finally {
						clearTimeout(timeout);
						if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
						await closed;
					}
				} finally {
					rmSync(directory, { recursive: true, force: true });
				}
			}, 20_000);
		}
});
