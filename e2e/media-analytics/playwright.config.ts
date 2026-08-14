import { defineConfig, devices } from "@playwright/test";
import { config as loadEnv } from "dotenv";
import path from "node:path";
import { resolveHarnessEndpoints } from "./ports.mjs";

const harnessDir = __dirname;
const stateDir = path.join(harnessDir, ".state");
const authFile = path.join(stateDir, "playwright", "admin.json");
loadEnv({ path: path.join(harnessDir, ".env"), quiet: true });
const { dashboardUrl } = resolveHarnessEndpoints();

export default defineConfig({
	testDir: harnessDir,
	fullyParallel: false,
	workers: 1,
	timeout: 60_000,
	forbidOnly: Boolean(process.env.CI),
	retries: 0,
	reporter: [["list"], ["html", { open: "never", outputFolder: path.join(stateDir, "playwright-report") }]],
	outputDir: path.join(stateDir, "playwright-results"),
	use: {
		...devices["Desktop Chrome"],
		baseURL: dashboardUrl,
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
		video: "retain-on-failure",
	},
	expect: { timeout: 15_000 },
	projects: [
		{
			name: "setup",
			testDir: path.join(harnessDir, "fixtures"),
			testMatch: /setup\.setup\.ts/,
			use: {
				trace: "off",
				screenshot: "off",
				video: "off",
			},
		},
		{
			name: "smoke",
			testDir: path.join(harnessDir, "specs"),
			testMatch: /.*\.spec\.ts/,
			dependencies: ["setup"],
			use: { storageState: authFile },
		},
	],
});
