import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveHarnessEndpoints } from "../ports.mjs";

test("non-default host ports resolve to one shared set of loopback endpoints", () => {
	assert.deepEqual(
		resolveHarnessEndpoints({
			PLEX_PORT: "42400",
			TAUTULLI_PORT: "48181",
			TRACEARR_PORT: "43000",
			DASHBOARD_PORT: "43030",
			DASHBOARD_API_PORT: "43031",
		}),
		{
			plexUrl: "http://127.0.0.1:42400",
			tautulliUrl: "http://127.0.0.1:48181",
			tracearrUrl: "http://127.0.0.1:43000",
			dashboardUrl: "http://127.0.0.1:43030",
			dashboardApiUrl: "http://127.0.0.1:43031",
		},
	);
});

test("invalid port overrides fail closed", () => {
	assert.throws(() => resolveHarnessEndpoints({ DASHBOARD_PORT: "not-a-port" }), /DASHBOARD_PORT/);
	assert.throws(() => resolveHarnessEndpoints({ TRACEARR_PORT: "70000" }), /TRACEARR_PORT/);
});

test("the root CI Playwright suite excludes the external media analytics harness", () => {
	const rootPlaywrightConfig = readFileSync("playwright.config.ts", "utf8");
	assert.match(rootPlaywrightConfig, /"\*\*\/media-analytics\/\*\*"/);
});

test("the media analytics Playwright project discovers the real provider selection spec without interception", () => {
	const result = spawnSync(
		"pnpm",
		[
			"exec",
			"playwright",
			"test",
			"--config=e2e/media-analytics/playwright.config.ts",
			"--list",
			"provider-selection.spec.ts",
		],
		{ encoding: "utf8" },
	);

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /provider-selection\.spec\.ts/);
	assert.doesNotMatch(
		readFileSync("e2e/media-analytics/specs/provider-selection.spec.ts", "utf8"),
		/\bpage\.route\s*\(/,
	);
});
