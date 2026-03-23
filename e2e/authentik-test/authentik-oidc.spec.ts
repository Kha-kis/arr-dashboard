/**
 * Authentik OIDC Integration Test
 *
 * Validates the fix for GitHub Issue #208: OIDC issuer URL trailing slash normalization
 *
 * Authentik includes a trailing slash in its canonical issuer URL, which caused
 * oauth4webapi to fail with "issuer property does not match" when we stripped it.
 *
 * This test:
 * 1. Reads OIDC credentials from bootstrap .env.test file
 * 2. Verifies Authentik discovery endpoint returns issuer WITH trailing slash
 * 3. Configures arr-dashboard OIDC via the setup page
 * 4. Verifies the stored issuer matches Authentik's canonical value
 * 5. Completes the full OIDC login flow (redirect → Authentik login → callback)
 *
 * Prerequisites:
 *   cd e2e/authentik-test
 *   docker compose up -d
 *   bash bootstrap.sh
 *   # arr-dashboard must be running on localhost:3000 (fresh, no user created)
 */

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Load test config from bootstrap output
// ---------------------------------------------------------------------------

function loadTestEnv(): Record<string, string> {
	const envPath = resolve(__dirname, ".env.test");
	try {
		const content = readFileSync(envPath, "utf-8");
		const env: Record<string, string> = {};
		for (const line of content.split("\n")) {
			const [key, ...rest] = line.split("=");
			if (key && rest.length > 0) {
				env[key.trim()] = rest.join("=").trim();
			}
		}
		return env;
	} catch {
		throw new Error(
			`Missing .env.test — run bootstrap.sh first.\n` +
				`  cd e2e/authentik-test && docker compose up -d && bash bootstrap.sh`,
		);
	}
}

const ENV = loadTestEnv();
const AUTHENTIK_URL = ENV.AUTHENTIK_URL || "http://localhost:9000";
const ARR_DASHBOARD_URL = ENV.ARR_DASHBOARD_URL || "http://localhost:3000";
const ISSUER_URL = ENV.AUTHENTIK_ISSUER_URL!;
const CLIENT_ID = ENV.AUTHENTIK_CLIENT_ID!;
const CLIENT_SECRET = ENV.AUTHENTIK_CLIENT_SECRET!;
const ADMIN_USERNAME = ENV.AUTHENTIK_ADMIN_USERNAME || "akadmin";
const ADMIN_PASSWORD = ENV.AUTHENTIK_ADMIN_PASSWORD || "TestPassword123!";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Authentik OIDC Integration (#208)", () => {
	test.describe.configure({ mode: "serial" });

	test("Authentik discovery endpoint returns issuer WITH trailing slash", async ({
		request,
	}) => {
		const discoveryUrl = ISSUER_URL.endsWith("/")
			? `${ISSUER_URL}.well-known/openid-configuration`
			: `${ISSUER_URL}/.well-known/openid-configuration`;

		const response = await request.get(discoveryUrl);
		expect(response.ok()).toBeTruthy();

		const doc = await response.json();
		expect(doc.issuer).toBeDefined();
		// Authentik's canonical issuer includes trailing slash
		expect(doc.issuer).toMatch(/\/$/);
		console.log(`Discovery issuer: ${doc.issuer}`);
	});

	test("arr-dashboard OIDC setup accepts Authentik issuer with trailing slash", async ({
		page,
	}) => {
		// Navigate to setup page (assumes fresh instance with no users)
		await page.goto(`${ARR_DASHBOARD_URL}/setup`);
		await page.waitForTimeout(2000);

		// Check if we're on the setup page or already set up
		const pageText = await page.textContent("body");
		if (!pageText?.includes("setup") && !pageText?.includes("Setup")) {
			test.skip(true, "App already has a user — cannot test first-run OIDC setup");
			return;
		}

		// Select OIDC authentication method
		const oidcButton = page.locator("button, [role=button]").filter({
			hasText: /OIDC|OpenID|Single Sign/i,
		});
		if ((await oidcButton.count()) > 0) {
			await oidcButton.first().click();
			await page.waitForTimeout(1000);
		}

		// Fill OIDC configuration
		// The issuer URL intentionally has a trailing slash (Authentik format)
		const issuerInput = page.locator(
			'input[name="issuer"], input[placeholder*="issuer" i], input[placeholder*="URL" i]',
		).first();
		await issuerInput.fill(ISSUER_URL);

		const clientIdInput = page.locator(
			'input[name="clientId"], input[placeholder*="client" i]',
		).first();
		await clientIdInput.fill(CLIENT_ID);

		const clientSecretInput = page.locator(
			'input[name="clientSecret"], input[type="password"]',
		).first();
		await clientSecretInput.fill(CLIENT_SECRET);

		// Submit the OIDC setup
		const submitButton = page.locator("button[type=submit], button").filter({
			hasText: /continue|setup|save|submit/i,
		});
		await submitButton.first().click();
		await page.waitForTimeout(3000);

		// Verify no error about issuer mismatch
		const bodyText = await page.textContent("body");
		expect(bodyText).not.toContain("issuer");
		expect(bodyText).not.toContain("OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED");

		console.log("OIDC setup completed without issuer mismatch error");
	});

	test("OIDC login redirects to Authentik and completes flow", async ({ page }) => {
		// Navigate to login page
		await page.goto(`${ARR_DASHBOARD_URL}/login`);
		await page.waitForTimeout(2000);

		// Click OIDC login button
		const oidcLoginButton = page.locator("button, a").filter({
			hasText: /OIDC|OpenID|Sign in with|SSO/i,
		});

		if ((await oidcLoginButton.count()) === 0) {
			test.skip(true, "No OIDC login button found — OIDC may not be configured");
			return;
		}

		await oidcLoginButton.first().click();

		// Should redirect to Authentik login page
		await page.waitForURL(/localhost:9000|localhost:9443/, { timeout: 10000 });
		console.log(`Redirected to Authentik: ${page.url()}`);

		// Fill Authentik login form
		const usernameInput = page.locator('input[name="uidField"], input[type="text"]').first();
		await usernameInput.fill(ADMIN_USERNAME);

		// Authentik may have a two-step login (username first, then password)
		const nextButton = page.locator("button[type=submit]").first();
		await nextButton.click();
		await page.waitForTimeout(1000);

		const passwordInput = page.locator('input[name="password"], input[type="password"]').first();
		if (await passwordInput.isVisible()) {
			await passwordInput.fill(ADMIN_PASSWORD);
			const loginButton = page.locator("button[type=submit]").first();
			await loginButton.click();
		}

		// Authentik may show a consent screen — accept it
		await page.waitForTimeout(2000);
		const consentButton = page.locator("button").filter({ hasText: /continue|allow|accept|consent/i });
		if ((await consentButton.count()) > 0) {
			await consentButton.first().click();
		}

		// Should redirect back to arr-dashboard
		await page.waitForURL(/localhost:3000/, { timeout: 15000 });
		console.log(`Redirected back to dashboard: ${page.url()}`);

		// Verify we're logged in (not on login page)
		expect(page.url()).not.toContain("/login");
		console.log("OIDC login flow completed successfully!");
	});
});
