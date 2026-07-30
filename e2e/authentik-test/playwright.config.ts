import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "authentik-oidc.spec.ts",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 60_000,
	reporter: [["list"]],
	use: {
		...devices["Desktop Chrome"],
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
});
