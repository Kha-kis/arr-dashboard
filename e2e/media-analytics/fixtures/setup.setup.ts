import { expect, test as setup } from "@playwright/test";
import { parse } from "dotenv";
import { chmodSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { resolveHarnessEndpoints } from "../ports.mjs";

const harnessDir = path.resolve(__dirname, "..");
const stateDir = path.join(harnessDir, ".state");
const runtimeEnvPath = path.join(stateDir, "runtime.env");
const authDir = path.join(stateDir, "playwright");
const authFile = path.join(authDir, "admin.json");
const { dashboardApiUrl } = resolveHarnessEndpoints();

function readDashboardPassword(): string {
	const state = statSync(runtimeEnvPath);
	if ((state.mode & 0o777) !== 0o600) {
		throw new Error("runtime.env must have mode 0600 before browser setup");
	}
	if (typeof process.getuid === "function" && state.uid !== process.getuid()) {
		throw new Error("runtime.env must be owned by the current user");
	}

	const password = parse(readFileSync(runtimeEnvPath)).DASHBOARD_ADMIN_PASSWORD;
	if (!password) throw new Error("runtime.env does not contain the dashboard fixture password");
	return password;
}

setup("save the disposable dashboard administrator session", async ({ request }) => {
	const response = await request.post(`${dashboardApiUrl}/auth/login`, {
		data: {
			username: "media-analytics",
			password: readDashboardPassword(),
			rememberMe: false,
		},
	});
	expect(response.ok(), `dashboard fixture login returned HTTP ${response.status()}`).toBe(true);

	const currentUser = await request.get(`${dashboardApiUrl}/auth/me`);
	expect(currentUser.ok(), `dashboard fixture session check returned HTTP ${currentUser.status()}`).toBe(
		true,
	);

	mkdirSync(authDir, { recursive: true, mode: 0o700 });
	chmodSync(authDir, 0o700);
	await request.storageState({ path: authFile });
	chmodSync(authFile, 0o600);
});
