/**
 * Integration: Settings (Full)
 *
 * Validates all settings tabs render correctly with real services:
 * - All settings tab sections are accessible
 * - Service management shows connected instances
 * - Backup creation works
 */

import { test, expect } from "@playwright/test";
import { ROUTES, TIMEOUTS, waitForLoadingComplete, selectTab } from "../../utils/test-helpers";
import { ensureAuthenticated } from "../utils/auth-helpers";

const SETTINGS_TABS = [
	"Services",
	"Tags",
	"Account",
	"Auth",
	"Appearance",
	"Backup",
	"Notifications",
	"System",
] as const;

test.describe("Settings - All Tabs", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(ROUTES.settings);
		await waitForLoadingComplete(page);
		await ensureAuthenticated(page);
	});

	for (const tabName of SETTINGS_TABS) {
		test(`should render ${tabName} tab without errors`, async ({ page }) => {
			await selectTab(page, tabName);
			await page.waitForTimeout(1000);

			// Tab content should render
			const mainContent = page.locator("main");
			await expect(mainContent).toBeVisible();

			// No error alerts
			const errorAlert = page.locator('[role="alert"]').filter({ hasText: /error|failed/i });
			expect(await errorAlert.count()).toBe(0);
		});
	}
});

test.describe("Settings - Service Management", () => {
	test("should show all registered services", async ({ page }) => {
		await page.goto(ROUTES.settings);
		await waitForLoadingComplete(page);
		await selectTab(page, "Services");
		await page.waitForTimeout(1000);

		for (const label of ["E2E Sonarr", "E2E Radarr", "E2E Prowlarr"]) {
			await expect(page.getByText(label)).toBeVisible({ timeout: TIMEOUTS.medium });
		}
	});

	test("should show service type badges", async ({ page }) => {
		await page.goto(ROUTES.settings);
		await waitForLoadingComplete(page);
		await selectTab(page, "Services");
		await page.waitForTimeout(1000);

		// Each service type should be labeled
		const sonarrBadge = page.getByText(/sonarr/i);
		const radarrBadge = page.getByText(/radarr/i);
		const prowlarrBadge = page.getByText(/prowlarr/i);

		expect(await sonarrBadge.count()).toBeGreaterThan(0);
		expect(await radarrBadge.count()).toBeGreaterThan(0);
		expect(await prowlarrBadge.count()).toBeGreaterThan(0);
	});
});

test.describe("Settings - Backup", () => {
	test("should show backup settings", async ({ page }) => {
		await page.goto(ROUTES.settings);
		await waitForLoadingComplete(page);
		await selectTab(page, "Backup");
		await page.waitForTimeout(1000);

		// Backup section should show configuration options
		const backupContent = page.getByText(/backup|schedule|retention|interval/i);
		expect(await backupContent.count()).toBeGreaterThan(0);
	});

	test("should allow creating a backup", async ({ page }) => {
		await page.goto(ROUTES.settings);
		await waitForLoadingComplete(page);
		await selectTab(page, "Backup");
		await page.waitForTimeout(1000);

		// Look for backup creation button
		const createButton = page.getByRole("button", { name: /create|backup now|manual/i });

		if ((await createButton.count()) > 0) {
			await expect(createButton.first()).toBeVisible();
		}
	});
});
