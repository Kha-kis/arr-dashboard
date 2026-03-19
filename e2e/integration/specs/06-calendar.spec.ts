/**
 * Integration: Calendar
 *
 * Validates the calendar page with real services connected:
 * - Calendar renders without errors
 * - Page has main content visible
 * - No error states
 */

import { test, expect } from "@playwright/test";
import { ROUTES, TIMEOUTS, waitForLoadingComplete } from "../../utils/test-helpers";
import { ensureAuthenticated } from "../utils/auth-helpers";

test.describe("Calendar with Real Services", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(ROUTES.calendar);
		await waitForLoadingComplete(page);
		await ensureAuthenticated(page);
	});

	test("should display calendar page", async ({ page }) => {
		const heading = page.getByRole("heading").first();
		await expect(heading).toBeVisible({ timeout: TIMEOUTS.medium });
	});

	test("should show calendar content area", async ({ page }) => {
		const mainContent = page.locator("main");
		await expect(mainContent).toBeVisible({ timeout: TIMEOUTS.medium });
	});

	test("should render without errors", async ({ page }) => {
		// Calendar should not show error states
		const errorAlert = page.locator('[role="alert"]').filter({ hasText: /error|failed/i });
		expect(await errorAlert.count()).toBe(0);
	});
});
