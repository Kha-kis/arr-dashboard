import { defineConfig, devices } from "@playwright/test";

// Standalone live-harness commands are not executed through a cached Turbo task.
const runnerEnvironment = process.env;
const baseURL = runnerEnvironment.LC_E2E_BASE_URL ?? "http://127.0.0.1:33030";
const candidate =
	runnerEnvironment.LC_E2E_DASHBOARD_SERVICE === "dashboard-postgres"
		? "dashboard-postgres"
		: "dashboard-sqlite";
const evidenceDirectory = `.artifacts/playwright/${candidate}`;
const runId = runnerEnvironment.LC_E2E_RUN_ID ?? "adhoc";
const evidenceEnabled =
	Boolean(runnerEnvironment.LC_E2E_CONTAINER_ID) &&
	Boolean(runnerEnvironment.LC_E2E_RUN_STARTED_AT);

export default defineConfig({
	testDir: ".",
	testMatch: "browser-policy.spec.ts",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: evidenceEnabled
		? [["list"], ["json", { outputFile: `${evidenceDirectory}/${runId}.json` }]]
		: "list",
	timeout: 60_000,
	outputDir: `${evidenceDirectory}/${runId}-test-results`,
	metadata: {
		candidate,
		checkoutCommit: runnerEnvironment.LC_E2E_CHECKOUT_COMMIT ?? "unknown",
		checkoutDirty: runnerEnvironment.LC_E2E_CHECKOUT_DIRTY ?? "unknown",
		containerId: runnerEnvironment.LC_E2E_CONTAINER_ID ?? "unknown",
		containerImageId: runnerEnvironment.LC_E2E_CONTAINER_IMAGE_ID ?? "unknown",
		containerImageRef: runnerEnvironment.LC_E2E_CONTAINER_IMAGE_REF ?? "unknown",
		containerRevision: runnerEnvironment.LC_E2E_CONTAINER_REVISION ?? "unknown",
		testSuiteSha256: runnerEnvironment.LC_E2E_TEST_SUITE_SHA256 ?? "unknown",
		startedAt: runnerEnvironment.LC_E2E_RUN_STARTED_AT ?? "unknown",
	},
	use: {
		...devices["Desktop Chrome"],
		baseURL,
		storageState: { cookies: [], origins: [] },
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
		video: "retain-on-failure",
	},
	expect: { timeout: 10_000 },
});
