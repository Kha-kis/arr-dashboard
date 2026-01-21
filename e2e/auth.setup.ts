import { test as setup, expect } from "@playwright/test";
import path from "node:path";

const authFile = path.join(__dirname, "../.playwright-auth/user.json");

// Configuration from environment variables
const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3000";
const TEST_CREDENTIALS = {
	username: process.env.TEST_USERNAME || "",
	password: process.env.TEST_PASSWORD || "",
};

// Fail fast if credentials not configured
if (!TEST_CREDENTIALS.username || !TEST_CREDENTIALS.password) {
	throw new Error(
		"TEST_USERNAME and TEST_PASSWORD environment variables are required for E2E tests. " +
			"Set them in your environment or in a .env file.",
	);
}

/**
 * Authentication setup for Playwright tests.
 * This runs before all tests to create an authenticated session.
 *
 * Since the app uses session-based auth with cookies, we need to:
 * 1. Login via the login page
 * 2. Store the session cookie state
 * 3. Reuse it across all tests
 */
setup("authenticate", async ({ page }) => {
	// Go to login page
	await page.goto(`${BASE_URL}/login`);

	// Check if already logged in (redirected to dashboard)
	if (page.url().includes("/dashboard")) {
		// Already authenticated, save state
		await page.context().storageState({ path: authFile });
		return;
	}

	// Wait for login form
	await expect(page.getByRole("heading", { name: /sign in|login/i })).toBeVisible({
		timeout: 10000,
	});

	// Fill login form - use getByRole for specificity (avoids matching "Show password" button)
	await page.getByRole("textbox", { name: /username/i }).fill(TEST_CREDENTIALS.username);
	await page.getByRole("textbox", { name: /password/i }).fill(TEST_CREDENTIALS.password);

	// Click sign in with password button (be specific to avoid matching passkey button)
	await page.getByRole("button", { name: /sign in with password/i }).click();

	// Wait for successful login (redirect to dashboard)
	await expect(page).toHaveURL(/\/dashboard/, { timeout: 15000 });

	// Verify we're logged in by checking for the greeting heading (format: "Hi, username")
	await expect(
		page.getByRole("heading", { name: new RegExp(`Hi,?\\s*${TEST_CREDENTIALS.username}`, "i") }),
	).toBeVisible({ timeout: 5000 });

	// Save authentication state
	await page.context().storageState({ path: authFile });
});
