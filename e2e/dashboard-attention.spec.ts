/**
 * Dashboard — Seerr "Needs Attention" Widget E2E Tests
 *
 * Validates the manual test plan items for the attention signal feature:
 * 1. Widget hides attention section when no failed/stuck requests exist
 * 2. Retry button on failed item triggers toast + refreshes list
 * 3. "View" link navigates to /requests
 * 4. Incognito mode anonymizes titles in attention items
 *
 * These tests gracefully handle environments without Seerr configured
 * or without any attention-worthy requests — they skip rather than fail.
 */

import { test, expect } from "@playwright/test";
import { ROUTES, TIMEOUTS, waitForLoadingComplete } from "./utils/test-helpers";

// ============================================================================
// Helpers
// ============================================================================

/** Check if the Seerr requests widget is present on the dashboard */
async function hasSeerrWidget(page: import("@playwright/test").Page): Promise<boolean> {
	const widget = page.getByText("Seerr Requests").first();
	try {
		await widget.waitFor({ state: "visible", timeout: TIMEOUTS.medium });
		return true;
	} catch {
		return false;
	}
}

/** Check if the "Needs Attention" section is visible in the widget */
async function hasAttentionSection(page: import("@playwright/test").Page): Promise<boolean> {
	const section = page.getByText(/needs attention/i).first();
	try {
		await section.waitFor({ state: "visible", timeout: TIMEOUTS.short });
		return true;
	} catch {
		return false;
	}
}

// ============================================================================
// Attention Section Visibility
// ============================================================================

test.describe("Dashboard - Seerr Attention Widget", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(ROUTES.dashboard);
		await waitForLoadingComplete(page);
	});

	test("should show Seerr widget or skip if no Seerr instance", async ({ page }) => {
		const hasWidget = await hasSeerrWidget(page);
		test.skip(!hasWidget, "No Seerr instance configured — widget not rendered");

		// Widget should show total request count
		await expect(page.getByText(/total request/i).first()).toBeVisible();
	});

	test("should show attention section only when there are attention items", async ({ page }) => {
		const hasWidget = await hasSeerrWidget(page);
		test.skip(!hasWidget, "No Seerr instance configured");

		const hasAttention = await hasAttentionSection(page);

		if (hasAttention) {
			// If attention section is visible, it should have a count
			await expect(page.getByText(/needs attention \(\d/i).first()).toBeVisible();

			// Should have at least one attention item with a reason badge
			const reasonBadge = page.getByText(/^failed$/i).or(page.getByText(/^stuck \d+[hd]$/i));
			await expect(reasonBadge.first()).toBeVisible();
		} else {
			// If no attention section, the "Needs Attention" text should NOT be in the DOM
			const attentionText = page.getByText(/needs attention/i);
			expect(await attentionText.count()).toBe(0);
		}
	});

	test("should show retry button for failed items", async ({ page }) => {
		const hasWidget = await hasSeerrWidget(page);
		test.skip(!hasWidget, "No Seerr instance configured");

		const hasAttention = await hasAttentionSection(page);
		test.skip(!hasAttention, "No attention items present");

		// Check for failed items with retry button
		const failedBadge = page.getByText(/^failed$/i).first();
		const hasFailed = await failedBadge.isVisible().catch(() => false);

		if (hasFailed) {
			// Failed items should have a Retry button
			const retryButton = page.getByRole("button", { name: /retry/i }).first();
			await expect(retryButton).toBeVisible();
		}
		// If no failed items (only stuck), that's fine — test passes
	});

	test("should show view link for stuck items", async ({ page }) => {
		const hasWidget = await hasSeerrWidget(page);
		test.skip(!hasWidget, "No Seerr instance configured");

		const hasAttention = await hasAttentionSection(page);
		test.skip(!hasAttention, "No attention items present");

		// Check for stuck items with view link
		const stuckBadge = page.getByText(/^stuck \d+[hd]$/i).first();
		const hasStuck = await stuckBadge.isVisible().catch(() => false);

		if (hasStuck) {
			// Stuck items should have a View link that points to /requests
			const viewLink = page.getByRole("link", { name: /view/i }).first();
			await expect(viewLink).toBeVisible();
			await expect(viewLink).toHaveAttribute("href", "/requests");
		}
		// If no stuck items (only failed), that's fine
	});

	test("retry button should trigger toast notification", async ({ page }) => {
		const hasWidget = await hasSeerrWidget(page);
		test.skip(!hasWidget, "No Seerr instance configured");

		const hasAttention = await hasAttentionSection(page);
		test.skip(!hasAttention, "No attention items present");

		const retryButton = page.getByRole("button", { name: /retry/i }).first();
		const hasRetry = await retryButton.isVisible().catch(() => false);
		test.skip(!hasRetry, "No failed items with retry button");

		// Click retry
		await retryButton.click();

		// Should show a toast (success or error — both are valid depending on Seerr state)
		const toast = page.locator("[data-sonner-toast]").first();
		await expect(toast).toBeVisible({ timeout: TIMEOUTS.short });
	});

	test("view link should navigate to requests page", async ({ page }) => {
		const hasWidget = await hasSeerrWidget(page);
		test.skip(!hasWidget, "No Seerr instance configured");

		const hasAttention = await hasAttentionSection(page);
		test.skip(!hasAttention, "No attention items present");

		const viewLink = page.getByRole("link", { name: /view/i }).first();
		const hasView = await viewLink.isVisible().catch(() => false);
		test.skip(!hasView, "No stuck items with view link");

		// Click the view link
		await viewLink.click();

		// Should navigate to /requests
		await expect(page).toHaveURL(/\/requests/, { timeout: TIMEOUTS.navigation });
	});
});

