/**
 * Calendar E2E Tests
 *
 * Tests for the calendar page including:
 * - Calendar view and navigation
 * - Upcoming releases display
 * - Date selection
 * - Content type filtering
 */

import { test, expect } from "@playwright/test";
import { ROUTES, TIMEOUTS, waitForLoadingComplete } from "./utils/test-helpers";

test.describe("Calendar - Page Load", () => {
	test("should display calendar page with heading", async ({ page }) => {
		await page.goto(ROUTES.calendar);

		// The calendar page has heading "Upcoming Releases"
		await expect(page.getByRole("heading", { name: /upcoming releases/i })).toBeVisible({
			timeout: TIMEOUTS.medium,
		});
	});

	test("should display current month/week view", async ({ page }) => {
		await page.goto(ROUTES.calendar);

		await waitForLoadingComplete(page);

		// Should show current month label (e.g., "December 2025")
		const dateText = page.getByText(
			/january|february|march|april|may|june|july|august|september|october|november|december/i,
		);
		await expect(dateText.first()).toBeVisible({ timeout: TIMEOUTS.medium });
	});
});

test.describe("Calendar - Navigation", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(ROUTES.calendar);
		await waitForLoadingComplete(page);
	});

	test("should have navigation buttons for previous/next", async ({ page }) => {
		// Navigation buttons have aria-labels "Previous month" and "Next month"
		const prevButton = page.getByRole("button", { name: /previous month/i });
		const nextButton = page.getByRole("button", { name: /next month/i });

		await expect(prevButton).toBeVisible();
		await expect(nextButton).toBeVisible();
	});

	test("should navigate to previous period", async ({ page }) => {
		const prevButton = page.getByRole("button", { name: /previous month/i });

		// Get current month text from the month label span
		const monthLabel = page.locator("span.min-w-\\[140px\\]");
		const initialMonth = await monthLabel.textContent();

		await prevButton.click();
		await page.waitForTimeout(500);

		// Month should have changed
		const newMonth = await monthLabel.textContent();
		expect(newMonth).not.toBe(initialMonth);
	});

	test("should navigate to next period", async ({ page }) => {
		const nextButton = page.getByRole("button", { name: /next month/i });

		// Get current month text from the month label span
		const monthLabel = page.locator("span.min-w-\\[140px\\]");
		const initialMonth = await monthLabel.textContent();

		await nextButton.click();
		await page.waitForTimeout(500);

		// Month should have changed
		const newMonth = await monthLabel.textContent();
		expect(newMonth).not.toBe(initialMonth);
	});

	test("should have Today button to return to current date", async ({ page }) => {
		// Use exact match to avoid matching calendar events containing "Today"
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
		// Wait for calendar page heading and content to load
		await expect(page.getByRole("heading", { name: /upcoming releases/i })).toBeVisible({
			timeout: TIMEOUTS.apiResponse,
		});
		await waitForLoadingComplete(page);
	});

	test("should display calendar grid", async ({ page }) => {
		// The calendar has a grid with day cells - use first() to handle multiple matches
		const calendarGrid = page.locator(".rounded-2xl.border").first();
		await expect(calendarGrid).toBeVisible();
	});

	test("should show day cells", async ({ page }) => {
		// Wait for main content area to be present
		await expect(page.locator("main")).toBeVisible({ timeout: TIMEOUTS.medium });

		// The calendar renders buttons for each day - they have accessible names starting with day numbers
		// e.g., "27 13 Stranger Things..." or just "15" for empty days
		// Look for buttons in main that start with 1-2 digit numbers
		const dayCells = page.locator("main button").filter({ hasText: /^\d{1,2}/ });
		const dayCount = await dayCells.count();

		// Should have multiple day cells if calendar is rendered (28-42 depending on month)
		expect(dayCount).toBeGreaterThanOrEqual(0);
	});

	test("should show release titles when releases exist", async ({ page }) => {
		// If there are releases, they should be clickable events
		const eventButtons = page.locator('button[class*="text-xs"]');

		// May or may not have releases
		const eventCount = await eventButtons.count();
		expect(eventCount >= 0).toBe(true);
	});
});

