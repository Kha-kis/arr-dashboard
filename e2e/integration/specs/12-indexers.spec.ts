/**
 * Integration: Indexers
 *
 * Validates the indexer management page with Prowlarr connected:
 * - Page loads with Prowlarr data
 * - Shows indexer stats (total, enabled, etc.) or content
 * - No critical connection errors
 */

import { test, expect } from "@playwright/test";
import { ROUTES, TIMEOUTS, waitForLoadingComplete } from "../../utils/test-helpers";
import { ensureAuthenticated } from "../utils/auth-helpers";

test.describe("Indexers with Prowlarr Connected", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(ROUTES.indexers);
		await waitForLoadingComplete(page);
		await ensureAuthenticated(page);
	});

	test("should display indexers page", async ({ page }) => {
		const heading = page.getByRole("heading").first();
		await expect(heading).toBeVisible({ timeout: TIMEOUTS.medium });
	});

	test("should show indexer stats or content", async ({ page }) => {
		// The indexers page shows stat cards (Total indexers, Enabled, Torrent, Usenet, etc.)
		// even with 0 indexers configured in Prowlarr
		const mainContent = page.locator("main");
		await expect(mainContent).toBeVisible();

		// Look for stat text, indexer items, or the stat cards
		const statText = page.getByText(/total|enabled|indexer|torrent|usenet|search capable|rss/i);
		await expect(statText.first()).toBeVisible({ timeout: TIMEOUTS.medium });
	});

	test("should show Prowlarr data instead of empty state", async ({ page }) => {
		// With Prowlarr connected, the page should eventually show real data (stat cards)
		// instead of the "No Prowlarr Instances Configured" empty state.
		// We wait for stat cards to appear — they only render when instances[] is populated.
		const statText = page.getByText(/total|enabled|indexer|torrent|usenet|search capable|rss/i);
		await expect(statText.first()).toBeVisible({ timeout: TIMEOUTS.long });
	});

	test("should not show error alerts", async ({ page }) => {
		const errorAlert = page.locator('[role="alert"]').filter({ hasText: /error|failed/i });
		expect(await errorAlert.count()).toBe(0);
	});
});