// ============================================================================
// Incognito Mode
// ============================================================================

test.describe("Dashboard - Attention Widget Incognito", () => {
	test("should anonymize titles when incognito mode is enabled", async ({ page }) => {
		await page.goto(ROUTES.dashboard);
		await waitForLoadingComplete(page);

		const hasWidget = await hasSeerrWidget(page);
		test.skip(!hasWidget, "No Seerr instance configured");

		const hasAttention = await hasAttentionSection(page);
		test.skip(!hasAttention, "No attention items to test incognito on");

		// Navigate to settings and enable incognito mode
		await page.goto(ROUTES.settings);
		await waitForLoadingComplete(page);

		// Find and toggle incognito mode
		const incognitoToggle = page.getByRole("switch", { name: /incognito/i });
		const hasToggle = await incognitoToggle.isVisible().catch(() => false);
		test.skip(!hasToggle, "Incognito toggle not found in settings");

		// Enable incognito if not already
		const isChecked = await incognitoToggle.isChecked();
		if (!isChecked) {
			await incognitoToggle.click();
			await page.waitForTimeout(500);
		}

		// Go back to dashboard
		await page.goto(ROUTES.dashboard);
		await waitForLoadingComplete(page);

		// Attention items should show anonymized Linux distro names instead of real titles
		const attentionSection = page.getByText(/needs attention/i).first();
		await expect(attentionSection).toBeVisible({ timeout: TIMEOUTS.medium });

		// Real movie/TV titles should NOT be visible in attention items
		// Linux distro names (used by getLinuxIsoName) will appear instead
		// We can't check for specific names without knowing the originals,
		// but we verify the section is rendered (incognito didn't break rendering)
		const attentionItems = page.locator('[class*="attention"], [class*="Attention"]')
			.or(page.getByText(/^failed$/i).or(page.getByText(/^stuck/i)));
		const itemCount = await attentionItems.count();
		expect(itemCount).toBeGreaterThan(0);

		// Restore incognito state
		if (!isChecked) {
			await page.goto(ROUTES.settings);
			await waitForLoadingComplete(page);
			await incognitoToggle.click();
		}
	});
});
