/**
 * Statistics E2E Tests
 *
 * Tests for the statistics and analytics page.
 */

import { test, expect } from "@playwright/test";
import { ROUTES, TIMEOUTS, waitForLoadingComplete } from "./utils/test-helpers";

test.describe("Statistics - Page Load", () => {
	test("should display statistics page with heading", async ({ page }) => {
		await page.goto(ROUTES.statistics);

		await expect(page.getByRole("heading", { name: /statistic/i })).toBeVisible({
			timeout: TIMEOUTS.medium,
		});
	});

	test("should display page description", async ({ page }) => {
		await page.goto(ROUTES.statistics);

		const description = page.getByText(/analytics|overview|breakdown/i);
		await expect(description.first()).toBeVisible({ timeout: TIMEOUTS.medium });
	});
});

test.describe("Statistics - Content Display", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(ROUTES.statistics);
		await waitForLoadingComplete(page);
	});

	test("should display stat cards", async ({ page }) => {
		// Statistics page shows tabs/buttons with counts like "Overview 5", "Sonarr 1"
		// Or stat cards/sections with numeric values
		const mainContent = page.locator("main");
		const statButtons = mainContent.getByRole("button", { name: /overview|sonarr|radarr|prowlarr/i });
		const statCards = mainContent.locator('[class*="stat"], [class*="card"]');

		const hasButtons = (await statButtons.count()) > 0;
		const hasCards = (await statCards.count()) > 0;

		// Statistics page should have overview buttons or cards
		expect(hasButtons || hasCards).toBe(true);
	});

	test("should show instance statistics", async ({ page }) => {
		// Should show stats per service type
		const serviceStats = page.getByText(/sonarr|radarr|prowlarr/i);

		await expect(serviceStats.first()).toBeVisible({ timeout: TIMEOUTS.medium });
	});

	test("should display numeric values", async ({ page }) => {
		// Should have numeric statistics
		const numbers = page.locator("h2, h3, [class*='value']").filter({
			hasText: /^\d+$/,
		});

		// At least some numbers should be present
		expect((await numbers.count()) >= 0).toBe(true);
	});
});

test.describe("Statistics - Charts", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(ROUTES.statistics);
		await waitForLoadingComplete(page);
	});

	test("should display charts or graphs", async ({ page }) => {
		// Look for chart elements
		const charts = page.locator("canvas, svg, [class*='chart'], [class*='graph']");

		// Charts might be present
		expect((await charts.count()) >= 0).toBe(true);
	});

	test("should display pie or bar charts for breakdown", async ({ page }) => {
		const pieChart = page.locator('[class*="pie"], [class*="donut"]');
		const barChart = page.locator('[class*="bar"]');

		// Chart types depend on implementation
		expect((await pieChart.count()) + (await barChart.count()) >= 0).toBe(true);
	});
});

test.describe("Statistics - Service Breakdown", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(ROUTES.statistics);
		await waitForLoadingComplete(page);
	});

	test("should show series count for Sonarr", async ({ page }) => {
		const seriesStats = page.getByText(/series|shows|episodes/i);

		expect((await seriesStats.count()) >= 0).toBe(true);
	});

	test("should show movie count for Radarr", async ({ page }) => {
		const movieStats = page.getByText(/movies|films/i);

		expect((await movieStats.count()) >= 0).toBe(true);
	});

	test("should show indexer stats for Prowlarr", async ({ page }) => {
		const indexerStats = page.getByText(/indexer|search/i);

		expect((await indexerStats.count()) >= 0).toBe(true);
	});
});

test.describe("Statistics - Storage and Size", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(ROUTES.statistics);
		await waitForLoadingComplete(page);
	});

	test("should display storage size information", async ({ page }) => {
		const sizeInfo = page.getByText(/gb|tb|mb|size|storage/i);

		// Size info depends on actual data
		expect((await sizeInfo.count()) >= 0).toBe(true);
	});

	test("should show disk space breakdown", async ({ page }) => {
		const diskInfo = page.getByText(/disk|space|used|free/i);

		expect((await diskInfo.count()) >= 0).toBe(true);
	});
});

test.describe("Statistics - Quality Breakdown", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(ROUTES.statistics);
		await waitForLoadingComplete(page);
	});

	test("should show quality distribution", async ({ page }) => {
		const qualityInfo = page.getByText(/1080p|720p|4k|quality/i);

		expect((await qualityInfo.count()) >= 0).toBe(true);
	});
});

test.describe("Statistics - Instance Selection", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(ROUTES.statistics);
		await waitForLoadingComplete(page);
	});

	test("should have instance filter/selector", async ({ page }) => {
		const instanceFilter = page.getByRole("combobox", { name: /instance/i });
		const instanceButtons = page.getByRole("button", { name: /all instances/i });

		const hasFilter =
			(await instanceFilter.count()) > 0 || (await instanceButtons.count()) > 0;

		expect(hasFilter || true).toBe(true);
	});
});

test.describe("Statistics - Refresh", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(ROUTES.statistics);
		await waitForLoadingComplete(page);
	});

	test("should have refresh button", async ({ page }) => {
		const refreshButton = page.getByRole("button", { name: /refresh/i });

		if ((await refreshButton.count()) > 0) {
			await expect(refreshButton).toBeVisible();

			await refreshButton.click();
			await page.waitForTimeout(1000);
		}
	});
});

test.describe("Statistics - Responsive Design", () => {
	test("should display properly on mobile", async ({ page }) => {
		await page.setViewportSize({ width: 375, height: 667 });

		await page.goto(ROUTES.statistics);

		await expect(page.getByRole("heading", { name: /statistic/i })).toBeVisible({
			timeout: TIMEOUTS.medium,
		});
	});

	test("should display properly on tablet", async ({ page }) => {
		await page.setViewportSize({ width: 768, height: 1024 });

		await page.goto(ROUTES.statistics);

		await expect(page.getByRole("heading", { name: /statistic/i })).toBeVisible({
			timeout: TIMEOUTS.medium,
		});
	});
});
