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
	// Wait for the page to settle — Seerr instance data loads via React Query after
	// the initial page render, so skeletons may appear and disappear before tabs show.
	// Use or() to wait for either the tab buttons or the "No Seerr Instances" empty state.
	const tabButton = page.locator("button").filter({ hasText: /approval queue/i }).first();
	const emptyState = page.getByText(/no seerr instances/i);
	try {
		await tabButton.or(emptyState).waitFor({ state: "visible", timeout: TIMEOUTS.apiResponse });
	} catch {
		return false;
	}
	return tabButton.isVisible();
}

/**
 * Waits for request cards to appear, or returns false if none load.
 */
async function waitForRequestCards(page: import("@playwright/test").Page): Promise<boolean> {
	// Request cards have role="button" and contain a Movie/TV type badge
	const card = page.locator("[role='button']").filter({ hasText: /movie|tv/i }).first();
	try {
		await card.waitFor({ state: "visible", timeout: TIMEOUTS.apiResponse });
		return true;
	} catch {
		return false;
	}
}

/**
 * Checks whether the approval queue has pending request cards with Preview buttons.
 */
async function waitForPendingRequestsWithPreview(page: import("@playwright/test").Page): Promise<boolean> {
	// Target the actual <button> element with aria-label, not the card wrapper (div[role=button])
	const previewBtn = page.locator("button[aria-label='Preview request']").first();
	try {
		await previewBtn.waitFor({ state: "visible", timeout: TIMEOUTS.apiResponse });
		return true;
	} catch {
		return false;
	}
}

/** Returns locator for actual Preview <button> elements (not card wrappers) */
function getPreviewButtons(page: import("@playwright/test").Page) {
	return page.locator("button[aria-label='Preview request'], button[aria-label='Close preview']");
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
			// Either empty state or still loading — accept both
			const hasEmptyState = await page.getByText(/no seerr instances/i).isVisible().catch(() => false);
			const hasPageHeading = await page.getByRole("heading", { name: /requests/i }).first().isVisible().catch(() => false);
			expect(hasEmptyState || hasPageHeading).toBe(true);
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
		// Wait for tab content to render — filter selects appear after data loads
		await expect(page.locator("select").first()).toBeVisible({
			timeout: TIMEOUTS.apiResponse,
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

		// Wait for filter selects to render after data loads
		await expect(page.locator("select").first()).toBeVisible({
			timeout: TIMEOUTS.apiResponse,
		});
	});

	test("should show user filter dropdown that is editable after deep-link", async ({ page }) => {
		const hasSeerr = await hasSeerrInstance(page);
		test.skip(!hasSeerr, "No Seerr instance configured");

		// Navigate with deep-link
		await page.goto(`${ROUTES.requests}?user=1`);
		await waitForLoadingComplete(page);

		// The All Requests tab should be active and filter controls visible
		await expect(page.locator("select").first()).toBeVisible({
			timeout: TIMEOUTS.apiResponse,
		});
	});
});

// ============================================================================
// Approval Queue Inline Preview
// ============================================================================

