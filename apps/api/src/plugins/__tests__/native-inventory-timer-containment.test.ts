import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const actor = fileURLToPath(new URL("./fixtures/native-inventory-timer-actor.ts", import.meta.url));

describe("native inventory timer rejection containment", () => {
	for (const mode of ["startup", "interval", "ordinary-failure", "close-join"]) {
		it(`${mode}: survives rejection without inventing success or abandoning shutdown work`, () => {
			const child = spawnSync(process.execPath, ["--import", require.resolve("tsx"), actor, mode], {
				encoding: "utf8",
				timeout: 15_000,
				env: { ...process.env, NODE_ENV: "test", DOTENV_CONFIG_PATH: "/dev/null" },
			});
			expect(child.error).toBeUndefined();
			expect(child.signal).toBeNull();
			expect(
				child.status,
				child.stderr || "Timer rejection must not terminate the real plugin process",
			).toBe(0);
			const output = JSON.parse(child.stdout.trim());
			expect(output).toEqual({
				mode,
				survived: true,
				attempts: mode === "interval" ? 4 : 2,
				recordedFailures: mode === "interval" ? 4 : 2,
				closeJoined: true,
				timersCancelled: true,
				privateErrorOmitted: true,
			});
		});
	}
});
