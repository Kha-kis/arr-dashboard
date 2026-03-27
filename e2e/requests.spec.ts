/**
 * Requests E2E Tests
 *
 * Tests for request lifecycle visibility:
 * - Page load and structure
 * - Tab navigation
 * - Status timeline rendering on request cards
 * - Expanded timeline in detail modal
 * - Requester profile popover
 * - Deep-linking via ?user=<id>
 *
 * These tests handle both "Seerr configured" and "not configured" states,
 * since the CI environment may not have a Seerr instance.
 */

import { test, expect } from "@playwright/test";
import { ROUTES, TIMEOUTS, waitForLoadingComplete, selectTab } from "./utils/test-helpers";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Checks whether a Seerr instance is configured (requests page shows content)
 * vs showing the "No Seerr Instances" empty state.
 */
async function hasSeerrInstance(page: import("@playwright/test").Page): Promise<boolean> {
	const tabs = page.getByRole("tab", { name: /approval|all requests/i }).first();
	return tabs.isVisible({ timeout: TIMEOUTS.medium }).catch(() => false);
}

/**
 * Waits for request cards to appear, or returns false if none load.
 */
async function waitForRequestCards(page: import("@playwright/test").Page): Promise<boolean> {
	// Request cards contain requester names and status badges
	const cards = page.locator("[role='button']").filter({ hasText: /movie|tv/i });
	return cards.first().isVisible({ timeout: TIMEOUTS.apiResponse }).catch(() => false);
}

// ============================================================================
// Page Load
// ============================================================================

test.describe("Requests - Page Load", () => {
	test("should display requests page with heading", async ({ page }) => {
		await page.goto(ROUTES.requests);

		await expect(
			page.getByRole("heading", { name: /requests/i }).first(),
		).toBeVisible({ timeout: TIMEOUTS.medium });
	});

	test("should show tabs or empty state", async ({ page }) => {
		await page.goto(ROUTES.requests);
		await waitForLoadingComplete(page);

		const hasSeerr = await hasSeerrInstance(page);

		if (hasSeerr) {
			// Should show tab bar with Approval Queue, All Requests, Users, etc.
			await expect(page.getByText(/approval queue/i).first()).toBeVisible();
			await expect(page.getByText(/all requests/i).first()).toBeVisible();
		} else {
			// Should show empty state directing user to settings
			await expect(page.getByText(/no seerr instances/i)).toBeVisible();
		}
	});
});

// ============================================================================
// Tab Navigation
// ============================================================================

test.describe("Requests - Tab Navigation", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(ROUTES.requests);
		await waitForLoadingComplete(page);
	});

	test("should switch between tabs when Seerr is configured", async ({ page }) => {
		const hasSeerr = await hasSeerrInstance(page);
		test.skip(!hasSeerr, "No Seerr instance configured");

		// Switch to All Requests tab
		await selectTab(page, "All Requests");
		// Should see filter controls (status, type, user dropdowns)
		await expect(page.getByText(/all statuses|all types|all users/i).first()).toBeVisible({
			timeout: TIMEOUTS.medium,
		});

		// Switch to Users tab
		await selectTab(page, "Users");
		await page.waitForLoadState("networkidle");
	});
});

// ============================================================================
// Status Timeline (on request cards)
// ============================================================================

test.describe("Requests - Status Timeline", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(ROUTES.requests);
		await waitForLoadingComplete(page);
	});

	test("should show compact timeline stages on request cards", async ({ page }) => {
		const hasSeerr = await hasSeerrInstance(page);
		test.skip(!hasSeerr, "No Seerr instance configured");

		const hasCards = await waitForRequestCards(page);
		test.skip(!hasCards, "No request cards to test");

		// Compact timeline renders stage labels (Requested, Approved, Processing, etc.)
		// These appear as title attributes on the stage elements
		const timelineStages = page.locator("[title*='Requested'], [title*='Pending'], [title*='Approved']");
		const stageCount = await timelineStages.count();
		expect(stageCount).toBeGreaterThan(0);
	});

	test("should show expanded timeline in detail modal", async ({ page }) => {
		const hasSeerr = await hasSeerrInstance(page);
		test.skip(!hasSeerr, "No Seerr instance configured");

		const hasCards = await waitForRequestCards(page);
		test.skip(!hasCards, "No request cards to test");

		// Click the first request card to open detail modal
		const firstCard = page.locator("[role='button']").filter({ hasText: /movie|tv/i }).first();
		await firstCard.click();

		// Wait for modal to appear
		const modal = page.locator('[role="dialog"]');
		await expect(modal).toBeVisible({ timeout: TIMEOUTS.medium });

		// Expanded timeline should show visible stage labels
		await expect(modal.getByText("Requested")).toBeVisible();

		// Should also show one of the next stages
		const hasApproved = await modal.getByText("Approved").isVisible().catch(() => false);
		const hasPending = await modal.getByText("Pending").isVisible().catch(() => false);
		const hasDeclined = await modal.getByText("Declined").isVisible().catch(() => false);
		const hasFailed = await modal.getByText("Failed").isVisible().catch(() => false);
		expect(hasApproved || hasPending || hasDeclined || hasFailed).toBe(true);

		// Close modal
		await page.keyboard.press("Escape");
	});
});

