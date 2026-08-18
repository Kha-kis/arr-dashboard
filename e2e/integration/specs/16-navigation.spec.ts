/**
 * Integration: Full Navigation Sweep
 *
 * Validates that every sidebar route loads without errors:
 * - Navigate to each page via sidebar
 * - Verify no console errors
 * - Verify no broken routes (no 404 or error states)
 *
 * The sweep is derived from the app's navigation registry
 * (apps/web/src/components/layout/navigation.ts) so the sidebar and this spec
 * cannot drift apart: every registered destination must load.
 */

import { test, expect } from "@playwright/test";
import {
	ROUTES,
	TIMEOUTS,
	waitForLoadingComplete,
	clickSidebarLink,
} from "../../utils/test-helpers";
import { ensureAuthenticated } from "../utils/auth-helpers";
import { NAVIGATION_GROUPS } from "../../../apps/web/src/components/layout/navigation";

// Every sidebar destination comes from the registry, not a hand-maintained map.
const SIDEBAR_NAVIGATION = NAVIGATION_GROUPS.flatMap((group) => group.items).map(
	(item) => ({ linkName: item.label, route: item.href }),
);

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

		// Settings and TRaSH Guides are part of the registry sweep above.
		// Filter out known non-critical console errors
		const criticalErrors = consoleErrors.filter(
			(err) =>
				!err.includes("favicon") &&
				!err.includes("hydrat") &&
				!err.includes("ResizeObserver") &&
				!err.includes("429") &&
				!err.includes("Too Many Requests") &&
				!err.includes("Failed to load resource") &&
				// Cover art from plain-http test instances is intentionally
				// blocked by the strict img-src 'self' data: https: policy;
				// production instances are served over https and unaffected.
				!err.includes("Content Security Policy") &&
				!err.includes("img-src"),
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
