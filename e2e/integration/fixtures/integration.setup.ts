/**
 * Integration Test Setup
 *
 * Runs before all integration specs to:
 * 1. Register an admin user on the fresh arr-dashboard instance
 * 2. Log in and save auth state for subsequent tests
 * 3. Add Sonarr, Radarr, Lidarr, Readarr, and Prowlarr as service instances
 * 4. Verify each service connection succeeds
 *
 * Follows the same pattern as e2e/auth.setup.ts but adds service registration.
 */

import { test as setup, expect, request } from "@playwright/test";
import path from "node:path";

const authFile = path.join(__dirname, "../.playwright-auth/integration-user.json");

const DASHBOARD_URL = process.env.DASHBOARD_URL || "http://localhost:3000";
const API_URL = process.env.DASHBOARD_API_URL || "http://localhost:3001";

const TEST_USERNAME = "integration-admin";
const TEST_PASSWORD = "IntTest@P4ssw0rd!";

// Service connection details from .env.services (set by bootstrap-services.sh)
const SERVICES = [
	{
		label: "E2E Sonarr",
		service: "sonarr",
		baseUrl: process.env.SONARR_URL || "http://sonarr:8989",
		apiKey: process.env.SONARR_API_KEY || "",
	},
	{
		label: "E2E Radarr",
		service: "radarr",
		baseUrl: process.env.RADARR_URL || "http://radarr:7878",
		apiKey: process.env.RADARR_API_KEY || "",
	},
	{
		label: "E2E Lidarr",
		service: "lidarr",
		baseUrl: process.env.LIDARR_URL || "http://lidarr:8686",
		apiKey: process.env.LIDARR_API_KEY || "",
	},
	{
		label: "E2E Readarr",
		service: "readarr",
		baseUrl: process.env.READARR_URL || "http://readarr:8787",
		apiKey: process.env.READARR_API_KEY || "",
	},
	{
		label: "E2E Prowlarr",
		service: "prowlarr",
		baseUrl: process.env.PROWLARR_URL || "http://prowlarr:9696",
		apiKey: process.env.PROWLARR_API_KEY || "",
	},
] as const;

setup("register user and add services", async ({ page }) => {
	const apiContext = await request.newContext({ baseURL: API_URL });

	// ── Step 1: Register admin user ───────────────────────────────────
	console.log("[setup] Registering admin user...");
	const registerResponse = await apiContext.post("/auth/register", {
		data: { username: TEST_USERNAME, password: TEST_PASSWORD },
	});

	if (registerResponse.ok()) {
		console.log("[setup] User registered successfully");
		// Registration creates a session — log out so we can test login flow
		await apiContext.post("/auth/logout");
	} else {
		const body = await registerResponse.text();
		if (body.includes("already") || registerResponse.status() === 403) {
			console.log("[setup] User already exists, proceeding to login");
		} else {
			throw new Error(`Registration failed (${registerResponse.status()}): ${body}`);
		}
	}

	// ── Step 2: Log in via browser and save auth state ────────────────
	console.log("[setup] Logging in via browser...");
	await page.goto(`${DASHBOARD_URL}/login`);

	// If already redirected to dashboard, user is logged in
	if (!page.url().includes("/dashboard")) {
		await expect(page.getByRole("heading", { name: /sign in|login/i })).toBeVisible({
			timeout: 15_000,
		});

		await page.getByRole("textbox", { name: /username/i }).fill(TEST_USERNAME);
		await page.getByRole("textbox", { name: /password/i }).fill(TEST_PASSWORD);
		await page.getByRole("button", { name: /sign in with password/i }).click();

		await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
	}

	// Verify greeting
	await expect(
		page.getByRole("heading", { name: new RegExp(`Hi,?\\s*${TEST_USERNAME}`, "i") }),
	).toBeVisible({ timeout: 10_000 });

	// Save auth state
	await page.context().storageState({ path: authFile });
	console.log("[setup] Auth state saved");

	// ── Step 3: Add service instances via API ─────────────────────────
	// Create a fresh API context with the session cookie from the browser
	const cookies = await page.context().cookies();
	const sessionCookie = cookies.find((c) => c.name === "arr_session");
	if (!sessionCookie) {
		throw new Error("No arr_session cookie found after login");
	}

	const authedApi = await request.newContext({
		baseURL: API_URL,
		extraHTTPHeaders: {
			Cookie: `arr_session=${sessionCookie.value}`,
		},
	});

	// Check if services are already registered (idempotent re-runs)
	const existingResponse = await authedApi.get("/api/services");
	const existingData = await existingResponse.json();
	const existingLabels = new Set(
		(existingData.services || []).map((s: { label: string }) => s.label),
	);

	for (const svc of SERVICES) {
		if (!svc.apiKey) {
			console.log(`[setup] WARN: No API key for ${svc.service}, skipping`);
			continue;
		}

		if (existingLabels.has(svc.label)) {
			console.log(`[setup] ${svc.label} already registered, skipping`);
			continue;
		}

		console.log(`[setup] Adding ${svc.label} (${svc.baseUrl})...`);

		const addResponse = await authedApi.post("/api/services", {
			data: {
				label: svc.label,
				baseUrl: svc.baseUrl,
				apiKey: svc.apiKey,
				service: svc.service,
				enabled: true,
			},
		});

		if (!addResponse.ok()) {
			const errorBody = await addResponse.text();
			throw new Error(`Failed to add ${svc.label} (${addResponse.status()}): ${errorBody}`);
		}

		// Response shape: { service: { id, label, ... } }
		const responseData = await addResponse.json();
		const instanceId = responseData.service?.id;
		console.log(`[setup] Added ${svc.label} (id: ${instanceId})`);

		// ── Step 4: Verify connection ─────────────────────────────────
		if (instanceId) {
			const testResponse = await authedApi.post(`/api/services/${instanceId}/test`);

			if (testResponse.ok()) {
				const result = await testResponse.json();
				if (result.success) {
					console.log(`[setup] ${svc.label}: connected (v${result.version})`);
				} else {
					console.log(`[setup] WARN: ${svc.label} connection test failed: ${result.error}`);
				}
			} else {
				console.log(`[setup] WARN: ${svc.label} test endpoint returned ${testResponse.status()}`);
			}
		}
	}

	await authedApi.dispose();
	await apiContext.dispose();

	console.log("[setup] Integration setup complete");
});
