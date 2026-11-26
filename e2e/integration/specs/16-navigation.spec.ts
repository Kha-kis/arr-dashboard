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
import { lidarrGetArtists } from "../utils/service-api";

const LIBRARY_ACCEPTANCE_TIMEOUT_MS = 15_000;
const LIDARR_SEED_TITLE = "Radiohead";

interface LibrarySyncStatus {
	instanceId: string;
	instanceName: string;
	service: string;
	syncStatus: {
		syncInProgress: boolean;
		lastFullSync: string | null;
		itemCount: number;
	};
}

async function waitForSeededLidarrLibrary(page: import("@playwright/test").Page, deadline: number) {
	const apiBaseUrl = `${new URL(page.url()).origin}/api`;
	let syncRequestStatus: number | null = null;
	const remainingMs = () => {
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			throw new Error(
				`Seeded Lidarr library did not become ready within the 15-second acceptance budget; sync request status=${syncRequestStatus ?? "not requested"}`,
			);
		}
		return remaining;
	};
	const getLidarrStatus = async () => {
		const response = await page.request.get(`${apiBaseUrl}/library/sync/status`, {
			timeout: remainingMs(),
		});
		if (!response.ok()) {
			throw new Error(`Library sync status returned HTTP ${response.status()}`);
		}
		const payload = (await response.json()) as { instances: LibrarySyncStatus[] };
		const status = payload.instances.find(
			(instance) => instance.service === "lidarr" && instance.instanceName === "E2E Lidarr",
		);
		if (!status)
			throw new Error("Expected E2E Lidarr instance was not available for library readiness");
		return status;
	};

	const startedAt = Date.now();
	let syncRequested = false;
	for (;;) {
		const status = await getLidarrStatus();
		if (!status.syncStatus.syncInProgress) {
			if (
				!syncRequested &&
				(status.syncStatus.lastFullSync === null || status.syncStatus.itemCount === 0)
			) {
				const syncResponse = await page.request.post(
					`${apiBaseUrl}/library/sync/${encodeURIComponent(status.instanceId)}`,
					{ timeout: remainingMs() },
				);
				if (syncResponse.status() !== 409 && !syncResponse.ok()) {
					throw new Error(`Lidarr cache sync request returned HTTP ${syncResponse.status()}`);
				}
				syncRequested = true;
				syncRequestStatus = syncResponse.status();
				await page.waitForTimeout(Math.min(200, remainingMs()));
				continue;
			}

			const libraryResponse = await page.request.get(
				`${apiBaseUrl}/library?service=lidarr&search=${encodeURIComponent(LIDARR_SEED_TITLE)}&limit=20`,
				{ timeout: remainingMs() },
			);
			if (!libraryResponse.ok()) {
				throw new Error(`Library cache read returned HTTP ${libraryResponse.status()}`);
			}
			const library = (await libraryResponse.json()) as {
				items: Array<{ title?: string }>;
			};
			if (library.items.some((item) => item.title === LIDARR_SEED_TITLE)) {
				return {
					syncRequestStatus,
					readyElapsedMs: Date.now() - startedAt,
				};
			}

			if (!syncRequested) {
				const syncResponse = await page.request.post(
					`${apiBaseUrl}/library/sync/${encodeURIComponent(status.instanceId)}`,
					{ timeout: remainingMs() },
				);
				if (syncResponse.status() !== 409 && !syncResponse.ok()) {
					throw new Error(`Lidarr cache sync request returned HTTP ${syncResponse.status()}`);
				}
				syncRequested = true;
				syncRequestStatus = syncResponse.status();
			}
		}
		await page.waitForTimeout(Math.min(200, remainingMs()));
	}
}

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

interface ConsoleError {
	route: string;
	message: string;
}

