import { test as setup, expect, request } from "@playwright/test";
import path from "node:path";

const authFile = path.join(__dirname, "../.playwright-auth/user.json");

// Configuration from environment variables
const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3000";
const API_URL = process.env.TEST_API_URL || "http://localhost:3001";

// CI auto-generates credentials if not provided
const CI_TEST_USERNAME = "ci-test-user";
const CI_TEST_PASSWORD = "CiTestP@ssw0rd123!";

const TEST_CREDENTIALS = {
	username: process.env.TEST_USERNAME || (process.env.CI ? CI_TEST_USERNAME : ""),
	password: process.env.TEST_PASSWORD || (process.env.CI ? CI_TEST_PASSWORD : ""),
};

// Fail fast if credentials not configured (only in non-CI environments)
if (!TEST_CREDENTIALS.username || !TEST_CREDENTIALS.password) {
	throw new Error(
		"TEST_USERNAME and TEST_PASSWORD environment variables are required for E2E tests. " +
			"Set them in your environment or in a .env file.",
	);
}

/**
 * In CI, ensure a test user exists by registering via the API.
 * This runs before authentication to create the user if needed.
 */
async function ensureTestUserExists(): Promise<void> {
	// Only auto-register in CI when using default CI credentials
	if (!process.env.CI || process.env.TEST_USERNAME) {
		return;
	}

	const apiContext = await request.newContext({
		baseURL: API_URL,
	});

	try {
		// Always attempt to register - the API will return an error if user exists
		// This is more reliable than checking setupRequired first
		console.log("CI: Attempting to register test user...");
		const registerResponse = await apiContext.post("/auth/register", {
			data: {
				username: CI_TEST_USERNAME,
				password: CI_TEST_PASSWORD,
			},
		});

		if (registerResponse.ok()) {
			console.log("CI: Test user registered successfully");
			// Registration creates a session, but we want to test the login flow
			// So we need to logout first
			await apiContext.post("/auth/logout");
			console.log("CI: Logged out after registration to test login flow");
		} else {
			const errorBody = await registerResponse.text();
			// If user already exists or registration disabled, that's fine
			if (errorBody.includes("already") || errorBody.includes("disabled") || registerResponse.status() === 403) {
				console.log("CI: User already exists or registration disabled, will use existing user");
			} else {
				console.log(`CI: Registration failed (${registerResponse.status()}): ${errorBody}`);
				// Don't throw - let the test attempt to login anyway
			}
		}
	} finally {
		await apiContext.dispose();
	}
}

/**
 * Authentication setup for Playwright tests.
 * This runs before all tests to create an authenticated session.
 *
 * Since the app uses session-based auth with cookies, we need to:
 * 1. In CI: Auto-register a test user if needed
 * 2. Login via the login page
 * 3. Store the session cookie state
 * 4. Reuse it across all tests
 */
setup("authenticate", async ({ page }) => {
	// In CI, ensure test user exists
	await ensureTestUserExists();

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
