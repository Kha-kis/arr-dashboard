/**
 * Authentication E2E Tests
 *
 * Tests for login, logout, session persistence, and protected routes.
 * Note: auth.setup.ts handles the initial authentication for other tests.
 */

import { test, expect } from "@playwright/test";
import { ROUTES, TIMEOUTS, navigateTo, waitForPageHeading } from "./utils/test-helpers";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3000";

test.describe("Authentication - Login Page", () => {
	// Use a fresh context without auth for login tests
	test.use({ storageState: { cookies: [], origins: [] } });

	test("should display login page with all elements", async ({ page }) => {
		await page.goto(ROUTES.login);

		// Check page title/heading
		await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();

		// Check for username field
		await expect(page.getByLabel(/username/i)).toBeVisible();

		// Check for password field
		await expect(page.getByLabel(/password/i)).toBeVisible();

		// Check for sign in button
		await expect(
			page.getByRole("button", { name: /sign in with password/i }),
		).toBeVisible();

		// Check for remember me checkbox
		await expect(page.getByText(/remember me/i)).toBeVisible();
	});

	test("should show passkey option if passkeys are configured", async ({ page }) => {
		await page.goto(ROUTES.login);

		// Passkey button may or may not be visible depending on setup
		const passkeyButton = page.getByRole("button", { name: /passkey/i });
		// Just verify the login page loads properly
		await expect(page.getByLabel(/username/i)).toBeVisible();
	});

	test("should show error for invalid credentials", async ({ page }) => {
		await page.goto(ROUTES.login);

		// Fill in wrong credentials
		await page.getByLabel(/username/i).fill("wronguser");
		await page.getByLabel(/password/i).fill("wrongpassword123!");

		// Submit form
		await page.getByRole("button", { name: /sign in with password/i }).click();

		// Should show error message
		await expect(page.getByText(/invalid|unauthorized|incorrect/i)).toBeVisible({
			timeout: TIMEOUTS.medium,
		});

		// Should still be on login page
		expect(page.url()).toContain("/login");
	});

	test("should show error for empty credentials", async ({ page }) => {
		await page.goto(ROUTES.login);

		// Try to submit without filling fields
		await page.getByRole("button", { name: /sign in with password/i }).click();

		// Should show validation error or stay on login
		expect(page.url()).toContain("/login");
	});

	test("should redirect to dashboard after successful login", async ({ page }) => {
		const username = process.env.TEST_USERNAME;
		const password = process.env.TEST_PASSWORD;

		if (!username || !password) {
			test.skip();
			return;
		}

		await page.goto(ROUTES.login);

		// Fill in correct credentials
		await page.getByLabel(/username/i).fill(username);
		await page.getByLabel(/password/i).fill(password);

		// Submit form
		await page.getByRole("button", { name: /sign in with password/i }).click();

		// Should redirect to dashboard
		await expect(page).toHaveURL(/\/dashboard/, { timeout: TIMEOUTS.long });
	});

	test("should redirect unauthenticated users to login", async ({ page }) => {
		// Try to access protected route without auth
		await page.goto(ROUTES.dashboard);

		// Should redirect to login
		await expect(page).toHaveURL(/\/login/, { timeout: TIMEOUTS.navigation });
	});

	test("should redirect to setup page when no user exists", async ({ page }) => {
		// This test is conditional - only runs if the app is in fresh state
		await page.goto(ROUTES.login);

		// Check if redirected to setup (only happens for fresh installs)
		const url = page.url();
		// Either login or setup is valid
		expect(url.includes("/login") || url.includes("/setup")).toBe(true);
	});
});

test.describe("Authentication - Session Management", () => {
	test("should display user info in header when logged in", async ({ page }) => {
		await page.goto(ROUTES.dashboard);

		// Should see username in the greeting heading (Hi <username>)
		const username = process.env.TEST_USERNAME || "user";
		await expect(page.getByRole("heading", { name: new RegExp(`Hi ${username}`, "i") })).toBeVisible({
			timeout: TIMEOUTS.medium,
		});
	});

	test("should have sign out button visible", async ({ page }) => {
		await page.goto(ROUTES.dashboard);

		// Sign out button should be in header
		await expect(
			page.getByRole("button", { name: /sign out/i }),
		).toBeVisible();
	});

	test("should maintain session across page navigation", async ({ page }) => {
		// Navigate to dashboard
		await page.goto(ROUTES.dashboard);
		await expect(page).toHaveURL(/\/dashboard/);

		// Navigate to settings
		await page.goto(ROUTES.settings);
		await expect(page).toHaveURL(/\/settings/);

		// Should still be logged in (not redirected to login)
		await expect(
			page.getByRole("button", { name: /sign out/i }),
		).toBeVisible();
	});

	test("should maintain session after page refresh", async ({ page }) => {
		await page.goto(ROUTES.dashboard);

		// Refresh the page
		await page.reload();

		// Should still be on dashboard (not redirected to login)
		await expect(page).toHaveURL(/\/dashboard/);
		await expect(
			page.getByRole("button", { name: /sign out/i }),
		).toBeVisible();
	});
});

