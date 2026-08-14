import assert from "node:assert/strict";
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