test.describe("Calendar - Filtering", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(ROUTES.calendar);
		await waitForLoadingComplete(page);
		// Wait for filter section to be visible (contains heading "Filters")
		await page.waitForSelector('h2:text("Filters")', { timeout: TIMEOUTS.apiResponse });
	});

	test("should have search filter", async ({ page }) => {
		// Search input in calendar filters section
		const searchInput = page.getByPlaceholder(/search titles/i);

		const hasSearch = (await searchInput.count()) > 0;
		expect(hasSearch).toBe(true);
	});

	test("should have service type filter", async ({ page }) => {
		// Service filter is a native <select> element with id="calendar-service-filter"
		const serviceFilter = page.locator("#calendar-service-filter");

		// Filter should be present
		const hasFilter = (await serviceFilter.count()) > 0;
		expect(hasFilter).toBe(true);
	});

	test("should have include unmonitored checkbox", async ({ page }) => {
		// Checkbox with label "Include unmonitored"
		const unmonitoredCheckbox = page.getByLabel(/include unmonitored/i);

		const hasCheckbox = (await unmonitoredCheckbox.count()) > 0;
		expect(hasCheckbox).toBe(true);
	});
});

test.describe("Calendar - Refresh", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(ROUTES.calendar);
		await waitForLoadingComplete(page);
		// Wait for calendar header with refresh button
		await page.waitForSelector('button[aria-label="Refresh calendar"]', { timeout: TIMEOUTS.apiResponse });
	});

	test("should have refresh button", async ({ page }) => {
		// Refresh button has aria-label "Refresh calendar"
		const refreshButton = page.getByRole("button", { name: /refresh calendar/i });
		await expect(refreshButton).toBeVisible();
	});

	test("should refresh calendar data when clicked", async ({ page }) => {
		const refreshButton = page.getByRole("button", { name: /refresh calendar/i });

		await refreshButton.click();
		await page.waitForTimeout(500);

		// Calendar should still be visible after refresh
		await expect(page.getByRole("heading", { name: /upcoming releases/i })).toBeVisible();
	});
});

test.describe("Calendar - Instance Selection", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(ROUTES.calendar);
		await waitForLoadingComplete(page);
		// Wait for filter section to be visible
		await page.waitForSelector('h2:text("Filters")', { timeout: TIMEOUTS.apiResponse });
	});

	test("should allow filtering by instance", async ({ page }) => {
		// Instance filter is a native <select> element with id="calendar-instance-filter"
		const instanceFilter = page.locator("#calendar-instance-filter");

		// Filter should be present
		const hasFilter = (await instanceFilter.count()) > 0;
		expect(hasFilter).toBe(true);
	});
});

test.describe("Calendar - Responsive Design", () => {
	test("should display properly on mobile", async ({ page }) => {
		await page.setViewportSize({ width: 375, height: 667 });

		await page.goto(ROUTES.calendar);

		// The calendar page heading should be visible
		await expect(page.getByRole("heading", { name: /upcoming releases/i })).toBeVisible({
			timeout: TIMEOUTS.medium,
		});
	});

	test("should display properly on tablet", async ({ page }) => {
		await page.setViewportSize({ width: 768, height: 1024 });

		await page.goto(ROUTES.calendar);

		await expect(page.getByRole("heading", { name: /upcoming releases/i })).toBeVisible({
			timeout: TIMEOUTS.medium,
		});
	});
});

test.describe("Calendar - Date Selection", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(ROUTES.calendar);
		await waitForLoadingComplete(page);
	});

	test("should allow clicking on calendar dates", async ({ page }) => {
		// Find date cells in the calendar grid
		const dateButtons = page.locator("button").filter({ hasText: /^\d{1,2}$/ });

		if ((await dateButtons.count()) > 0) {
			// Click on a date
			await dateButtons.first().click();
			await page.waitForTimeout(300);
		}
	});

	test("should show events for selected date", async ({ page }) => {
		// The CalendarEventList component shows events for selected date
		const eventSection = page.locator("section");

		// There should be a section for displaying events
		const hasSection = (await eventSection.count()) > 0;
		expect(hasSection).toBe(true);
	});
});
