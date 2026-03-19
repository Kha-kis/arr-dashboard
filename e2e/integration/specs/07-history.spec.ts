/**
 * Integration: History
 *
 * Validates the history page with real services:
 * - Page loads without errors
 * - Main content area renders
 * - History entries may be empty (no downloads yet) but no errors
 */

import { test, expect } from "@playwright/test";
import { ROUTES, TIMEOUTS, waitForLoadingComplete } from "../../utils/test-helpers";
import { ensureAuthenticated } from "../utils/auth-helpers";

test.describe("History with Real Services", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(ROUTES.history);
		await waitForLoadingComplete(page);
		await ensureAuthenticated(page);
	});

	test("should display history page", async ({ page }) => {
		const heading = page.getByRole("heading").first();
		await expect(heading).toBeVisible({ timeout: TIMEOUTS.medium });
	});

	test("should show history page main content", async ({ page }) => {
		// History page should have main content visible
		const mainContent = page.locator("main");
		await expect(mainContent).toBeVisible({ timeout: TIMEOUTS.medium });
	});

	test("should have page heading", async ({ page }) => {
		// History page should have some heading text
		const headings = page.getByRole("heading");
		await expect(headings.first()).toBeVisible({ timeout: TIMEOUTS.medium });
	});

	test("should not show error alerts", async ({ page }) => {
		const errorAlert = page.locator('[role="alert"]').filter({ hasText: /error|failed/i });
		expect(await errorAlert.count()).toBe(0);
	});
});