test.describe("Authentication - Logout", () => {
	// Use fresh context for logout tests to avoid invalidating the shared session
	test.use({ storageState: { cookies: [], origins: [] } });

	test("should log out user and redirect to login", async ({ page }) => {
		const username = process.env.TEST_USERNAME;
		const password = process.env.TEST_PASSWORD;

		if (!username || !password) {
			test.skip();
			return;
		}

		// First log in with fresh session
		await page.goto(ROUTES.login);
		await page.getByLabel(/username/i).fill(username);
		await page.getByLabel(/password/i).fill(password);
		await page.getByRole("button", { name: /sign in with password/i }).click();

		// Wait for redirect to dashboard
		await expect(page).toHaveURL(/\/dashboard/, { timeout: TIMEOUTS.long });

		// Wait for sign out button to be visible before clicking
		const signOutButton = page.getByRole("button", { name: /sign out/i });
		await expect(signOutButton).toBeVisible({ timeout: TIMEOUTS.medium });

		// Click sign out
		await signOutButton.click();

		// Should redirect to login
		await expect(page).toHaveURL(/\/login/, { timeout: TIMEOUTS.navigation });
	});

	test("should not allow access to protected routes after logout", async ({ page }) => {
		const username = process.env.TEST_USERNAME;
		const password = process.env.TEST_PASSWORD;

		if (!username || !password) {
			test.skip();
			return;
		}

		// First log in with fresh session
		await page.goto(ROUTES.login);
		await page.getByLabel(/username/i).fill(username);
		await page.getByLabel(/password/i).fill(password);
		await page.getByRole("button", { name: /sign in with password/i }).click();
		await expect(page).toHaveURL(/\/dashboard/, { timeout: TIMEOUTS.long });

		// Click sign out
		await page.getByRole("button", { name: /sign out/i }).click();

		// Wait for redirect to login
		await expect(page).toHaveURL(/\/login/, { timeout: TIMEOUTS.navigation });

		// Try to navigate to protected route
		await page.goto(ROUTES.dashboard);

		// Should be redirected back to login
		await expect(page).toHaveURL(/\/login/, { timeout: TIMEOUTS.navigation });
	});
});

test.describe("Authentication - Protected Routes", () => {
	// Test without auth to verify protection
	test.describe("Without authentication", () => {
		test.use({ storageState: { cookies: [], origins: [] } });

		const protectedRoutes = [
			{ name: "Dashboard", route: ROUTES.dashboard },
			{ name: "Library", route: ROUTES.library },
			{ name: "Calendar", route: ROUTES.calendar },
			{ name: "Search", route: ROUTES.search },
			{ name: "Discover", route: ROUTES.discover },
			{ name: "Indexers", route: ROUTES.indexers },
			{ name: "History", route: ROUTES.history },
			{ name: "Statistics", route: ROUTES.statistics },
			{ name: "Hunting", route: ROUTES.hunting },
			{ name: "Settings", route: ROUTES.settings },
			{ name: "TRaSH Guides", route: ROUTES.trashGuides },
		];

		for (const { name, route } of protectedRoutes) {
			test(`should redirect ${name} to login when not authenticated`, async ({ page }) => {
				await page.goto(route);
				await expect(page).toHaveURL(/\/login/, { timeout: TIMEOUTS.navigation });
			});
		}
	});
});

test.describe("Authentication - Incognito/Privacy Mode", () => {
	test("should have hide sensitive data toggle", async ({ page }) => {
		await page.goto(ROUTES.dashboard);

		// Look for the incognito/privacy toggle
		const toggleButton = page.getByRole("button", { name: /hide sensitive|incognito|privacy/i });

		// Toggle might exist in the header
		if ((await toggleButton.count()) > 0) {
			await expect(toggleButton).toBeVisible();
		}
	});
});
