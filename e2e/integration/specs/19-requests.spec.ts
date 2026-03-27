/**
 * Integration: Seerr Requests Experience
 *
 * Tests the approval queue inline preview, request lifecycle timeline,
 * ARIA semantics, and keyboard navigation against a real Jellyseerr
 * instance with pending requests seeded by bootstrap-services.sh.
 *
 * Requires: Jellyseerr container with pending requests (created in bootstrap).
 */

import { test, expect } from "@playwright/test";
import { ROUTES, TIMEOUTS, selectTab } from "../../utils/test-helpers";
import { ensureAuthenticated } from "../utils/auth-helpers";

// ============================================================================
// Helpers
// ============================================================================

/** Wait for the approval queue to show the Seerr tab bar. */
async function waitForSeerrTabs(page: import("@playwright/test").Page): Promise<boolean> {
	const tab = page.locator("button").filter({ hasText: /approval queue/i }).first();
	const empty = page.getByText(/no seerr instances/i);
	try {
		await tab.or(empty).waitFor({ state: "visible", timeout: TIMEOUTS.apiResponse });
	} catch {
		return false;
	}
	return tab.isVisible();
}

/** Wait for a Preview button to appear (indicates pending request cards loaded). */
async function waitForPreviewButton(page: import("@playwright/test").Page): Promise<boolean> {
	const btn = page.locator("button[aria-label='Preview request']").first();
	try {
		await btn.waitFor({ state: "visible", timeout: TIMEOUTS.apiResponse });
		return true;
	} catch {
		return false;
	}
}

// ============================================================================
// Approval Queue & Inline Preview
// ============================================================================

test.describe("Requests - Approval Queue", () => {
	test("should display pending requests with Preview button", async ({ page }) => {
		await page.goto(ROUTES.requests);
		await ensureAuthenticated(page);

		const hasSeerr = await waitForSeerrTabs(page);
		test.skip(!hasSeerr, "No Seerr instance registered");

		const hasPreview = await waitForPreviewButton(page);
		test.skip(!hasPreview, "No pending requests in approval queue");

		// Verify the card has the expected structure
		const card = page.locator("[role='button']").filter({ hasText: /movie|tv/i }).first();
		await expect(card).toBeVisible();
	});

	test("should toggle inline preview with expanded timeline", async ({ page }) => {
		await page.goto(ROUTES.requests);
		await ensureAuthenticated(page);

		const hasSeerr = await waitForSeerrTabs(page);
		test.skip(!hasSeerr, "No Seerr instance registered");

		const hasPreview = await waitForPreviewButton(page);
		test.skip(!hasPreview, "No pending requests");

		// Click Preview
		const previewBtn = page.locator("button[aria-label='Preview request']").first();
		await previewBtn.click();

		// Panel should appear with expanded timeline
		const panel = page.locator("[id^='preview-']").first();
		await expect(panel).toBeVisible({ timeout: TIMEOUTS.short });
		await expect(panel.getByText("Requested")).toBeVisible();

		// Close it
		await page.locator("button[aria-label='Close preview']").first().click();
		await expect(panel).toBeHidden();
	});

	test("should show overview and Full Details button in preview", async ({ page }) => {
		await page.goto(ROUTES.requests);
		await ensureAuthenticated(page);

		const hasSeerr = await waitForSeerrTabs(page);
		test.skip(!hasSeerr, "No Seerr instance registered");

		const hasPreview = await waitForPreviewButton(page);
		test.skip(!hasPreview, "No pending requests");

		await page.locator("button[aria-label='Preview request']").first().click();
		const panel = page.locator("[id^='preview-']").first();
		await expect(panel).toBeVisible({ timeout: TIMEOUTS.short });

		// Full Details button should be present
		await expect(panel.getByRole("button", { name: /full details/i })).toBeVisible();

		// Panel should have content (timeline at minimum, overview if media has it)
		const text = await panel.textContent();
		expect(text).toContain("Requested");
	});

	test("should close previous preview when opening another", async ({ page }) => {
		await page.goto(ROUTES.requests);
		await ensureAuthenticated(page);

		const hasSeerr = await waitForSeerrTabs(page);
		test.skip(!hasSeerr, "No Seerr instance registered");

		const previewButtons = page.locator("button[aria-label='Preview request']");
		const count = await previewButtons.count();
		test.skip(count < 2, "Need at least 2 pending requests");

		// Open first
		await previewButtons.first().click();
		const panels = page.locator("[id^='preview-']");
		await expect(panels.first()).toBeVisible({ timeout: TIMEOUTS.short });

		// Open second — re-query since first button's label changed
		await page.locator("button[aria-label='Preview request']").first().click();
		await page.waitForTimeout(300);

		// Only one panel visible
		let visible = 0;
		for (let i = 0; i < await panels.count(); i++) {
			if (await panels.nth(i).isVisible()) visible++;
		}
		expect(visible).toBe(1);
	});

	test("should open detail modal via Full Details button", async ({ page }) => {
		await page.goto(ROUTES.requests);
		await ensureAuthenticated(page);

		const hasSeerr = await waitForSeerrTabs(page);
		test.skip(!hasSeerr, "No Seerr instance registered");

		const hasPreview = await waitForPreviewButton(page);
		test.skip(!hasPreview, "No pending requests");

		await page.locator("button[aria-label='Preview request']").first().click();
		const panel = page.locator("[id^='preview-']").first();
		await expect(panel).toBeVisible({ timeout: TIMEOUTS.short });

		// Click Full Details
		await panel.getByRole("button", { name: /full details/i }).click();

		// Modal should open
		const modal = page.locator('[role="dialog"]');
		await expect(modal).toBeVisible({ timeout: TIMEOUTS.medium });

		await page.keyboard.press("Escape");
		await expect(modal).toBeHidden();
	});
});

