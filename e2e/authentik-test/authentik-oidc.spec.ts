/**
 * Real Authentik OIDC regression coverage.
 *
 * Covers the trailing-slash issuer fix from #208 and the explicit account
 * linking, repeat login, and guarded provider deletion lifecycle from #650.
 *
 * Run:
 *   pnpm e2e:authentik:up
 *   pnpm e2e:authentik
 *   pnpm e2e:authentik:down
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";

function loadTestEnv(): Record<string, string> {
	const envPath = resolve(__dirname, ".env.test");
	try {
		const content = readFileSync(envPath, "utf-8");
		return Object.fromEntries(
			content
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const separator = line.indexOf("=");
					return [line.slice(0, separator), line.slice(separator + 1)];
				}),
		);
	} catch {
		throw new Error("Missing e2e/authentik-test/.env.test. Run `pnpm e2e:authentik:up` first.");
	}
}

const ENV = loadTestEnv();
const AUTHENTIK_URL = ENV.AUTHENTIK_URL;
const ARR_DASHBOARD_URL = ENV.ARR_DASHBOARD_URL;
const ISSUER_URL = ENV.AUTHENTIK_ISSUER_URL;
const CLIENT_ID = ENV.AUTHENTIK_CLIENT_ID;
const CLIENT_SECRET = ENV.AUTHENTIK_CLIENT_SECRET;
const ADMIN_USERNAME = ENV.AUTHENTIK_ADMIN_USERNAME;
const ADMIN_PASSWORD = ENV.AUTHENTIK_ADMIN_PASSWORD;

const DASHBOARD_USERNAME = "admin";
const DASHBOARD_PASSWORD = "DashboardTest123!";
const FALLBACK_PASSWORD = "FallbackTest123!";
const PROVIDER_NAME = "Authentik E2E";

function isPrivateIpv4(hostname: string): boolean {
	const octets = hostname.split(".").map(Number);
	if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) {
		return false;
	}
	return (
		octets[0] === 10 ||
		(octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
		(octets[0] === 192 && octets[1] === 168)
	);
}

for (const [name, value] of Object.entries({
	AUTHENTIK_URL,
	ARR_DASHBOARD_URL,
	ISSUER_URL,
	CLIENT_ID,
	CLIENT_SECRET,
	ADMIN_USERNAME,
	ADMIN_PASSWORD,
})) {
	if (!value) {
		throw new Error(`Missing ${name} in e2e/authentik-test/.env.test`);
	}
}

const dashboardUrl = new URL(ARR_DASHBOARD_URL);
if (!["localhost", "127.0.0.1"].includes(dashboardUrl.hostname)) {
	throw new Error(`Refusing to run destructive E2E test against ${ARR_DASHBOARD_URL}`);
}

const authentikUrl = new URL(AUTHENTIK_URL);
if (!isPrivateIpv4(authentikUrl.hostname)) {
	throw new Error(`Refusing to bootstrap non-private Authentik URL ${AUTHENTIK_URL}`);
}
if (new URL(ISSUER_URL).origin !== authentikUrl.origin) {
	throw new Error("Authentik issuer and API URL must use the same isolated origin");
}

async function signInToAuthentik(page: Page): Promise<void> {
	const authentikHost = new URL(AUTHENTIK_URL).host;
	await page.waitForURL((url) => url.host === authentikHost);

	const username = page.getByRole("textbox", { name: "Email or Username" });
	await expect(username).toBeVisible();
	await username.fill(ADMIN_USERNAME);
	await page.getByRole("button", { name: "Log in" }).click();

	const password = page.getByRole("textbox", {
		name: /password/i,
	});
	await expect(password).toBeVisible();
	await password.fill(ADMIN_PASSWORD);
	await page.getByRole("button", { name: /continue|log in/i }).click();
}

test.describe("Authentik OIDC account lifecycle (#208, #650)", () => {
	test("discovery preserves Authentik's canonical trailing-slash issuer", async ({ request }) => {
		const response = await request.get(`${ISSUER_URL}.well-known/openid-configuration`);
		expect(response.ok()).toBeTruthy();

		const discovery = await response.json();
		expect(discovery.issuer).toBe(ISSUER_URL);
		expect(discovery.issuer).toMatch(/\/$/);
		expect(discovery.token_endpoint_auth_methods_supported).toContain("client_secret_basic");
	});

	test("links the admin, signs in again, then safely deletes OIDC", async ({ page }) => {
		await page.goto(`${ARR_DASHBOARD_URL}/setup`);
		await expect(page.getByRole("heading", { name: "Welcome to your dashboard" })).toBeVisible();

		await page.getByRole("button", { name: "Password", exact: true }).click();
		await page.getByRole("textbox", { name: "admin" }).fill(DASHBOARD_USERNAME);
		await page.getByRole("textbox", { name: "At least 8 characters" }).fill(DASHBOARD_PASSWORD);
		await page.getByRole("textbox", { name: "Re-enter password" }).fill(DASHBOARD_PASSWORD);
		await page.getByRole("button", { name: "Create Admin Account" }).click();
		await expect(page).toHaveURL(
			(url) => url.pathname === "/setup" && url.searchParams.get("stage") === "services",
		);

		await page.goto(`${ARR_DASHBOARD_URL}/settings`);
		await page.getByRole("button", { name: "Auth", exact: true }).click();
		await page.getByRole("button", { name: "Configure OIDC" }).click();
		await page.getByRole("textbox", { name: "e.g., Authentik SSO" }).fill(PROVIDER_NAME);
		await page.getByRole("textbox", { name: "https://auth.example.com" }).fill(ISSUER_URL);
		await page.getByRole("textbox", { name: "OAuth client ID" }).fill(CLIENT_ID);
		await page.getByRole("textbox", { name: "OAuth client secret" }).fill(CLIENT_SECRET);
		await page.getByRole("button", { name: "Create & Link Account" }).click();

		await signInToAuthentik(page);
		await expect(page).toHaveURL(
			(url) => url.pathname === "/settings" && url.hash === "#authentication",
			{ timeout: 15_000 },
		);
		await expect(page.getByText("Linked", { exact: true })).toBeVisible();

		await page.getByRole("button", { name: "Sign out" }).click();
		await expect(page).toHaveURL((url) => url.pathname === "/login");
		await page.goto(`${ARR_DASHBOARD_URL}/login`);
		await page.getByRole("button", { name: `Sign in with ${PROVIDER_NAME}` }).click();
		await expect(page).toHaveURL(/\/dashboard$/, { timeout: 15_000 });

		await page.goto(`${ARR_DASHBOARD_URL}/settings`);
		await page.getByRole("button", { name: "Auth", exact: true }).click();
		await page.getByRole("button", { name: "Delete", exact: true }).click();
		await page.getByRole("textbox", { name: "Current password" }).fill(DASHBOARD_PASSWORD);
		await page
			.getByRole("textbox", { name: "Fallback password", exact: true })
			.fill(FALLBACK_PASSWORD);
		await page.getByRole("textbox", { name: "Confirm fallback password" }).fill(FALLBACK_PASSWORD);
		await page.getByRole("button", { name: "Delete and sign out" }).click();

		await expect(page).toHaveURL((url) => url.pathname === "/login");
		await expect(page.getByRole("button", { name: `Sign in with ${PROVIDER_NAME}` })).toHaveCount(
			0,
		);
		await page.getByRole("textbox", { name: "Username" }).fill(DASHBOARD_USERNAME);
		await page.getByRole("textbox", { name: "Password" }).fill(FALLBACK_PASSWORD);
		await page.getByRole("button", { name: "Sign in with password" }).click();
		await expect(page).toHaveURL(/\/dashboard$/);
	});
});
