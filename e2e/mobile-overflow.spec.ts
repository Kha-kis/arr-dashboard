import { expect, test } from "@playwright/test";

test.use({ storageState: { cookies: [], origins: [] } });

const mobileWidths = [320, 375, 390, 430] as const;

const primaryControlSelector = [
	"button",
	"input",
	"select",
	"textarea",
	"[role=button]",
	"[role=tab]",
	"[role=checkbox]",
	"[role=switch]",
	"header a[href]",
	"nav a[href]",
].join(",");

const unavailableInsightPayload = {
	error: "Plex cache evidence is unavailable",
	evidence: {
		availability: "last-known",
		authority: "unavailable",
		attemptState: "error",
		publicationLevel: "unavailable",
		completeness: "unknown",
		reasonCodes: ["latest_attempt_failed"],
	},
};

const service = {
	id: "sonarr-mobile-813",
	label: "Living Room Sonarr",
	service: "SONARR",
	baseUrl: "http://sonarr.test",
	externalUrl: null,
	enabled: true,
	isDefault: true,
	hasApiKey: true,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

const mediaService = {
	...service,
	id: "plex-mobile-813",
	label: "Living Room Plex",
	service: "PLEX",
	baseUrl: "http://plex.test",
	isDefault: false,
};

const queueItem = {
	id: "queue-mobile-813",
	instanceId: service.id,
	instanceName: service.label,
	service: "sonarr",
	title: "The Populated Queue Fixture",
	status: "downloading",
	size: 100,
	sizeleft: 40,
};

const historyItem = {
	id: "history-mobile-813",
	instanceId: service.id,
	instanceName: service.label,
	service: "sonarr",
	title: "The Populated History Fixture",
	status: "imported",
	date: "2026-08-29T12:00:00.000Z",
};

const libraryItem = {
	id: "library-mobile-813",
	instanceId: service.id,
	instanceName: service.label,
	service: "sonarr",
	type: "series",
	title: "The Populated Library Fixture",
	year: 2026,
	monitored: true,
	hasFile: true,
};

async function installPopulatedFixtures(
	page: import("@playwright/test").Page,
	{ includeMediaService = true }: { includeMediaService?: boolean } = {},
) {
	await page.context().addCookies([
		{
			name: "arr_session",
			value: "local-mobile-overflow-session",
			domain: "localhost",
			path: "/",
		},
	]);
	await page.route("**/auth/setup-required", (route) =>
		route.fulfill({ json: { required: false } }),
	);
	await page.route("**/auth/me", (route) =>
		route.fulfill({
			json: {
				user: {
					id: "mobile-overflow-user",
					username: "synthetic-administrator-with-a-long-display-name",
					mustChangePassword: false,
					createdAt: "2026-01-01T00:00:00.000Z",
				},
			},
		}),
	);
	await page.route("**/api/services", async (route) => {
		if (route.request().method() === "GET") {
			await route.fulfill({
				json: { services: includeMediaService ? [service, mediaService] : [service] },
			});
			return;
		}
		await route.continue();
	});
	await page.route("**/api/dashboard/queue", (route) =>
		route.fulfill({
			json: {
				instances: [
					{
						instanceId: service.id,
						instanceName: service.label,
						service: "sonarr",
						data: [queueItem],
					},
				],
				aggregated: [queueItem],
				totalCount: 1,
			},
		}),
	);
	await page.route("**/api/dashboard/statistics", (route) => route.fulfill({ json: {} }));
	await page.route("**/api/dashboard/history**", (route) =>
		route.fulfill({
			json: {
				instances: [
					{
						instanceId: service.id,
						instanceName: service.label,
						service: "sonarr",
						data: [historyItem],
					},
				],
				aggregated: [historyItem],
				totalCount: 1,
			},
		}),
	);
	await page.route("**/api/library/sync/status", (route) =>
		route.fulfill({ json: { instances: [] } }),
	);
	await page.route("**/api/library?**", (route) =>
		route.fulfill({
			json: {
				items: [libraryItem],
				pagination: { page: 1, limit: 50, totalItems: 1000, totalPages: 20 },
				appliedFilters: {},
			},
		}),
	);
	await page.route("**/api/library/insights/**", (route) =>
		route.fulfill({ status: 503, json: unavailableInsightPayload }),
	);
	await page.route("**/api/plex/**", (route) =>
		route.fulfill({ status: 503, json: unavailableInsightPayload }),
	);
	await page.route("**/api/plex/identity", (route) =>
		route.fulfill({
			json: {
				servers: [
					{
						instanceId: mediaService.id,
						instanceName: mediaService.label,
						machineId: "synthetic-machine-id",
						version: "1.42.2.10156-synthetic-build-with-a-long-unbroken-version",
						friendlyName: "Synthetic Plex Server",
						platform: "SyntheticPlatformWithAnIntentionallyLongUnbrokenName",
					},
				],
			},
		}),
	);
	await page.route("**/api/plex/now-playing", (route) =>
		route.fulfill({
			json: {
				sessions: [
					{
						sessionKey: "synthetic-session-key",
						ratingKey: "synthetic-rating-key",
						title: "SyntheticPlaybackTitleWithAnIntentionallyLongUnbrokenName",
						grandparentTitle: "Synthetic Series",
						type: "episode",
						user: { id: 813, title: "Synthetic Administrator" },
						player: {
							title: "SyntheticPlayerWithAnIntentionallyLongUnbrokenName",
							platform: "SyntheticPlatform",
							product: "SyntheticProduct",
							state: "playing",
						},
						state: "playing",
						viewOffset: 60_000,
						duration: 2_400_000,
						videoDecision: "transcode",
						audioDecision: "directplay",
						bandwidth: 8_000,
						instanceId: mediaService.id,
						instanceName: mediaService.label,
					},
				],
				totalBandwidth: 8_000,
			},
		}),
	);
	await page.route("**/api/jellyfin/identity", (route) => route.fulfill({ json: [] }));
}

async function assertNoHorizontalOverflow(
	page: import("@playwright/test").Page,
	path: string,
	expectedText: string,
	assertions?: (page: import("@playwright/test").Page, clientWidth: number) => Promise<void>,
) {
	await page.goto(path);
	await expect(page.locator("main")).toBeVisible();
	await expect(page.getByText(expectedText)).toBeVisible({ timeout: 30_000 });
	const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
	expect(clientWidth).toBeGreaterThan(0);
	const viewportWidth = page.viewportSize()?.width;
	expect(viewportWidth).toBeDefined();
	for (const control of [
		page.getByTitle("Hide sensitive data"),
		page.getByRole("button", { name: "Sign out", exact: true }),
	]) {
		await expect(control).toBeVisible();
		const box = await control.boundingBox();
		expect(box?.x ?? 0).toBeGreaterThanOrEqual(0);
		expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewportWidth ?? 0);
	}
	const serviceTabWrapper =
		path === "/library"
			? page.getByRole("button", { name: "All", exact: true }).locator("..")
			: null;
	let serviceTabWrapperHandle = null;
	if (serviceTabWrapper) {
		await expect(serviceTabWrapper).toBeVisible();
		const wrapperBox = await serviceTabWrapper.boundingBox();
		expect(wrapperBox?.x ?? 0).toBeGreaterThanOrEqual(-1);
		expect((wrapperBox?.x ?? 0) + (wrapperBox?.width ?? 0)).toBeLessThanOrEqual(clientWidth + 1);
		serviceTabWrapperHandle = await serviceTabWrapper.elementHandle();
	}
	const metrics = await page.evaluate(
		({ selector, exemptWrapper }) => {
			const root = document.documentElement;
			const offenders = [...document.querySelectorAll<HTMLElement>(selector)]
				.filter((element) => {
					const rect = element.getBoundingClientRect();
					const style = getComputedStyle(element);
					return (
						rect.width > 0 &&
						rect.height > 0 &&
						style.display !== "none" &&
						style.visibility !== "hidden" &&
						style.visibility !== "collapse"
					);
				})
				.filter((element) => {
					if (exemptWrapper?.contains(element)) return false;
					const rect = element.getBoundingClientRect();
					return rect.right > root.clientWidth + 1 || rect.left < -1;
				})
				.map((element) => {
					const rect = element.getBoundingClientRect();
					return {
						tag: element.tagName,
						role: element.getAttribute("role") ?? "",
						className: typeof element.className === "string" ? element.className : "",
						left: rect.left,
						right: rect.right,
						width: rect.width,
						height: rect.height,
					};
				})
				.slice(0, 12);
			return { clientWidth: root.clientWidth, scrollWidth: root.scrollWidth, offenders };
		},
		{ selector: primaryControlSelector, exemptWrapper: serviceTabWrapperHandle },
	);
	expect(metrics.offenders).toEqual([]);
	expect(metrics.scrollWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.clientWidth);
	if (path === "/library") {
		const statusRegions = page
			.getByRole("status")
			.filter({ hasText: /Plex values are unavailable|Media-server data is unavailable/i });
		await expect(statusRegions.first()).toBeVisible();
		const statusCount = await statusRegions.count();
		expect(statusCount).toBeGreaterThan(0);
		for (let index = 0; index < statusCount; index += 1) {
			const statusRegion = statusRegions.nth(index);
			await expect(statusRegion).toBeVisible();
			const statusBox = await statusRegion.boundingBox();
			expect(statusBox?.x ?? 0).toBeGreaterThanOrEqual(-1);
			expect((statusBox?.x ?? 0) + (statusBox?.width ?? 0)).toBeLessThanOrEqual(
				metrics.clientWidth + 1,
			);
		}
	}
	await assertions?.(page, metrics.clientWidth);
}

