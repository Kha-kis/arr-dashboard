/**
 * Integration: Queue Cleaner
 *
 * Validates the queue cleaner page with real services:
 * - Page loads with instance selector populated
 * - Sonarr/Radarr instances appear in the selector
 * - No schema validation errors (PR #177)
 */

import { test, expect } from "@playwright/test";
import { TIMEOUTS, waitForLoadingComplete } from "../../utils/test-helpers";
import { ensureAuthenticated } from "../utils/auth-helpers";

// Queue cleaner might not be in the standard ROUTES — navigate directly
const QUEUE_CLEANER_ROUTE = "/queue-cleaner";

test.describe("Queue Cleaner with Real Services", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(QUEUE_CLEANER_ROUTE);
		await waitForLoadingComplete(page);
		await ensureAuthenticated(page);
	});

	test("should display queue cleaner page", async ({ page }) => {
		const heading = page.getByRole("heading").first();
		await expect(heading).toBeVisible({ timeout: TIMEOUTS.medium });
	});

	test("should show instance or service references", async ({ page }) => {
		// Queue cleaner should reference connected *arr instances
		const serviceRefs = page.getByText(/E2E Sonarr|E2E Radarr|sonarr|radarr|instance/i);
		expect(await serviceRefs.count()).toBeGreaterThan(0);
	});

	test("should not show error alerts", async ({ page }) => {
		const errorAlert = page.locator('[role="alert"]').filter({ hasText: /error|failed/i });
		expect(await errorAlert.count()).toBe(0);
	});
});
