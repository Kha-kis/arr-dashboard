/**
 * Integration: Dashboard Overview
 *
 * Validates that the dashboard overview displays real data from connected services:
 * - Stat cards show actual instance counts (not zero)
 * - Configured Instances table lists all registered services
 * - Service type badges appear correctly
 */

import { test, expect } from "@playwright/test";
import { ROUTES, TIMEOUTS, waitForLoadingComplete, SERVICE_TYPES } from "../../utils/test-helpers";
import { ensureAuthenticated } from "../utils/auth-helpers";

test.describe("Dashboard Overview with Real Data", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(ROUTES.dashboard);
		await waitForLoadingComplete(page);
		await ensureAuthenticated(page);
	});

	test("should display welcome message", async ({ page }) => {
		await expect(page.getByText(/welcome back/i)).toBeVisible({
			timeout: TIMEOUTS.long,
		});
	});

	test("should show stat cards for each service type", async ({ page }) => {
		for (const service of SERVICE_TYPES) {
			const statCard = page.getByText(new RegExp(service, "i")).first();
			await expect(statCard).toBeVisible({ timeout: TIMEOUTS.medium });
		}
	});

	test("should show non-zero instance counts", async ({ page }) => {
		// With 3 services registered, at least one stat card should show a count > 0
		// Look for numeric values in stat cards
		const statValues = page.locator('[class*="stat"] h2, [class*="stat"] h3, [data-testid="stat-card"] h2');
		const count = await statValues.count();

		if (count > 0) {
			// At least one should have a non-zero value
			let hasNonZero = false;
			for (let i = 0; i < count; i++) {
				const text = await statValues.nth(i).textContent();
				if (text && Number.parseInt(text, 10) > 0) {
					hasNonZero = true;
					break;
				}
			}
			expect(hasNonZero).toBe(true);
		}
	});

	test("should display Configured Instances section", async ({ page }) => {
		// "Configured Instances" is an h2 in the overview tab
		await expect(
			page.getByRole("heading", { name: /configured instances/i }),
		).toBeVisible({ timeout: TIMEOUTS.long });
	});

	test("should show all three services in instances table", async ({ page }) => {
		// Wait for instances section to render
		await expect(
			page.getByRole("heading", { name: /configured instances/i }),
		).toBeVisible({ timeout: TIMEOUTS.long });

		for (const label of ["E2E Sonarr", "E2E Radarr", "E2E Prowlarr"]) {
			await expect(page.getByText(label)).toBeVisible({ timeout: TIMEOUTS.medium });
		}
	});

	test("should show service type badges in instances table", async ({ page }) => {
		// Wait for instances section
		await expect(
			page.getByRole("heading", { name: /configured instances/i }),
		).toBeVisible({ timeout: TIMEOUTS.long });

		// Service type indicators (sonarr/radarr/prowlarr) should appear
		const serviceTypes = page.getByText(/sonarr|radarr|prowlarr/i);
		expect(await serviceTypes.count()).toBeGreaterThanOrEqual(3);
	});
});