// ============================================================================
// Keyboard Navigation
// ============================================================================

test.describe("Requests - Keyboard", () => {
	test("should open preview via keyboard and tab to Full Details", async ({ page }) => {
		await page.goto(ROUTES.requests);
		await ensureAuthenticated(page);

		const hasSeerr = await waitForSeerrTabs(page);
		test.skip(!hasSeerr, "No Seerr instance registered");

		const hasPreview = await waitForPreviewButton(page);
		test.skip(!hasPreview, "No pending requests");

		// Focus Preview and press Enter
		const previewBtn = page.locator("button[aria-label='Preview request']").first();
		await previewBtn.focus();
		await page.keyboard.press("Enter");

		const panel = page.locator("[id^='preview-']").first();
		await expect(panel).toBeVisible({ timeout: TIMEOUTS.short });

		// Tab to Full Details and activate with Enter
		const fullDetailsBtn = panel.getByRole("button", { name: /full details/i });
		await fullDetailsBtn.focus();
		await page.keyboard.press("Enter");

		// Modal should appear
		await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: TIMEOUTS.medium });
		await page.keyboard.press("Escape");
	});
});

// ============================================================================
// ARIA / Accessibility
// ============================================================================

test.describe("Requests - ARIA Verification", () => {
	test("should have dialog semantics on request detail modal", async ({ page }) => {
		await page.goto(ROUTES.requests);
		await ensureAuthenticated(page);

		const hasSeerr = await waitForSeerrTabs(page);
		test.skip(!hasSeerr, "No Seerr instance registered");

		// Switch to All Requests to find any cards
		await selectTab(page, "All Requests");
		await expect(page.locator("select").first()).toBeVisible({ timeout: TIMEOUTS.apiResponse });

		const card = page.locator("[role='button']").filter({ hasText: /movie|tv/i }).first();
		await expect(card).toBeVisible({ timeout: TIMEOUTS.apiResponse });
		await card.click();

		const modal = page.locator('[role="dialog"]');
		await expect(modal).toBeVisible({ timeout: TIMEOUTS.medium });

		// ARIA structure
		await expect(modal).toHaveAttribute("aria-modal", "true");
		await expect(modal).toHaveAttribute("aria-labelledby", "request-detail-title");
		await expect(modal).toHaveAttribute("aria-describedby", "request-detail-desc");
		await expect(page.locator("#request-detail-title")).toBeVisible();
		await expect(page.locator("#request-detail-desc")).toBeVisible();

		await page.keyboard.press("Escape");
	});

	test("should have aria-label on compact timeline stages", async ({ page }) => {
		await page.goto(ROUTES.requests);
		await ensureAuthenticated(page);

		const hasSeerr = await waitForSeerrTabs(page);
		test.skip(!hasSeerr, "No Seerr instance registered");

		await selectTab(page, "All Requests");
		await expect(page.locator("select").first()).toBeVisible({ timeout: TIMEOUTS.apiResponse });

		const card = page.locator("[role='button']").filter({ hasText: /movie|tv/i }).first();
		await expect(card).toBeVisible({ timeout: TIMEOUTS.apiResponse });

		// Compact timeline: role="img" with aria-label starting with "Status:"
		const timeline = page.locator("[role='img'][aria-label^='Status:']").first();
		await expect(timeline).toBeVisible();

		const label = await timeline.getAttribute("aria-label");
		expect(label).toContain("Requested");
	});

	test("should have aria-expanded and aria-controls on Preview button", async ({ page }) => {
		await page.goto(ROUTES.requests);
		await ensureAuthenticated(page);

		const hasSeerr = await waitForSeerrTabs(page);
		test.skip(!hasSeerr, "No Seerr instance registered");

		const hasPreview = await waitForPreviewButton(page);
		test.skip(!hasPreview, "No pending requests");

		const previewBtn = page.locator("button[aria-label='Preview request']").first();
		await expect(previewBtn).toHaveAttribute("aria-expanded", "false");

		// Expand
		await previewBtn.click();
		const panel = page.locator("[id^='preview-']").first();
		await expect(panel).toBeVisible({ timeout: TIMEOUTS.short });

		// After expansion, button label changes to "Close preview"
		const closeBtn = page.locator("button[aria-label='Close preview']").first();
		await expect(closeBtn).toHaveAttribute("aria-expanded", "true");

		const controlsId = await closeBtn.getAttribute("aria-controls");
		expect(controlsId).toMatch(/^preview-\d+$/);
		await expect(page.locator(`#${controlsId}`)).toBeVisible();
	});

	test("should have accessible season dots in preview if TV request", async ({ page }) => {
		await page.goto(ROUTES.requests);
		await ensureAuthenticated(page);

		const hasSeerr = await waitForSeerrTabs(page);
		test.skip(!hasSeerr, "No Seerr instance registered");

		const hasPreview = await waitForPreviewButton(page);
		test.skip(!hasPreview, "No pending requests");

		await page.locator("button[aria-label='Preview request']").first().click();
		const panel = page.locator("[id^='preview-']").first();
		await expect(panel).toBeVisible({ timeout: TIMEOUTS.short });

		// If TV request, season dots should have role="img" + aria-label
		const seasonDots = panel.locator("[role='img'][aria-label^='Season']");
		const count = await seasonDots.count();
		if (count > 0) {
			const label = await seasonDots.first().getAttribute("aria-label");
			expect(label).toMatch(/Season \d+:/);
		}
		// No dots = movie request, which is also valid
	});
});
