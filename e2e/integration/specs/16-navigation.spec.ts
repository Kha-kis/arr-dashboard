/**
 * Integration: Full Navigation Sweep
 *
 * Validates that every sidebar route loads without errors:
 * - Navigate to each page via sidebar
 * - Verify no console errors
 * - Verify no broken routes (no 404 or error states)
 */

import { test, expect } from "@playwright/test";
import {
	ROUTES,
	TIMEOUTS,
	waitForLoadingComplete,
	clickSidebarLink,
} from "../../utils/test-helpers";
import { ensureAuthenticated } from "../utils/auth-helpers";

// Map sidebar link text to expected route paths (must match sidebar.tsx labels)
const SIDEBAR_NAVIGATION = [
	{ linkName: "Dashboard", route: "/dashboard" },
	{ linkName: "Discover", route: "/discover" },
	{ linkName: "Library", route: "/library" },
	{ linkName: "Search", route: "/search" },
	{ linkName: "Indexers", route: "/indexers" },
	{ linkName: "Calendar", route: "/calendar" },
	{ linkName: "Statistics", route: "/statistics" },
	{ linkName: "Requests", route: "/requests" },
	{ linkName: "Hunting", route: "/hunting" },
	{ linkName: "Queue Cleaner", route: "/queue-cleaner" },
	{ linkName: "Cleanup", route: "/library-cleanup" },
	{ linkName: "History", route: "/history" },
] as const;

test.describe("Full Navigation Sweep", () => {
	test("should navigate to every sidebar page without errors", async ({ page }) => {
		const consoleErrors: string[] = [];

		// Collect console errors during navigation
		page.on("console", (msg) => {
			if (msg.type() === "error") {
				consoleErrors.push(msg.text());
			}
		});

		// Start from dashboard
		await page.goto(ROUTES.dashboard);
		await waitForLoadingComplete(page);
		await ensureAuthenticated(page);

		for (const { linkName, route } of SIDEBAR_NAVIGATION) {
			// Navigate via sidebar with a small delay to avoid rate limiting
			await clickSidebarLink(page, linkName);
			await waitForLoadingComplete(page);

			// Re-auth if session was lost due to rate limiting
			await ensureAuthenticated(page);

			// Verify URL changed to expected route
			expect(page.url()).toContain(route);

			// Verify page renders — some pages use <main>, others use <banner> + heading
			const mainContent = page.locator("main").or(page.getByRole("heading", { level: 1 }));
			await expect(mainContent.first()).toBeVisible({ timeout: TIMEOUTS.medium });

			// Delay between navigations
			await page.waitForTimeout(500);
		}

		// Also navigate to settings (may be outside sidebar in some layouts)
		await page.goto(ROUTES.settings);
		await waitForLoadingComplete(page);
		expect(page.url()).toContain("/settings");

		// Also navigate to TRaSH Guides
		await page.goto(ROUTES.trashGuides);
		await waitForLoadingComplete(page);
		expect(page.url()).toContain("/trash-guides");

		// Filter out known non-critical console errors
		const criticalErrors = consoleErrors.filter(
			(err) =>
				!err.includes("favicon") &&
				!err.includes("hydrat") &&
				!err.includes("ResizeObserver") &&
				!err.includes("429") &&
				!err.includes("Too Many Requests") &&
				!err.includes("Failed to load resource"),
		);

		// There should be no critical console errors across all pages
		expect(criticalErrors).toHaveLength(0);
	});

	test("should handle direct URL navigation to all routes", async ({ page }) => {
		// Test direct navigation (not via sidebar) — exercises Next.js routing
		const allRoutes = Object.values(ROUTES).filter(
			(r) => r !== "/login" && r !== "/setup",
		);

		for (const route of allRoutes) {
			await page.goto(route);
			await page.waitForTimeout(500);

			// Re-auth if session was lost
			await ensureAuthenticated(page);

			// Page should render — some pages use <main>, others use heading directly
			const mainContent = page.locator("main").or(page.getByRole("heading", { level: 1 }));
			await expect(mainContent.first()).toBeVisible({ timeout: TIMEOUTS.medium });
		}
	});
});
