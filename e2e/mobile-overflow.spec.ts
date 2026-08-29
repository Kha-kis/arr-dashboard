import { expect, test } from "@playwright/test";

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

async function installPopulatedFixtures(page: import("@playwright/test").Page) {
	await page.route("**/api/services", async (route) => {
		if (route.request().method() === "GET") {
			await route.fulfill({ json: { services: [service] } });
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
				pagination: { page: 1, limit: 50, totalItems: 1, totalPages: 1 },
				appliedFilters: {},
			},
		}),
	);
}

async function assertNoHorizontalOverflow(
	page: import("@playwright/test").Page,
	path: string,
	expectedText: string,
	assertions?: (page: import("@playwright/test").Page, clientWidth: number) => Promise<void>,
) {
	await page.goto(path);
	await expect(page.locator("main")).toBeVisible();
	await expect(page.getByText(expectedText)).toBeVisible();
	const metrics = await page.evaluate(() => {
		const root = document.documentElement;
		const offenders = [...document.querySelectorAll<HTMLElement>("body *")]
			.map((element) => {
				const rect = element.getBoundingClientRect();
				return {
					tag: element.tagName,
					className: element.className,
					right: rect.right,
					left: rect.left,
				};
			})
			.filter(({ right, left }) => right > root.clientWidth + 1 || left < -1)
			.slice(0, 12);
		return { clientWidth: root.clientWidth, scrollWidth: root.scrollWidth, offenders };
	});
	expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
	await assertions?.(page, metrics.clientWidth);
}

test.describe("mobile page overflow", () => {
	test("dashboard stays within the viewport with populated data", async ({ page }) => {
		await installPopulatedFixtures(page);
		for (const width of [390, 375]) {
			await page.setViewportSize({ width, height: 844 });
			await assertNoHorizontalOverflow(
				page,
				"/dashboard",
				"items in queue",
				async (currentPage, clientWidth) => {
					const refresh = currentPage.getByRole("button", { name: "Refresh", exact: true }).first();
					await expect(refresh).toBeVisible();
					const box = await refresh.boundingBox();
					expect(box?.x ?? 0).toBeGreaterThanOrEqual(0);
					expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(clientWidth);
				},
			);
		}
	});

	test("history stays within the viewport with populated data", async ({ page }) => {
		await installPopulatedFixtures(page);
		for (const width of [390, 375]) {
			await page.setViewportSize({ width, height: 844 });
			await assertNoHorizontalOverflow(page, "/history", "The Populated History Fixture");
		}
	});

	test("library stays within the viewport with populated data", async ({ page }) => {
		await installPopulatedFixtures(page);
		for (const width of [390, 375]) {
			await page.setViewportSize({ width, height: 844 });
			await assertNoHorizontalOverflow(
				page,
				"/library",
				"The Populated Library Fixture",
				async (currentPage, clientWidth) => {
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
		}
	});
});