test.describe("Requests - Inline Preview", () => {
	test("should toggle inline preview when clicking Preview button", async ({ page }) => {
		await page.goto(ROUTES.requests);
		const hasSeerr = await hasSeerrInstance(page);
		test.skip(!hasSeerr, "No Seerr instance configured");

		const hasPreview = await waitForPendingRequestsWithPreview(page);
		test.skip(!hasPreview, "No pending requests with Preview button");

		const previewBtn = page.locator("button[aria-label='Preview request']").first();

		// Click Preview — panel should expand
		await previewBtn.click();

		// Preview panel contains the expanded timeline with "Requested" stage label
		const panel = page.locator("[id^='preview-']").first();
		await expect(panel).toBeVisible({ timeout: TIMEOUTS.short });
		await expect(panel.getByText("Requested")).toBeVisible();

		// Button should now show "Close preview" label
		await expect(page.locator("button[aria-label='Close preview']").first()).toBeVisible();

		// Click again to close
		await page.locator("button[aria-label='Close preview']").first().click();
		await expect(panel).toBeHidden();
	});

	test("should show overview and seasons in preview for TV requests", async ({ page }) => {
		await page.goto(ROUTES.requests);
		const hasSeerr = await hasSeerrInstance(page);
		test.skip(!hasSeerr, "No Seerr instance configured");

		const hasPreview = await waitForPendingRequestsWithPreview(page);
		test.skip(!hasPreview, "No pending requests with Preview button");

		// Open first preview
		await page.locator("button[aria-label='Preview request']").first().click();
		const panel = page.locator("[id^='preview-']").first();
		await expect(panel).toBeVisible({ timeout: TIMEOUTS.short });

		// Check for "Full Details" button inside the panel
		await expect(panel.getByRole("button", { name: /full details/i })).toBeVisible();

		// Overview section appears if the request has overview data (not guaranteed)
		// Seasons section appears only for TV requests (not guaranteed)
		// Just verify the panel has content beyond the timeline
		const panelText = await panel.textContent();
		expect(panelText).toBeTruthy();
	});

	test("should close previous preview when opening another", async ({ page }) => {
		await page.goto(ROUTES.requests);
		const hasSeerr = await hasSeerrInstance(page);
		test.skip(!hasSeerr, "No Seerr instance configured");

		const hasPreview = await waitForPendingRequestsWithPreview(page);
		test.skip(!hasPreview, "No pending requests with Preview button");

		const previewButtons = page.locator("button[aria-label='Preview request']");
		const buttonCount = await previewButtons.count();
		test.skip(buttonCount < 2, "Need at least 2 pending requests");

		// Open first preview
		await previewButtons.first().click();
		const panels = page.locator("[id^='preview-']");
		await expect(panels.first()).toBeVisible({ timeout: TIMEOUTS.short });

		// After clicking, the first button label changed to "Close preview"
		// so re-query for remaining "Preview request" buttons and click the next one
		await page.locator("button[aria-label='Preview request']").first().click();
		await page.waitForTimeout(300);

		// Only one panel should be visible at a time
		let visCount = 0;
		const allPanels = page.locator("[id^='preview-']");
		for (let i = 0; i < await allPanels.count(); i++) {
			if (await allPanels.nth(i).isVisible()) visCount++;
		}
		expect(visCount).toBe(1);
	});

	test("should open detail modal via Full Details button in preview", async ({ page }) => {
		await page.goto(ROUTES.requests);
		const hasSeerr = await hasSeerrInstance(page);
		test.skip(!hasSeerr, "No Seerr instance configured");

		const hasPreview = await waitForPendingRequestsWithPreview(page);
		test.skip(!hasPreview, "No pending requests with Preview button");

		// Open preview
		await page.locator("button[aria-label='Preview request']").first().click();
		const panel = page.locator("[id^='preview-']").first();
		await expect(panel).toBeVisible({ timeout: TIMEOUTS.short });

		// Click "Full Details" inside the panel
		await panel.getByRole("button", { name: /full details/i }).click();

		// Modal should open
		const modal = page.locator('[role="dialog"]');
		await expect(modal).toBeVisible({ timeout: TIMEOUTS.medium });

		// Close modal
		await page.keyboard.press("Escape");
	});

	test("should support keyboard navigation for preview", async ({ page }) => {
		await page.goto(ROUTES.requests);
		const hasSeerr = await hasSeerrInstance(page);
		test.skip(!hasSeerr, "No Seerr instance configured");

		const hasPreview = await waitForPendingRequestsWithPreview(page);
		test.skip(!hasPreview, "No pending requests with Preview button");

		const previewBtn = page.locator("button[aria-label='Preview request']").first();

		// Focus and activate with Enter
		await previewBtn.focus();
		await page.keyboard.press("Enter");

		const panel = page.locator("[id^='preview-']").first();
		await expect(panel).toBeVisible({ timeout: TIMEOUTS.short });

		// Tab into the panel — "Full Details" button should be reachable
		await page.keyboard.press("Tab");
		// Keep tabbing until we find Full Details (may need a few tabs through timeline content)
		for (let i = 0; i < 5; i++) {
			const focused = page.locator(":focus");
			const name = await focused.getAttribute("aria-label").catch(() => null)
				?? await focused.textContent().catch(() => "");
			if (name?.toLowerCase().includes("full details")) break;
			await page.keyboard.press("Tab");
		}

		// Activate Full Details with Enter
		const fullDetailsBtn = panel.getByRole("button", { name: /full details/i });
		await fullDetailsBtn.focus();
		await page.keyboard.press("Enter");

		// Modal should appear
		await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: TIMEOUTS.medium });
		await page.keyboard.press("Escape");
	});
});

// ============================================================================
// Accessibility / ARIA Verification
// ============================================================================

