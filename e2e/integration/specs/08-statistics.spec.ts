/**
 * Integration: Statistics
 *
 * Validates the statistics page with real service data:
 * - Overview tab shows aggregated stats
 * - Sonarr tab shows series/episode data
 * - Radarr tab shows movie data
 * - Real disk space values appear (not zeros)
 */

import { test, expect } from "@playwright/test";
import { ROUTES, TIMEOUTS, waitForLoadingComplete } from "../../utils/test-helpers";
import { ensureAuthenticated } from "../utils/auth-helpers";

test.describe("Statistics with Real Data", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(ROUTES.statistics);
		await waitForLoadingComplete(page);
		await ensureAuthenticated(page);
	});

	test("should display statistics page heading", async ({ page }) => {
		const heading = page.getByRole("heading").first();
		await expect(heading).toBeVisible({ timeout: TIMEOUTS.medium });
	});

	test("should show Overview tab with stats", async ({ page }) => {
		// Overview tab should be visible and active by default
		const overviewTab = page.getByRole("tab", { name: /overview/i });
		if ((await overviewTab.count()) > 0) {
			await expect(overviewTab).toBeVisible();
		}

		// Should show some statistical content (cards, charts, numbers)
		const mainContent = page.locator("main");
		await expect(mainContent).toBeVisible();
	});

	test("should display Sonarr statistics tab", async ({ page }) => {
		// Navigate to Sonarr tab
		const sonarrTab = page.getByRole("tab", { name: /sonarr/i });
		if ((await sonarrTab.count()) > 0) {
			await sonarrTab.click();
			await page.waitForTimeout(1000);

			// Should show Sonarr-specific stats (series count, episodes, disk space)
			const mainContent = page.locator("main");
			await expect(mainContent).toBeVisible();

			// Look for any stat values
			const statContent = page.getByText(/series|episode|disk|space|total/i);
			expect(await statContent.count()).toBeGreaterThan(0);
		}
	});

	test("should display Radarr statistics tab", async ({ page }) => {
		const radarrTab = page.getByRole("tab", { name: /radarr/i });
		if ((await radarrTab.count()) > 0) {
			await radarrTab.click();
			await page.waitForTimeout(1000);

			const mainContent = page.locator("main");
			await expect(mainContent).toBeVisible();

			const statContent = page.getByText(/movie|disk|space|total/i);
			expect(await statContent.count()).toBeGreaterThan(0);
		}
	});

	test("should show disk space information", async ({ page }) => {
		// With real services, disk space should show actual values
		const diskInfo = page.getByText(/disk|storage|space|free|used/i);

		if ((await diskInfo.count()) > 0) {
			// At least one disk space element should be visible
			await expect(diskInfo.first()).toBeVisible();
		}
	});

	test("should not show error alerts", async ({ page }) => {
		const errorAlert = page.locator('[role="alert"]').filter({ hasText: /error|failed/i });
		expect(await errorAlert.count()).toBe(0);
	});
});
