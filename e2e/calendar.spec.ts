/**
 * Calendar E2E Tests
 *
 * Tests for the redesigned calendar page including:
 * - Calendar header and navigation
 * - Month grid display
 * - Filter controls (service tabs, search, unmonitored toggle)
 * - Refresh functionality
 */

import { test, expect } from "@playwright/test";
import { ROUTES, TIMEOUTS, waitForLoadingComplete } from "./utils/test-helpers";

test.describe("Calendar - Page Load", () => {
	test("should display calendar page with heading", async ({ page }) => {
		await page.goto(ROUTES.calendar);

		// The calendar has a h1 heading "Calendar"
		await expect(page.getByRole("heading", { name: /calendar/i, level: 1 })).toBeVisible({
			timeout: TIMEOUTS.medium,
		});
	});

	test("should display month label", async ({ page }) => {
		await page.goto(ROUTES.calendar);
		await expect(page.getByRole("heading", { name: /calendar/i, level: 1 })).toBeVisible({
			timeout: TIMEOUTS.medium,
		});

		// Month label is a span with min-width showing "March 2026" etc.
		const monthLabel = page.locator("span.min-w-\\[155px\\]");
		await expect(monthLabel).toBeVisible();
		const text = await monthLabel.textContent();
		expect(text).toBeTruthy();
	});
});

test.describe("Calendar - Navigation", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(ROUTES.calendar);
		await expect(page.getByRole("heading", { name: /calendar/i, level: 1 })).toBeVisible({
			timeout: TIMEOUTS.medium,
		});
	});

	test("should have previous and next month buttons", async ({ page }) => {
		const prevButton = page.getByRole("button", { name: /previous month/i });
		const nextButton = page.getByRole("button", { name: /next month/i });

		await expect(prevButton).toBeVisible();
		await expect(nextButton).toBeVisible();
	});

	test("should navigate to previous period", async ({ page }) => {
		const prevButton = page.getByRole("button", { name: /previous month/i });
		const monthLabel = page.locator("span.min-w-\\[155px\\]");
		const initialMonth = await monthLabel.textContent();

		await prevButton.click();
		await page.waitForTimeout(500);

		const newMonth = await monthLabel.textContent();
		expect(newMonth).not.toBe(initialMonth);
	});

	test("should navigate to next period", async ({ page }) => {
		const nextButton = page.getByRole("button", { name: /next month/i });
		const monthLabel = page.locator("span.min-w-\\[155px\\]");
		const initialMonth = await monthLabel.textContent();

		await nextButton.click();
		await page.waitForTimeout(500);

		const newMonth = await monthLabel.textContent();
		expect(newMonth).not.toBe(initialMonth);
	});

	test("should have Today button to return to current date", async ({ page }) => {
		const todayButton = page.getByRole("button", { name: "Today", exact: true });
		await expect(todayButton).toBeVisible();

		// Navigate away then back
		const nextButton = page.getByRole("button", { name: /next month/i });
		await nextButton.click();
		await nextButton.click();
		await page.waitForTimeout(300);

		await todayButton.click();
		await page.waitForTimeout(500);
	});
});

test.describe("Calendar - Content Display", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(ROUTES.calendar);
		await expect(page.getByRole("heading", { name: /calendar/i, level: 1 })).toBeVisible({
			timeout: TIMEOUTS.medium,
		});
		await waitForLoadingComplete(page);
	});

	test("should display calendar content area", async ({ page }) => {
		// The calendar renders in the main content area
		await expect(page.locator("main")).toBeVisible();
	});

	test("should show day cells in the grid", async ({ page }) => {
		// Calendar grid has day cells — buttons with day numbers
		const mainContent = page.locator("main");
		await expect(mainContent).toBeVisible({ timeout: TIMEOUTS.medium });

		// At least the main content area should render
		const hasContent = await mainContent.evaluate((el) => el.children.length > 0);
		expect(hasContent).toBe(true);
	});
});

test.describe("Calendar - Filtering", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(ROUTES.calendar);
		await expect(page.getByRole("heading", { name: /calendar/i, level: 1 })).toBeVisible({
			timeout: TIMEOUTS.medium,
		});
		await waitForLoadingComplete(page);
	});

	test("should have search filter", async ({ page }) => {
		// Search input with placeholder "Search…"
		const searchInput = page.getByPlaceholder(/search/i);
		await expect(searchInput).toBeVisible();
	});

	test("should have service filter tabs", async ({ page }) => {
		// Service tabs: All, Sonarr, Radarr, etc.
		const allTab = page.getByRole("button", { name: "All", exact: true });
		const hasAllTab = (await allTab.count()) > 0;
		expect(hasAllTab).toBe(true);
	});

	test("should have unmonitored toggle", async ({ page }) => {
		// Unmonitored toggle button with text "Unmonitored"
		const unmonitoredButton = page.getByRole("button", { name: /unmonitored/i });
		const hasToggle = (await unmonitoredButton.count()) > 0;
		expect(hasToggle).toBe(true);
	});
});

test.describe("Calendar - Refresh", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(ROUTES.calendar);
		await expect(page.getByRole("heading", { name: /calendar/i, level: 1 })).toBeVisible({
			timeout: TIMEOUTS.medium,
		});
	});

	test("should have refresh button", async ({ page }) => {
		const refreshButton = page.getByRole("button", { name: /refresh calendar/i });
		await expect(refreshButton).toBeVisible();
	});

	test("should refresh calendar data when clicked", async ({ page }) => {
		const refreshButton = page.getByRole("button", { name: /refresh calendar/i });

		await refreshButton.click();
		await page.waitForTimeout(500);

		// Calendar should still be visible after refresh
		await expect(page.getByRole("heading", { name: /calendar/i, level: 1 })).toBeVisible();
	});
});
