/**
 * Integration: Full Navigation Sweep
 *
 * Validates that every sidebar route loads without errors:
 * - Navigate to each page via sidebar
 * - Verify no console errors
 * - Verify no broken routes (no 404 or error states)
 */

import { expect, test } from "@playwright/test";
import {
	clickSidebarLink,
	ROUTES,
	TIMEOUTS,
	waitForLoadingComplete,
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

const EXPECTED_LIDARR_POSTER_CSP =
	/^Loading the image 'http:\/\/lidarr:8686\/config\/MediaCover\/\d+\/poster\.jpg' violates the following Content Security Policy directive: "img-src 'self' data: https:"\. The action has been blocked\.$/;
const HISTORY_CONTAINMENT_MESSAGE =
	"History is temporarily unavailable while safe, bounded pagination is restored.";
const EXPECTED_HISTORY_RESOURCE_ERROR =
	/^Failed to load resource: the server responded with a status of 503 \(Service Unavailable\)$/;

interface ConsoleError {
	route: string;
	message: string;
}

test.describe("Full Navigation Sweep", () => {
	test("should navigate to every sidebar page without errors", async ({ page }) => {
		const consoleErrors: ConsoleError[] = [];

		// Collect console errors during navigation
		page.on("console", (msg) => {
			if (msg.type() === "error") {
				consoleErrors.push({
					route: new URL(page.url()).pathname,
					message: msg.text(),
				});
			}
		});

		// Start from dashboard
		await page.goto(ROUTES.dashboard);
		await waitForLoadingComplete(page);
		await ensureAuthenticated(page);

		for (const { linkName, route } of SIDEBAR_NAVIGATION) {
			const historyResponsePromise =
				route === "/history"
					? page.waitForResponse((response) => {
							const url = new URL(response.url());
							return (
								response.request().method() === "GET" && url.pathname === "/api/dashboard/history"
							);
						})
					: undefined;

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

			if (route === "/library") {
				// The fixture's Docker-only Lidarr poster URL is intentionally blocked by
				// production CSP when present. The card must retain an accessible fallback.
				const posterFallback = page
					.getByRole("img", { name: "Radiohead" })
					.or(page.getByRole("button", { name: "Artwork", exact: true }));
				await expect(posterFallback.first()).toBeVisible();
				await expect(
					page.getByRole("button", { name: "Radiohead", exact: true }).first(),
				).toBeVisible();
			}

			if (route === "/history") {
				const historyResponse = await historyResponsePromise;
				expect(historyResponse?.status()).toBe(503);
				expect(await historyResponse?.json()).toEqual({
					error: HISTORY_CONTAINMENT_MESSAGE,
				});
				await expect(page.getByText(HISTORY_CONTAINMENT_MESSAGE)).toBeVisible();
			}

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

		// Exempt only the exact fixture-specific CSP block. Every other browser
		// console error remains a navigation failure.
		const expectedLidarrCspErrors = consoleErrors.filter(
			(error) => error.route === "/library" && EXPECTED_LIDARR_POSTER_CSP.test(error.message),
		);
		expect(expectedLidarrCspErrors.length).toBeLessThanOrEqual(1);
		const expectedHistoryContainmentErrors = consoleErrors.filter(
			(error) => error.route === "/history" && EXPECTED_HISTORY_RESOURCE_ERROR.test(error.message),
		);
		expect(expectedHistoryContainmentErrors.length).toBeLessThanOrEqual(1);

		const unexpectedErrors = consoleErrors.filter(
			(error) =>
				!(error.route === "/library" && EXPECTED_LIDARR_POSTER_CSP.test(error.message)) &&
				!(error.route === "/history" && EXPECTED_HISTORY_RESOURCE_ERROR.test(error.message)),
		);

		expect(unexpectedErrors).toHaveLength(0);
	});

	test("should handle direct URL navigation to all routes", async ({ page }) => {
		// Test direct navigation (not via sidebar) — exercises Next.js routing
		const allRoutes = Object.values(ROUTES).filter((r) => r !== "/login" && r !== "/setup");

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
