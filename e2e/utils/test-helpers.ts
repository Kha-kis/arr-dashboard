/**
 * E2E Test Utilities
 *
 * Shared helper functions and constants for Playwright E2E tests.
 * Reduces code duplication and provides consistent patterns across test files.
 */

import { expect, type Page } from "@playwright/test";

// ============================================================================
// Configuration
// ============================================================================

export const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3000";

export const ROUTES = {
	login: "/login",
	setup: "/setup",
	dashboard: "/dashboard",
	library: "/library",
	calendar: "/calendar",
	search: "/search",
	discover: "/discover",
	indexers: "/indexers",
	history: "/history",
	statistics: "/statistics",
	hunting: "/hunting",
	settings: "/settings",
	trashGuides: "/trash-guides",
} as const;

export const TIMEOUTS = {
	short: 10000,
	medium: 20000,
	long: 30000,
	navigation: 20000,
	apiResponse: 45000,
} as const;

// ============================================================================
// Navigation Helpers
// ============================================================================

/**
 * Navigate to a specific route and wait for load
 * If redirected to login, waits and retries (handles race conditions with auth state)
 */
export async function navigateTo(page: Page, route: keyof typeof ROUTES) {
	await page.goto(ROUTES[route]);
	await page.waitForLoadState("networkidle");

	// Handle auth state race condition - if on login page, wait and retry once
	if (route !== "login" && route !== "setup" && page.url().includes("/login")) {
		// Wait a bit for auth state to propagate, then retry
		await page.waitForTimeout(500);
		await page.goto(ROUTES[route]);
		await page.waitForLoadState("networkidle");
	}
}

/**
 * Ensure user is logged in and on a protected route
 * Redirects to login if session is invalid
 */
export async function ensureAuthenticated(page: Page) {
	// Check if on login page
	if (page.url().includes("/login")) {
		throw new Error(
			"User is not authenticated. Ensure auth.setup.ts ran successfully.",
		);
	}

	// Verify we can see authenticated UI elements
	const signOutButton = page.getByRole("button", { name: /sign out/i });
	await expect(signOutButton).toBeVisible({ timeout: TIMEOUTS.short });
}

/**
 * Navigate using the sidebar navigation
 * Handles both desktop and mobile sidebar layouts
 */
export async function clickSidebarLink(
	page: Page,
	linkName: string,
): Promise<void> {
	// Find the navigation link that is visible (handles responsive sidebars)
	const link = page.getByRole("link", { name: new RegExp(`^${linkName}$`, "i") });

	// Wait for the link to be visible before clicking
	await expect(link).toBeVisible({ timeout: TIMEOUTS.short });
	await link.click();
	await page.waitForLoadState("networkidle");
}

// ============================================================================
// Element Helpers
// ============================================================================

/**
 * Wait for page heading to be visible
 */
export async function waitForPageHeading(
	page: Page,
	headingText: string | RegExp,
) {
	const heading = page.getByRole("heading", { name: headingText, level: 1 });
	await expect(heading).toBeVisible({ timeout: TIMEOUTS.medium });
	return heading;
}

/**
 * Wait for any loading indicators to disappear
 */
export async function waitForLoadingComplete(page: Page) {
	// Wait for skeleton loaders to disappear
	const skeletons = page.locator('[class*="skeleton"], [class*="Skeleton"]');
	if ((await skeletons.count()) > 0) {
		await expect(skeletons.first()).toBeHidden({ timeout: TIMEOUTS.apiResponse });
	}

	// Wait for spinning animations to stop
	const spinners = page.locator('[class*="animate-spin"]');
	if ((await spinners.count()) > 0) {
		await expect(spinners.first()).toBeHidden({ timeout: TIMEOUTS.apiResponse });
	}
}

/**
 * Check if an element exists (returns boolean, doesn't throw)
 */
export async function elementExists(
	page: Page,
	selector: string,
): Promise<boolean> {
	return (await page.locator(selector).count()) > 0;
}

// ============================================================================
// Form Helpers
// ============================================================================

/**
 * Fill a form field by label
 */
export async function fillFieldByLabel(
	page: Page,
	label: string,
	value: string,
) {
	const field = page.getByLabel(new RegExp(label, "i"));
	await field.fill(value);
}

/**
 * Select an option from a dropdown/combobox
 */
export async function selectOption(
	page: Page,
	label: string,
	optionText: string,
) {
	const select = page.getByLabel(new RegExp(label, "i"));
	await select.click();
	const option = page.getByRole("option", { name: new RegExp(optionText, "i") });
	await option.click();
}

// ============================================================================
// Alert and Toast Helpers
// ============================================================================

