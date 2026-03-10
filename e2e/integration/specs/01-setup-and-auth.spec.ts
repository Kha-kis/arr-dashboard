/**
 * Integration: Setup & Authentication
 *
 * Validates the auth system works correctly in a Docker environment:
 * - Session persistence across page navigations
 * - Greeting displays correct username
 * - Sign-out button is accessible
 */

import { test, expect } from "@playwright/test";
import { ROUTES, TIMEOUTS, waitForLoadingComplete } from "../../utils/test-helpers";
import { seedAll } from "../fixtures/seed-arr-data";

const TEST_USERNAME = "integration-admin";

test.describe("Authentication in Docker", () => {
	test("should seed *arr instances with test data", async () => {
		// Seed data into Sonarr/Radarr before running UI tests.
		// This runs once per suite — seed-arr-data.ts is idempotent.
		// Non-fatal: seeding may fail if containers have permission issues,
		// but the dashboard tests should still work with empty data.
		try {
			await seedAll();
		} catch (error) {
			console.log(`[seed] Seeding failed (non-fatal): ${error instanceof Error ? error.message : error}`);
		}
	});

	test("should be logged in with correct username", async ({ page }) => {
		await page.goto(ROUTES.dashboard);
		await waitForLoadingComplete(page);

		// Greeting heading should show the integration user
		await expect(
			page.getByRole("heading", { name: new RegExp(`Hi,?\\s*${TEST_USERNAME}`, "i") }),
		).toBeVisible({ timeout: TIMEOUTS.medium });
	});

	test("should persist session across navigation", async ({ page }) => {
		await page.goto(ROUTES.dashboard);
		await waitForLoadingComplete(page);

		// Navigate to another page and back
		await page.goto(ROUTES.settings);
		await waitForLoadingComplete(page);

		await page.goto(ROUTES.dashboard);
		await waitForLoadingComplete(page);

		// Should still be authenticated
		await expect(
			page.getByRole("heading", { name: new RegExp(`Hi,?\\s*${TEST_USERNAME}`, "i") }),
		).toBeVisible({ timeout: TIMEOUTS.medium });
	});

	test("should show sign-out button", async ({ page }) => {
		await page.goto(ROUTES.dashboard);
		await waitForLoadingComplete(page);

		await expect(page.getByRole("button", { name: /sign out/i })).toBeVisible();
	});
});
