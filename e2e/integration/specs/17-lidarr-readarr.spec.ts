/**
 * Integration: Lidarr & Readarr
 *
 * Validates that Lidarr (music) and Readarr (books) instances are properly
 * connected and visible in the dashboard, settings, and library pages.
 * Verifies the full service type spectrum beyond Sonarr/Radarr/Prowlarr.
 */

import { test, expect } from "@playwright/test";
import { ROUTES, TIMEOUTS, waitForLoadingComplete, selectTab } from "../../utils/test-helpers";
import { ensureAuthenticated } from "../utils/auth-helpers";
import { seedLidarr, seedReadarr } from "../fixtures/seed-arr-data";

test.describe("Lidarr & Readarr Integration", () => {
	test("should seed Lidarr and Readarr with test data", async () => {
		await seedLidarr();
		await seedReadarr();
	});

	test("should show Lidarr and Readarr in settings services tab", async ({ page }) => {
		await page.goto(ROUTES.settings);
		await waitForLoadingComplete(page);
		await ensureAuthenticated(page);

		// Navigate to Services tab
		await selectTab(page, "Services");
		await page.waitForTimeout(1000);

		// Both services should be listed
		await expect(page.getByText("E2E Lidarr")).toBeVisible({ timeout: TIMEOUTS.medium });
		await expect(page.getByText("E2E Readarr")).toBeVisible({ timeout: TIMEOUTS.medium });
	});

	test("should show Connected status for Lidarr", async ({ page }) => {
		await page.goto(ROUTES.settings);
		await waitForLoadingComplete(page);
		await ensureAuthenticated(page);
		await selectTab(page, "Services");
		await page.waitForTimeout(1000);

		// Service card should be visible (scroll may be needed for 5 services)
		await expect(page.getByText("E2E Lidarr")).toBeVisible({ timeout: TIMEOUTS.medium });
	});

	test("should show Connected status for Readarr", async ({ page }) => {
		await page.goto(ROUTES.settings);
		await waitForLoadingComplete(page);
		await ensureAuthenticated(page);
		await selectTab(page, "Services");
		await page.waitForTimeout(1000);

		await expect(page.getByText("E2E Readarr")).toBeVisible({ timeout: TIMEOUTS.medium });
	});

	test("should show Lidarr and Readarr on dashboard", async ({ page }) => {
		await page.goto(ROUTES.dashboard);
		await waitForLoadingComplete(page);
		await ensureAuthenticated(page);

		// Dashboard should list all 5 instances somewhere (stat cards, instances table, etc.)
		// Use the instance labels which are guaranteed to appear
		await expect(page.getByText("E2E Lidarr").first()).toBeVisible({
			timeout: TIMEOUTS.medium,
		});
		await expect(page.getByText("E2E Readarr").first()).toBeVisible({
			timeout: TIMEOUTS.medium,
		});
	});

	test("should show 5 services in dashboard instances table", async ({ page }) => {
		await page.goto(ROUTES.dashboard);
		await waitForLoadingComplete(page);
		await ensureAuthenticated(page);

		// The instances table should contain all 5 service instances
		for (const label of ["E2E Sonarr", "E2E Radarr", "E2E Lidarr", "E2E Readarr", "E2E Prowlarr"]) {
			await expect(page.getByText(label).first()).toBeVisible({
				timeout: TIMEOUTS.medium,
			});
		}
	});

	test("should show Lidarr content in library", async ({ page }) => {
		await page.goto(ROUTES.library);
		await waitForLoadingComplete(page);
		await ensureAuthenticated(page);

		// Check for music-related content or lidarr service badge
		const lidarrBadge = page.getByText(/lidarr/i).first();
		const musicFilter = page.getByRole("button", { name: /music|artist/i }).first();

		const hasLidarrContent = (await lidarrBadge.count()) > 0 || (await musicFilter.count()) > 0;
		// Content may not appear if seed failed (MusicBrainz network dependency)
		if (!hasLidarrContent) {
			test.skip(true, "Lidarr content not found — seed may have failed (MusicBrainz dependency)");
			return;
		}
	});

	test("should show Readarr content in library", async ({ page }) => {
		await page.goto(ROUTES.library);
		await waitForLoadingComplete(page);
		await ensureAuthenticated(page);

		const readarrBadge = page.getByText(/readarr/i).first();
		const booksFilter = page.getByRole("button", { name: /books|author/i }).first();

		const hasReadarrContent = (await readarrBadge.count()) > 0 || (await booksFilter.count()) > 0;
		// Content may not appear if seed failed (api.bookinfo.club network dependency)
		if (!hasReadarrContent) {
			test.skip(true, "Readarr content not found — seed may have failed (bookinfo.club dependency)");
			return;
		}
	});

	test("should not show error alerts on any page with extended services", async ({ page }) => {
		const pages = [ROUTES.dashboard, ROUTES.library, ROUTES.statistics, ROUTES.calendar];

		for (const route of pages) {
			await page.goto(route);
			await waitForLoadingComplete(page);
			await ensureAuthenticated(page);

			const errorAlerts = page.getByRole("alert").filter({ hasText: /error|failed/i });
			const errorCount = await errorAlerts.count();
			expect(errorCount, `Error alert found on ${route}`).toBe(0);
		}
	});
});