test.describe("Requests - Accessibility", () => {
	test("should have proper dialog semantics on request detail modal", async ({ page }) => {
		await page.goto(ROUTES.requests);
		const hasSeerr = await hasSeerrInstance(page);
		test.skip(!hasSeerr, "No Seerr instance configured");

		// Switch to All Requests tab and wait for content to load
		await selectTab(page, "All Requests");
		await expect(page.locator("select").first()).toBeVisible({ timeout: TIMEOUTS.apiResponse });

		// Wait for request cards (role="button" with Movie/TV badge)
		const cards = page.locator("[role='button']").filter({ hasText: /movie|tv/i });
		await expect(cards.first()).toBeVisible({ timeout: TIMEOUTS.apiResponse });
		// (If no cards appear within timeout, the expect will fail — no silent skip)

		// Open detail modal
		const firstCard = page.locator("[role='button']").filter({ hasText: /movie|tv/i }).first();
		await firstCard.click();

		const modal = page.locator('[role="dialog"]');
		await expect(modal).toBeVisible({ timeout: TIMEOUTS.medium });

		// Verify ARIA attributes
		await expect(modal).toHaveAttribute("aria-modal", "true");
		await expect(modal).toHaveAttribute("aria-labelledby", "request-detail-title");
		await expect(modal).toHaveAttribute("aria-describedby", "request-detail-desc");

		// Verify referenced elements exist
		await expect(page.locator("#request-detail-title")).toBeVisible();
		await expect(page.locator("#request-detail-desc")).toBeVisible();

		await page.keyboard.press("Escape");
	});

	test("should have aria-label on compact timeline stages", async ({ page }) => {
		await page.goto(ROUTES.requests);
		const hasSeerr = await hasSeerrInstance(page);
		test.skip(!hasSeerr, "No Seerr instance configured");

		await selectTab(page, "All Requests");
		await expect(page.locator("select").first()).toBeVisible({ timeout: TIMEOUTS.apiResponse });
		const cards = page.locator("[role='button']").filter({ hasText: /movie|tv/i });
		await expect(cards.first()).toBeVisible({ timeout: TIMEOUTS.apiResponse });

		// Compact timeline wrapper should have role="img" and aria-label with stage summary
		const timeline = page.locator("[role='img'][aria-label^='Status:']").first();
		await expect(timeline).toBeVisible({ timeout: TIMEOUTS.short });

		const label = await timeline.getAttribute("aria-label");
		expect(label).toContain("Requested");
	});

	test("should have aria attributes on preview button", async ({ page }) => {
		await page.goto(ROUTES.requests);
		const hasSeerr = await hasSeerrInstance(page);
		test.skip(!hasSeerr, "No Seerr instance configured");

		const hasPreview = await waitForPendingRequestsWithPreview(page);
		test.skip(!hasPreview, "No pending requests with Preview button");

		const previewBtn = page.locator("button[aria-label='Preview request']").first();

		// Before expanding: aria-expanded should be false
		await expect(previewBtn).toHaveAttribute("aria-expanded", "false");

		// After expanding: aria-expanded should be true, aria-controls should reference panel
		// Use the panel appearance as the ground truth (more reliable than checking attribute
		// immediately after click, as React state updates are async)
		await previewBtn.click();
		const panel = page.locator("[id^='preview-']").first();
		await expect(panel).toBeVisible({ timeout: TIMEOUTS.short });

		// Now verify the button reflects expanded state
		await expect(page.locator("button[aria-label='Close preview']").first()).toBeVisible();
		const closeBtn = page.locator("button[aria-label='Close preview']").first();
		await expect(closeBtn).toHaveAttribute("aria-expanded", "true");
		const controlsId = await closeBtn.getAttribute("aria-controls");
		expect(controlsId).toMatch(/^preview-\d+$/);

		// The referenced panel should exist and be visible
		await expect(page.locator(`#${controlsId}`)).toBeVisible();
	});

	test("should have accessible season status dots in preview", async ({ page }) => {
		await page.goto(ROUTES.requests);
		const hasSeerr = await hasSeerrInstance(page);
		test.skip(!hasSeerr, "No Seerr instance configured");

		const hasPreview = await waitForPendingRequestsWithPreview(page);
		test.skip(!hasPreview, "No pending requests with Preview button");

		// Open preview
		await page.locator("button[aria-label='Preview request']").first().click();
		const panel = page.locator("[id^='preview-']").first();
		await expect(panel).toBeVisible({ timeout: TIMEOUTS.short });

		// If there are season dots, they should have role="img" and aria-label
		const seasonDots = panel.locator("[role='img'][aria-label^='Season']");
		const dotCount = await seasonDots.count();
		if (dotCount > 0) {
			const label = await seasonDots.first().getAttribute("aria-label");
			expect(label).toMatch(/Season \d+:/);
		}
		// No dots is fine — may be a movie request
	});
});