test.describe("Full Navigation Sweep", () => {
	test("should navigate to every sidebar page without errors", async ({ page }, testInfo) => {
		const consoleErrors: ConsoleError[] = [];

		// The existing suite setup seeds the disposable source service. Verify it
		// read-only so the cache readiness check cannot hide a fixture failure.
		const lidarrArtists = await lidarrGetArtists(
			process.env.LIDARR_EXTERNAL_URL || "http://localhost:8686",
			process.env.LIDARR_API_KEY || "",
		);
		if (!lidarrArtists.some((artist) => artist.artistName === LIDARR_SEED_TITLE)) {
			throw new Error(`Required Lidarr seed ${LIDARR_SEED_TITLE} is missing`);
		}

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
			let libraryDeadline: number | undefined;

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
			if (route === "/library") {
				// A first empty sync can finish before the existing suite seed runs.
				// Wait for the seeded cache through the app's authenticated API, then
				// reload once so the browser reads that completed cache generation.
				libraryDeadline = Date.now() + LIBRARY_ACCEPTANCE_TIMEOUT_MS;
				const readiness = await waitForSeededLidarrLibrary(page, libraryDeadline);
				testInfo.annotations.push({
					type: "library-readiness",
					description: `sync request status=${readiness.syncRequestStatus ?? "not needed"}; seeded item ready in ${readiness.readyElapsedMs}ms`,
				});
				const remaining = libraryDeadline - Date.now();
				if (remaining <= 0)
					throw new Error("Library readiness exceeded the 15-second acceptance budget");
				await page.reload({ waitUntil: "networkidle", timeout: remaining });
			}

			// Verify URL changed to expected route
			expect(page.url()).toContain(route);

			// Verify page renders — some pages use <main>, others use <banner> + heading
			const mainContent = page.locator("main").or(page.getByRole("heading", { level: 1 }));
			const remainingLibraryMs = () => {
				if (libraryDeadline === undefined) return TIMEOUTS.medium;
				const remaining = libraryDeadline - Date.now();
				if (remaining <= 0) {
					throw new Error("Library content assertions exceeded the 15-second acceptance budget");
				}
				return remaining;
			};
			await expect(mainContent.first()).toBeVisible({ timeout: remainingLibraryMs() });

			if (route === "/library") {
				// The fixture's Docker-only Lidarr poster URL is intentionally blocked by
				// production CSP when present. The card must retain an accessible fallback.
				const posterFallback = page
					.getByRole("img", { name: "Radiohead" })
					.or(page.getByRole("button", { name: "Artwork", exact: true }));
				await expect(posterFallback.first()).toBeVisible({ timeout: remainingLibraryMs() });
				await expect(
					page.getByRole("button", { name: "Radiohead", exact: true }).first(),
				).toBeVisible({ timeout: remainingLibraryMs() });
			}

			if (route === "/history") {
				const historyResponse = await historyResponsePromise;
				expect(historyResponse?.status()).toBe(200);
				const historyPayload = await historyResponse?.json();
				expect(Object.keys(historyPayload).sort()).toEqual(
					["items", "pageInfo", "sources", "version"].sort(),
				);
				expect(historyPayload.version).toBe(2);
				expect(Array.isArray(historyPayload.items)).toBe(true);
				expect(historyPayload.items.length).toBeLessThanOrEqual(100);
				expect(Array.isArray(historyPayload.sources)).toBe(true);
				expect(historyPayload.sources.length).toBeLessThanOrEqual(1_000);
				expect(Object.keys(historyPayload.pageInfo).sort()).toEqual(
					["hasNextPage", "matchingObservedCount", "nextCursor"].sort(),
				);
				expect(typeof historyPayload.pageInfo.hasNextPage).toBe("boolean");
				expect(
					historyPayload.pageInfo.nextCursor === null ||
						typeof historyPayload.pageInfo.nextCursor === "string",
				).toBe(true);
				expect(historyPayload.pageInfo.hasNextPage).toBe(
					Boolean(historyPayload.pageInfo.nextCursor),
				);
				expect(Number.isSafeInteger(historyPayload.pageInfo.matchingObservedCount)).toBe(true);
				expect(historyPayload.pageInfo.matchingObservedCount).toBeGreaterThanOrEqual(0);
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
		const unexpectedErrors = consoleErrors.filter(
			(error) => !(error.route === "/library" && EXPECTED_LIDARR_POSTER_CSP.test(error.message)),
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