test.describe("mobile page overflow", () => {
	for (const width of mobileWidths) {
		test(`dashboard stays within the ${width}px viewport with populated data`, async ({ page }) => {
			await installPopulatedFixtures(page);
			await page.setViewportSize({ width, height: 844 });
			await assertNoHorizontalOverflow(
				page,
				"/dashboard",
				"items in queue",
				async (currentPage, clientWidth) => {
					const tabs = currentPage.getByRole("tab");
					await expect(tabs).toHaveCount(3);
					const activity = currentPage.getByRole("tab", { name: "Activity", exact: true });
					await expect(activity).toBeVisible();
					const activityBox = await activity.boundingBox();
					expect(activityBox?.x ?? 0).toBeGreaterThanOrEqual(0);
					expect((activityBox?.x ?? 0) + (activityBox?.width ?? 0)).toBeLessThanOrEqual(
						clientWidth,
					);
					const refresh = currentPage.getByRole("button", { name: "Refresh", exact: true }).first();
					await expect(refresh).toBeVisible();
					const box = await refresh.boundingBox();
					expect(box?.x ?? 0).toBeGreaterThanOrEqual(0);
					expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(clientWidth);
				},
			);
		});
	}

	test("dashboard fills the mobile tab row when media activity is not configured", async ({
		page,
	}) => {
		await installPopulatedFixtures(page, { includeMediaService: false });
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto("/dashboard");
		const tablist = page.getByRole("tablist");
		const tabs = page.getByRole("tab");
		await expect(tablist).toBeVisible();
		await expect(tabs).toHaveCount(2);
		const tablistBox = await tablist.boundingBox();
		const firstBox = await tabs.first().boundingBox();
		const lastBox = await tabs.last().boundingBox();
		expect(firstBox?.x).toBeCloseTo(tablistBox?.x ?? 0, 0);
		expect((lastBox?.x ?? 0) + (lastBox?.width ?? 0)).toBeCloseTo(
			(tablistBox?.x ?? 0) + (tablistBox?.width ?? 0),
			0,
		);
	});

	for (const width of mobileWidths) {
		test(`history stays within the ${width}px viewport with populated data`, async ({ page }) => {
			await installPopulatedFixtures(page);
			await page.setViewportSize({ width, height: 844 });
			await assertNoHorizontalOverflow(
				page,
				"/history",
				"The Populated History Fixture",
				async (currentPage, clientWidth) => {
					const timeline = currentPage.getByRole("button", { name: "Timeline", exact: true });
					const table = currentPage.getByRole("button", { name: "Table", exact: true });
					const viewToggle = timeline.locator("..");
					await expect(viewToggle).toBeVisible();
					await expect(timeline).toBeVisible();
					await expect(table).toBeVisible();

					for (const control of [viewToggle, timeline, table]) {
						const box = await control.boundingBox();
						expect(box?.x ?? 0).toBeGreaterThanOrEqual(0);
						expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(clientWidth);
					}

					await timeline.click();
					await expect(timeline).toHaveClass(/(?:^|\s)text-foreground(?:\s|$)/);
					await expect(table).toHaveClass(/(?:^|\s)text-muted-foreground(?:\s|$)/);
					await table.click();
					await expect(table).toHaveClass(/(?:^|\s)text-foreground(?:\s|$)/);
					await expect(timeline).toHaveClass(/(?:^|\s)text-muted-foreground(?:\s|$)/);

					const refresh = currentPage.getByRole("button", { name: "Refresh", exact: true }).first();
					await expect(refresh).toBeVisible();
					const refreshBox = await refresh.boundingBox();
					expect(refreshBox?.x ?? 0).toBeGreaterThanOrEqual(0);
					expect((refreshBox?.x ?? 0) + (refreshBox?.width ?? 0)).toBeLessThanOrEqual(clientWidth);
				},
			);
		});
	}

	for (const width of mobileWidths) {
		test(`library stays within the ${width}px viewport with populated data`, async ({ page }) => {
			await installPopulatedFixtures(page);
			await page.setViewportSize({ width, height: 844 });
			await assertNoHorizontalOverflow(
				page,
				"/library",
				"The Populated Library Fixture",
				async (currentPage, clientWidth) => {
					const nextPage = currentPage.getByTitle("Next page").first();
					const lastPage = currentPage.getByTitle("Last page").first();
					await expect(currentPage.getByText("Page 1 of 20").first()).toBeVisible();
					await expect(nextPage).toBeVisible();
					await expect(lastPage).toBeVisible();
					await lastPage.click();
					await expect(currentPage.getByText("Page 20 of 20").first()).toBeVisible();

					const serviceTabs = currentPage
						.getByRole("button", { name: "All", exact: true })
						.locator("..");
					const initialOverflow = await serviceTabs.evaluate((element) => ({
						clientWidth: element.clientWidth,
						scrollWidth: element.scrollWidth,
					}));
					expect(initialOverflow.scrollWidth).toBeGreaterThan(initialOverflow.clientWidth);
					const box = await serviceTabs.boundingBox();
					expect(box?.x ?? 0).toBeGreaterThanOrEqual(0);
					expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(clientWidth);

					const authorsTab = currentPage.getByRole("button", { name: "Authors", exact: true });
					await authorsTab.scrollIntoViewIfNeeded();
					const authorsBox = await authorsTab.boundingBox();
					const wrapperBox = await serviceTabs.boundingBox();
					expect(authorsBox?.x ?? 0).toBeGreaterThanOrEqual(wrapperBox?.x ?? 0);
					expect((authorsBox?.x ?? 0) + (authorsBox?.width ?? 0)).toBeLessThanOrEqual(
						(wrapperBox?.x ?? 0) + (wrapperBox?.width ?? 0),
					);
					await authorsTab.click();
					await expect(authorsTab).toHaveClass(/text-white/);
				},
			);
		});
	}
});

test.describe("desktop responsive guard", () => {
	test("dashboard preserves its desktop header and controls", async ({ page }) => {
		await installPopulatedFixtures(page);
		await page.setViewportSize({ width: 1440, height: 900 });
		await assertNoHorizontalOverflow(page, "/dashboard", "items in queue", async (currentPage) => {
			await expect(currentPage.getByText("Arr Control Center", { exact: true })).toBeVisible();
			await expect(
				currentPage.getByRole("button", { name: "Refresh", exact: true }).first(),
			).toBeVisible();
		});
	});

	test("library preserves its desktop header and controls", async ({ page }) => {
		await installPopulatedFixtures(page);
		await page.setViewportSize({ width: 1440, height: 900 });
		await assertNoHorizontalOverflow(
			page,
			"/library",
			"The Populated Library Fixture",
			async (currentPage) => {
				await expect(currentPage.getByText("Arr Control Center", { exact: true })).toBeVisible();
				await expect(
					currentPage.getByRole("button", { name: "Authors", exact: true }),
				).toBeVisible();
			},
		);
	});
});
