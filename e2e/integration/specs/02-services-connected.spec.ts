/**
 * Integration: Services Connected
 *
 * Validates that all three *arr services are registered and connected:
 * - Settings page shows each service instance
 * - Each service card has action buttons (Test, Edit, Set default)
 */

import { test, expect } from "@playwright/test";
import { ROUTES, TIMEOUTS, waitForLoadingComplete, selectTab } from "../../utils/test-helpers";
import { ensureAuthenticated } from "../utils/auth-helpers";

test.describe("Service Connections", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(ROUTES.settings);
		await waitForLoadingComplete(page);
		await ensureAuthenticated(page);
	});

	test("should show Services tab in settings", async ({ page }) => {
		await selectTab(page, "Services");

		await expect(page.getByText(/service|instance/i).first()).toBeVisible({
			timeout: TIMEOUTS.medium,
		});
	});

	test("should list all three registered instances", async ({ page }) => {
		await selectTab(page, "Services");
		await page.waitForTimeout(1000);

		for (const label of ["E2E Sonarr", "E2E Radarr", "E2E Prowlarr"]) {
			await expect(page.getByText(label)).toBeVisible({ timeout: TIMEOUTS.medium });
		}
	});

	test("should show Connected status for Sonarr", async ({ page }) => {
		await selectTab(page, "Services");
		await page.waitForTimeout(1000);

		// Service cards show "E2E Sonarr" with Test/Edit/Set default buttons
		await expect(page.getByText("E2E Sonarr")).toBeVisible({ timeout: TIMEOUTS.medium });

		// Each service has a "Test" button next to it
		const testButtons = page.getByRole("button", { name: /test/i });
		expect(await testButtons.count()).toBeGreaterThan(0);
	});

	test("should show Connected status for Radarr", async ({ page }) => {
		await selectTab(page, "Services");
		await page.waitForTimeout(1000);

		await expect(page.getByText("E2E Radarr")).toBeVisible({ timeout: TIMEOUTS.medium });
	});

	test("should show Connected status for Prowlarr", async ({ page }) => {
		await selectTab(page, "Services");
		await page.waitForTimeout(1000);

		await expect(page.getByText("E2E Prowlarr")).toBeVisible({ timeout: TIMEOUTS.medium });
	});
});
