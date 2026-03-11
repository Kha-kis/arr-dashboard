/**
 * Integration: TRaSH Guides
 *
 * Validates the TRaSH Guides quality profile wizard with real services:
 * - Page loads and renders
 * - Service instances are referenced
 * - No error states
 */

import { test, expect } from "@playwright/test";
import { ROUTES, TIMEOUTS, waitForLoadingComplete } from "../../utils/test-helpers";
import { ensureAuthenticated } from "../utils/auth-helpers";

test.describe("TRaSH Guides with Real Services", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(ROUTES.trashGuides);
		await waitForLoadingComplete(page);
		await ensureAuthenticated(page);
	});

	test("should display TRaSH Guides page", async ({ page }) => {
		const heading = page.getByRole("heading").first();
		await expect(heading).toBeVisible({ timeout: TIMEOUTS.long });
	});

	test("should show TRaSH Guides page content", async ({ page }) => {
		// TRaSH Guides page loads content from GitHub cache — may take time
		const mainContent = page.locator("main");
		await expect(mainContent).toBeVisible({ timeout: TIMEOUTS.medium });
	});

	test("should show connected service instances for deployment", async ({ page }) => {
		// The deploy/instance selection should list real services
		const serviceRefs = page.getByText(/E2E Sonarr|E2E Radarr|sonarr|radarr/i);
		expect(await serviceRefs.count()).toBeGreaterThan(0);
	});

	test("should not show error alerts", async ({ page }) => {
		await page.waitForTimeout(2000);

		const errorAlert = page.locator('[role="alert"]').filter({ hasText: /error|failed/i });
		expect(await errorAlert.count()).toBe(0);
	});
});