// ============================================================================
// Requester Profile Popover
// ============================================================================

test.describe("Requests - Requester Profile Popover", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(ROUTES.requests);
		await waitForLoadingComplete(page);
	});

	test("should open popover when clicking requester name on card", async ({ page }) => {
		const hasSeerr = await hasSeerrInstance(page);
		test.skip(!hasSeerr, "No Seerr instance configured");

		const hasCards = await waitForRequestCards(page);
		test.skip(!hasCards, "No request cards to test");

		// Requester names are rendered as <button> elements inside the card
		// They contain a User icon and the display name text
		const requesterButton = page
			.locator("[role='button']")
			.filter({ hasText: /movie|tv/i })
			.first()
			.locator("button")
			.first();

		const requesterExists = await requesterButton.isVisible().catch(() => false);
		test.skip(!requesterExists, "No clickable requester name found");

		await requesterButton.click();

		// Popover should appear with "View all requests" link
		await expect(page.getByText("View all requests")).toBeVisible({
			timeout: TIMEOUTS.medium,
		});

		// Should show request count
		await expect(page.getByText(/\d+ requests?/)).toBeVisible();
	});

	test("should open popover in detail modal requester section", async ({ page }) => {
		const hasSeerr = await hasSeerrInstance(page);
		test.skip(!hasSeerr, "No Seerr instance configured");

		const hasCards = await waitForRequestCards(page);
		test.skip(!hasCards, "No request cards to test");

		// Open detail modal
		const firstCard = page.locator("[role='button']").filter({ hasText: /movie|tv/i }).first();
		await firstCard.click();

		const modal = page.locator('[role="dialog"]');
		await expect(modal).toBeVisible({ timeout: TIMEOUTS.medium });

		// Click the requester name button inside the modal
		const modalRequester = modal.locator("button").filter({ hasText: /.+/ }).first();
		const exists = await modalRequester.isVisible().catch(() => false);
		test.skip(!exists, "No clickable requester in modal");

		await modalRequester.click();

		// Popover should appear
		await expect(page.getByText("View all requests")).toBeVisible({
			timeout: TIMEOUTS.medium,
		});

		await page.keyboard.press("Escape");
		await page.keyboard.press("Escape");
	});
});

// ============================================================================
// Deep-linking (?user=<id>)
// ============================================================================

test.describe("Requests - Deep Linking", () => {
	test("should switch to All Requests tab when ?user= param is present", async ({ page }) => {
		const hasSeerr = await hasSeerrInstance(page);

		// Navigate with a user filter param
		await page.goto(`${ROUTES.requests}?user=1`);
		await waitForLoadingComplete(page);

		if (hasSeerr) {
			// Should automatically switch to "All Requests" tab
			// The filter controls should be visible (not the Approval Queue)
			await expect(page.getByText(/all statuses|total requests/i).first()).toBeVisible({
				timeout: TIMEOUTS.medium,
			});
		}
	});

	test("should reset filter when navigating to /requests without param", async ({ page }) => {
		const hasSeerr = await hasSeerrInstance(page);
		test.skip(!hasSeerr, "No Seerr instance configured");

		// First navigate with user filter
		await page.goto(`${ROUTES.requests}?user=1`);
		await waitForLoadingComplete(page);

		// Then navigate without it
		await page.goto(ROUTES.requests);
		await waitForLoadingComplete(page);

		// Should be back on the default Approval Queue tab
		await expect(page.getByText(/approval queue/i).first()).toBeVisible({
			timeout: TIMEOUTS.medium,
		});
	});

	test("should ignore invalid ?user= values gracefully", async ({ page }) => {
		// Navigate with an invalid user ID
		await page.goto(`${ROUTES.requests}?user=abc`);
		await waitForLoadingComplete(page);

		// Page should still load without errors
		await expect(
			page.getByRole("heading", { name: /requests/i }).first(),
		).toBeVisible({ timeout: TIMEOUTS.medium });
	});
});

// ============================================================================
// Filter Controls (All Requests tab)
// ============================================================================

test.describe("Requests - Filter Controls", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(ROUTES.requests);
		await waitForLoadingComplete(page);
	});

	test("should show filter dropdowns on All Requests tab", async ({ page }) => {
		const hasSeerr = await hasSeerrInstance(page);
		test.skip(!hasSeerr, "No Seerr instance configured");

		await selectTab(page, "All Requests");

		// Should see sort, type, status, and user filter selects
		await expect(page.getByText(/newest|last updated/i).first()).toBeVisible({
			timeout: TIMEOUTS.medium,
		});
	});

	test("should show user filter dropdown that is editable after deep-link", async ({ page }) => {
		const hasSeerr = await hasSeerrInstance(page);
		test.skip(!hasSeerr, "No Seerr instance configured");

		// Navigate with deep-link
		await page.goto(`${ROUTES.requests}?user=1`);
		await waitForLoadingComplete(page);

		// The All Requests tab should be active and filter controls visible
		// User should be able to change the filter (it's not locked)
		const filterSelects = page.locator("select");
		const selectCount = await filterSelects.count();
		expect(selectCount).toBeGreaterThan(0);
	});
});