/**
 * Check for error alert presence
 */
export async function hasErrorAlert(page: Page): Promise<boolean> {
	const errorAlert = page.locator('[role="alert"]').filter({ hasText: /error|failed|unable/i });
	return (await errorAlert.count()) > 0;
}

/**
 * Get alert message text
 */
export async function getAlertText(page: Page): Promise<string | null> {
	const alert = page.locator('[role="alert"]').first();
	if ((await alert.count()) > 0) {
		return await alert.textContent();
	}
	return null;
}

/**
 * Dismiss a dismissible alert
 */
export async function dismissAlert(page: Page) {
	const dismissButton = page
		.locator('[role="alert"]')
		.getByRole("button", { name: /dismiss|close/i });
	if ((await dismissButton.count()) > 0) {
		await dismissButton.click();
	}
}

// ============================================================================
// Table and List Helpers
// ============================================================================

/**
 * Get table row count
 */
export async function getTableRowCount(page: Page): Promise<number> {
	const rows = page.locator("tbody tr, [role='row']");
	return await rows.count();
}

/**
 * Check if empty state is displayed
 */
export async function isEmptyStateVisible(page: Page): Promise<boolean> {
	const emptyState = page.locator('[class*="empty"], [data-testid="empty-state"]');
	const noDataText = page.getByText(/no .* found|no .* configured|nothing to show/i);
	return (await emptyState.count()) > 0 || (await noDataText.count()) > 0;
}

// ============================================================================
// Pagination Helpers
// ============================================================================

/**
 * Navigate to next page in pagination
 */
export async function goToNextPage(page: Page) {
	const nextButton = page.getByRole("button", { name: /next|→|>/i });
	if (await nextButton.isEnabled()) {
		await nextButton.click();
		await page.waitForLoadState("networkidle");
	}
}

/**
 * Navigate to previous page in pagination
 */
export async function goToPreviousPage(page: Page) {
	const prevButton = page.getByRole("button", { name: /prev|←|</i });
	if (await prevButton.isEnabled()) {
		await prevButton.click();
		await page.waitForLoadState("networkidle");
	}
}

// ============================================================================
// Service Instance Helpers
// ============================================================================

export const SERVICE_TYPES = ["sonarr", "radarr", "prowlarr"] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

/**
 * Get count of configured instances from stat cards
 */
export async function getServiceInstanceCount(
	page: Page,
	service: ServiceType,
): Promise<number> {
	const statCard = page.locator(`[class*="stat"], [data-testid="stat-card"]`).filter({
		hasText: new RegExp(service, "i"),
	});

	if ((await statCard.count()) > 0) {
		const valueText = await statCard.locator('[class*="value"], h3, h2').textContent();
		return Number.parseInt(valueText || "0", 10);
	}
	return 0;
}

// ============================================================================
// Tab Navigation Helpers
// ============================================================================

/**
 * Click on a tab button
 */
export async function selectTab(page: Page, tabName: string) {
	const tab = page.getByRole("tab", { name: new RegExp(tabName, "i") });
	if ((await tab.count()) === 0) {
		// Fallback to button if not using tab role
		const button = page.getByRole("button", { name: new RegExp(tabName, "i") });
		await button.click();
	} else {
		await tab.click();
	}
	await page.waitForLoadState("networkidle");
}

/**
 * Check if a tab is active/selected
 */
export async function isTabActive(page: Page, tabName: string): Promise<boolean> {
	const tab = page.getByRole("tab", { name: new RegExp(tabName, "i") });
	if ((await tab.count()) > 0) {
		const ariaSelected = await tab.getAttribute("aria-selected");
		return ariaSelected === "true";
	}
	return false;
}

// ============================================================================
// Modal/Dialog Helpers
// ============================================================================

/**
 * Wait for modal to be visible
 */
export async function waitForModal(page: Page) {
	const modal = page.locator('[role="dialog"], [class*="modal"]');
	await expect(modal).toBeVisible({ timeout: TIMEOUTS.medium });
	return modal;
}

/**
 * Close modal via close button or escape
 */
export async function closeModal(page: Page) {
	const closeButton = page
		.locator('[role="dialog"], [class*="modal"]')
		.getByRole("button", { name: /close|cancel|×/i });

	if ((await closeButton.count()) > 0) {
		await closeButton.first().click();
	} else {
		await page.keyboard.press("Escape");
	}
}

// ============================================================================
// Data Attribute Helpers (for test-specific selectors)
// ============================================================================

/**
 * Get element by data-testid
 */
export function byTestId(page: Page, testId: string) {
	return page.locator(`[data-testid="${testId}"]`);
}
