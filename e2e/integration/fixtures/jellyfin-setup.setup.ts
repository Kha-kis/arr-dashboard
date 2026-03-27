/**
 * Jellyfin Setup Wizard — driven via Playwright.
 *
 * Seerr requires a media server to create its first admin user.
 * Jellyfin's startup REST API is broken across versions (POST /Startup/User
 * crashes), so this script completes the wizard through the web UI.
 *
 * Run before bootstrap-services.sh:
 *   npx playwright test jellyfin-setup --config=e2e/integration/playwright.integration.config.ts
 */

import { test as setup, expect } from "@playwright/test";

const JELLYFIN_URL = process.env.JELLYFIN_EXTERNAL_URL || "http://localhost:8096";
const ADMIN_USER = "e2e-admin";
const ADMIN_PASS = "E2eTestPass123!";

setup("complete Jellyfin setup wizard", async ({ page }) => {
	await page.goto(`${JELLYFIN_URL}/web/`);

	// Wait for the wizard or detect it's already completed
	const wizardHeading = page.getByText(/preferred language|welcome to jellyfin/i).first();

	try {
		await wizardHeading.waitFor({ state: "visible", timeout: 15_000 });
	} catch {
		console.log("[jellyfin-setup] Wizard not found — may be already completed");
		return;
	}

	console.log("[jellyfin-setup] Wizard detected, completing setup...");

	const nextButton = page.getByRole("button", { name: /next/i });

	// Step 1: Language — click Next
	await nextButton.click();
	await page.waitForTimeout(500);

	// Step 2: Create admin user
	const usernameInput = page.locator('input[id="txtUsername"], input[name="Username"]').first();
	const passwordInput = page.locator('input[id="txtManualPassword"], input[name="Password"], input[type="password"]').first();

	await expect(usernameInput).toBeVisible({ timeout: 5_000 });
	await usernameInput.clear();
	await usernameInput.fill(ADMIN_USER);

	if (await passwordInput.isVisible()) {
		await passwordInput.fill(ADMIN_PASS);
		const confirmPassword = page.locator('input[id="txtPasswordConfirm"], input[name="PasswordConfirm"]').first();
		if (await confirmPassword.isVisible().catch(() => false)) {
			await confirmPassword.fill(ADMIN_PASS);
		}
	}

	await nextButton.click();
	await page.waitForTimeout(500);

	// Steps 3-5: Media Libraries, Metadata, Remote Access — click Next through all
	for (let i = 0; i < 3; i++) {
		await nextButton.click();
		await page.waitForTimeout(500);
	}

	// Step 6: Finish
	const finishButton = page.getByRole("button", { name: /finish|done|complete/i }).first();
	if (await finishButton.isVisible().catch(() => false)) {
		await finishButton.click();
	} else {
		await nextButton.click();
	}

	await page.waitForTimeout(1000);
	console.log("[jellyfin-setup] Wizard completed");

	// Verify admin user was created
	const response = await page.request.post(`${JELLYFIN_URL}/Users/AuthenticateByName`, {
		headers: {
			"Content-Type": "application/json",
			"X-Emby-Authorization": 'MediaBrowser Client="e2e", Device="setup", DeviceId="setup-001", Version="1.0"',
		},
		data: { Username: ADMIN_USER, Pw: ADMIN_PASS },
	});

	if (response.ok()) {
		const data = await response.json();
		console.log(`[jellyfin-setup] Auth verified: ${data.User?.Name} (admin: ${data.User?.Policy?.IsAdministrator})`);
	} else {
		console.log(`[jellyfin-setup] WARN: Auth verification failed (${response.status()})`);
	}
});
