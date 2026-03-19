/**
 * Integration: Discover
 *
 * Validates the TMDB discover page:
 * - Page loads (TMDB basic access works without API key)
 * - Trending/popular sections render
 * - No error states
 */

import { test, expect } from "@playwright/test";
import { ROUTES, TIMEOUTS, waitForLoadingComplete } from "../../utils/test-helpers";
import { ensureAuthenticated } from "../utils/auth-helpers";

test.describe("Discover Page", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(ROUTES.discover);
		await waitForLoadingComplete(page);
		await ensureAuthenticated(page);
	});

	test("should display discover page", async ({ page }) => {
		const heading = page.getByRole("heading").first();
		await expect(heading).toBeVisible({ timeout: TIMEOUTS.medium });
	});

	test("should show discover content sections", async ({ page }) => {
		// Discover page shows trending/popular/upcoming sections
		const mainContent = page.locator("main");
		await expect(mainContent).toBeVisible();

		const sectionContent = page.getByText(/trending|popular|upcoming|discover|recommended/i);
		expect(await sectionContent.count()).toBeGreaterThan(0);
	});

	test("should show content cards or setup prompt", async ({ page }) => {
		// If TMDB API key is not configured, shows a setup prompt.
		// Either content cards or a configuration message should appear.
		const contentCards = page.locator("article, [class*='card'], [class*='poster']");
		const setupPrompt = page.getByText(/tmdb|api key|configure|set up/i);

		const hasCards = (await contentCards.count()) > 0;
		const hasSetup = (await setupPrompt.count()) > 0;

		expect(hasCards || hasSetup).toBe(true);
	});

	test("should not show error alerts", async ({ page }) => {
		const errorAlert = page.locator('[role="alert"]').filter({ hasText: /error|failed/i });
		expect(await errorAlert.count()).toBe(0);
	});
});
