import { expect, type Page, test } from "@playwright/test";

const widths = [320, 375, 390, 430, 1440] as const;
const longLabel = "SyntheticConfigurationCategoryWithAnUnbrokenCacheLabel";
const fetched = "2026-11-23T16:30:00.000Z";

const populated = {
	radarr: [
		{
			serviceType: "RADARR",
			configType: "NAMING",
			version: 2,
			itemCount: 12345,
			lastFetched: fetched,
			isStale: true,
			sourceBreakdown: { official: 10234, custom: 2111 },
		},
		{
			serviceType: "RADARR",
			configType: longLabel,
			version: 1,
			itemCount: null,
			lastFetched: fetched,
			isStale: true,
			unavailable: true,
		},
	],
	sonarr: [
		{
			serviceType: "SONARR",
			configType: "QUALITY_PROFILES",
			version: 1,
			itemCount: 51,
			lastFetched: fetched,
			isStale: false,
		},
	],
	stats: { totalEntries: 3, staleEntries: 2, totalSizeBytes: 5000 },
};

async function installFixtures(page: Page, state: "pending" | "populated" | "error") {
	let releaseCache = () => {};
	const cacheLatch = new Promise<void>((resolve) => {
		releaseCache = resolve;
	});
	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const { pathname } = new URL(request.url());
		if (request.method() !== "GET") return route.abort();
		switch (pathname) {
			case "/api/auth/setup-required":
				return route.fulfill({ json: { required: false } });
			case "/api/auth/me":
				return route.fulfill({
					json: {
						user: {
							id: "trash-cache-mobile",
							username: "fixture-admin",
							mustChangePassword: false,
							createdAt: fetched,
						},
					},
				});
			case "/api/services":
				return route.fulfill({ json: { services: [] } });
			case "/api/trash-guides/templates":
				return route.fulfill({ json: { templates: [], count: 0 } });
			case "/api/trash-guides/cache/health":
				return route.fulfill({
					json: {
						lastRefreshAt: fetched,
						totals: { total: 3, validated: 2, rejected: 1 },
						categories: { customFormatDescriptions: { total: 3, validated: 2, rejected: 1 } },
					},
				});
			case "/api/trash-guides/cache/status":
				if (state === "pending") await cacheLatch;
				if (state === "error") {
					return route.fulfill({
						status: 503,
						json: { error: "CacheStatusUnavailableWithAnIntentionallyLongUnbrokenDiagnostic" },
					});
				}
				return route.fulfill({
					json:
						state === "populated"
							? populated
							: {
									radarr: [],
									sonarr: [],
									stats: { totalEntries: 0, staleEntries: 0, totalSizeBytes: 0 },
								},
				});
			default:
				return route.fulfill({ json: {} });
		}
	});
	return releaseCache;
}

async function assertPageFits(page: Page, name: string) {
	const geometry = await page.evaluate(async () => {
		await document.fonts.ready;
		const root = document.documentElement;
		const main = document.querySelector("main");
		return {
			clientWidth: root.clientWidth,
			scrollWidth: root.scrollWidth,
			mainScrollWidth: main?.scrollWidth,
		};
	});
	await test.info().attach(name, {
		body: JSON.stringify(geometry),
		contentType: "application/json",
	});
	expect(geometry.scrollWidth, JSON.stringify(geometry)).toBe(geometry.clientWidth);
}

async function openCache(page: Page, width: number) {
	const tab = page.getByRole("button", { name: "Cache", exact: true });
	await tab.press("Enter");
	await expect(page.getByRole("heading", { name: "RADARR", exact: true })).toBeVisible();
	const rail = await tab.locator("..").evaluate((element) => ({
		clientWidth: element.clientWidth,
		scrollWidth: element.scrollWidth,
		right: element.getBoundingClientRect().right,
		overflowX: getComputedStyle(element).overflowX,
	}));
	expect(rail.right).toBeLessThanOrEqual(width + 1);
	if (rail.scrollWidth > rail.clientWidth) expect(rail.overflowX).toBe("auto");
}

for (const width of widths) {
	test.describe("TRaSH Cache at " + width + " CSS px", () => {
		test.use({ viewport: { width, height: 900 }, reducedMotion: "reduce" });

		test("populated cards and controls fit", async ({ page }) => {
			await installFixtures(page, "populated");
			await page.goto("/trash-guides");
			await openCache(page, width);
			await expect(page.getByRole("heading", { name: "Naming Schemes" })).toBeVisible();
			const longHeading = page.getByRole("heading", { name: longLabel });
			await expect(longHeading).toBeVisible();
			await expect(page.getByText("12345", { exact: true })).toBeVisible();
			await expect(page.getByText("Stale", { exact: true })).toBeVisible();
			await expect(page.getByText("Unavailable", { exact: true })).toBeVisible();
			await expect(page.getByRole("heading", { name: "Validation Health" })).toBeVisible();
			await assertPageFits(page, "populated");
			expect(await longHeading.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(
				await longHeading.evaluate((element) => element.clientWidth),
			);
			const buttons = page.getByRole("button", { name: "Refresh All", exact: true });
			await expect(buttons).toHaveCount(2);
			for (const button of [
				...(await buttons.all()),
				page.getByRole("button", { name: "Refresh " + longLabel, exact: true }),
			]) {
				await expect(button).toBeEnabled();
				await button.focus();
				await expect(button).toBeFocused();
				const box = await button.boundingBox();
				expect(box).not.toBeNull();
				if (box) {
					expect(box.x).toBeGreaterThanOrEqual(-1);
					expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
				}
			}
		});

		test("loading and empty states fit", async ({ page }) => {
			const release = await installFixtures(page, "pending");
			try {
				await page.goto("/trash-guides");
				await expect(page.locator("main .animate-pulse").last()).toBeVisible();
				await assertPageFits(page, "loading");
			} finally {
				release();
			}
			await openCache(page, width);
			await expect(page.getByText("No cache entries for RADARR")).toBeVisible();
			const initialize = page.getByRole("button", { name: "Click to initialize cache" });
			await expect(initialize).toHaveCount(2);
			await initialize.first().focus();
			await expect(initialize.first()).toBeFocused();
			await assertPageFits(page, "empty");
		});

		test("error diagnostic remains readable", async ({ page }) => {
			await installFixtures(page, "error");
			await page.goto("/trash-guides");
			await expect(
				page.getByRole("heading", { name: "Failed to load cache status" }),
			).toBeVisible();
			await expect(
				page.getByText(/CacheStatusUnavailableWithAnIntentionallyLongUnbrokenDiagnostic/),
			).toBeVisible();
			await assertPageFits(page, "error");
		});
	});
}
