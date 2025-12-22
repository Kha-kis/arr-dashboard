import { test as setup, expect } from "@playwright/test";
import path from "node:path";

const authFile = path.join(__dirname, "../.playwright-auth/user.json");

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
	await page.goto("http://localhost:3000/login");

	// Check if already logged in (redirected to dashboard)
	if (page.url().includes("/dashboard")) {
		// Already authenticated, save state
		await page.context().storageState({ path: authFile });
		return;
	}

	// Wait for login form
	await expect(page.getByRole("heading", { name: /sign in|login/i })).toBeVisible({ timeout: 10000 });

	// Fill in credentials
	// Note: These should match your test environment
	const username = process.env.TEST_USERNAME || "khak1s";
	const password = process.env.TEST_PASSWORD;

	if (!password) {
		// If no password is set, try to check if we're already logged in via cookies
		console.log("No TEST_PASSWORD set. Attempting to use existing session...");

		// Try navigating to a protected page
		await page.goto("http://localhost:3000/dashboard");

		if (page.url().includes("/login")) {
			throw new Error(
				"Authentication required. Set TEST_PASSWORD environment variable or login manually first."
			);
		}

		// We're logged in, save state
		await page.context().storageState({ path: authFile });
		return;
	}

	// Fill login form
	await page.getByLabel(/username/i).fill(username);
	await page.getByLabel(/password/i).fill(password);

	// Click sign in
	await page.getByRole("button", { name: /sign in/i }).click();

	// Wait for successful login (redirect to dashboard)
	await expect(page).toHaveURL(/\/dashboard/, { timeout: 15000 });

	// Verify we're logged in
	await expect(page.getByText(username)).toBeVisible({ timeout: 5000 });

	// Save authentication state
	await page.context().storageState({ path: authFile });
});
