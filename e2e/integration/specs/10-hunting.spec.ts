/**
 * Integration: Hunting
 *
 * Validates the hunting/auto-search page with real services:
 * - Page loads with content
 * - Configuration can be accessed
 * - No errors with real service connections
 */

import { test, expect } from "@playwright/test";
import { ROUTES, TIMEOUTS, waitForLoadingComplete } from "../../utils/test-helpers";
import { ensureAuthenticated } from "../utils/auth-helpers";

test.describe("Hunting with Real Services", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(ROUTES.hunting);
		await waitForLoadingComplete(page);
		await ensureAuthenticated(page);
	});

	test("should display hunting page", async ({ page }) => {
		const heading = page.getByRole("heading").first();
		await expect(heading).toBeVisible({ timeout: TIMEOUTS.medium });
	});

	test("should show hunting page content", async ({ page }) => {
		// Hunting page should have main visible
		const mainContent = page.locator("main");
		await expect(mainContent).toBeVisible({ timeout: TIMEOUTS.medium });
	});

	test("should show hunt configuration with instances", async ({ page }) => {
		// Navigate to Configuration tab if available
		const configTab = page.getByRole("tab", { name: /configuration/i });
		if ((await configTab.count()) > 0) {
			await configTab.click();
			await page.waitForTimeout(1000);
		}

		// Should show instance references (Sonarr/Radarr)
		const instanceRefs = page.getByText(/E2E Sonarr|E2E Radarr|sonarr|radarr/i);
		expect(await instanceRefs.count()).toBeGreaterThan(0);
	});

	test("should not show error alerts", async ({ page }) => {
		const errorAlert = page.locator('[role="alert"]').filter({ hasText: /error|failed/i });
		expect(await errorAlert.count()).toBe(0);
	});
});
