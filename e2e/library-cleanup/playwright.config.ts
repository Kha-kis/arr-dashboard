import { defineConfig, devices } from "@playwright/test";

// Standalone live-harness commands are not executed through a cached Turbo task.
const runnerEnvironment = process.env;

function requireRunnerField(name: string): string {
	const value = runnerEnvironment[name];
	if (!value) {
		throw new Error(
			`Library Cleanup browser tests must run through run-browser-policy.sh (${name}).`,
		);
	}
	return value;
}

const baseURL = requireRunnerField("LC_E2E_BASE_URL");
const candidate = requireRunnerField("LC_E2E_DASHBOARD_SERVICE");
if (candidate !== "dashboard-sqlite" && candidate !== "dashboard-postgres") {
	throw new Error(`Unsupported disposable dashboard evidence target: ${candidate}`);
}
const evidenceDirectory = `.artifacts/playwright/${candidate}`;
const runId = requireRunnerField("LC_E2E_RUN_ID");
const checkoutCommit = requireRunnerField("LC_E2E_CHECKOUT_COMMIT");
const checkoutDirty = requireRunnerField("LC_E2E_CHECKOUT_DIRTY");
const containerId = requireRunnerField("LC_E2E_CONTAINER_ID");
const containerImageId = requireRunnerField("LC_E2E_CONTAINER_IMAGE_ID");
const containerImageRef = requireRunnerField("LC_E2E_CONTAINER_IMAGE_REF");
const containerRevision = requireRunnerField("LC_E2E_CONTAINER_REVISION");
const testSuiteSha256 = requireRunnerField("LC_E2E_TEST_SUITE_SHA256");
const startedAt = requireRunnerField("LC_E2E_RUN_STARTED_AT");

export default defineConfig({
	testDir: ".",
	testMatch: "browser-policy.spec.ts",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: [["list"], ["json", { outputFile: `${evidenceDirectory}/${runId}.json` }]],
	timeout: 60_000,
	outputDir: `${evidenceDirectory}/${runId}-test-results`,
	metadata: {
		candidate,
		checkoutCommit,
		checkoutDirty,
		containerId,
		containerImageId,
		containerImageRef,
		containerRevision,
		testSuiteSha256,
		startedAt,
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
