import { expect, type Page, test } from "@playwright/test";

const fixtureOrigin = process.env.CALENDAR_RESPONSIVE_FIXTURE_ORIGIN;
const controlNames = ["Previous month", "Next month", "Today", "Refresh calendar"] as const;

async function openCalendar(page: Page) {
	await page.clock.install({ time: new Date("2026-09-15T12:00:00.000Z") });
	let reads = 0;
	if (!fixtureOrigin) {
		await page.route("**/auth/setup-required", (route) =>
			route.fulfill({ json: { required: false } }),
		);
		await page.route("**/auth/me", (route) =>
			route.fulfill({
				json: {
					user: {
						id: "calendar-responsive-user",
						username: "Synthetic administrator",
						mustChangePassword: false,
						createdAt: "2026-01-01T00:00:00.000Z",
					},
				},
			}),
		);
		await page.route("**/api/services", (route) => route.fulfill({ json: { services: [] } }));
		await page.route("**/api/dashboard/calendar?**", (route) => {
			reads++;
			return route.fulfill({
				json: { instances: [], aggregated: [], totalCount: 0, availability: "not-configured" },
			});
		});
	}
	await page.goto(fixtureOrigin ?? "/calendar");
	const header = page
		.locator("header")
		.filter({ has: page.getByRole("heading", { name: "Calendar", exact: true }) });
	await expect(header.getByText("September 2026", { exact: true })).toBeVisible();
	await header.evaluate(async (element) => {
		await Promise.all(
			element
				.getAnimations({ subtree: true })
				.filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
				.map((animation) => animation.finished.catch(() => undefined)),
		);
	});
	return { header, reads: () => reads };
}

test.describe("Calendar responsive primary controls", () => {
	for (const width of [320, 390, 1440]) {
		test(`all controls fit at ${width}px with the longest normal month label`, async ({ page }) => {
			await page.setViewportSize({ width, height: 900 });
			const { header } = await openCalendar(page);
			const metrics = await header.evaluate((element) => ({
				viewport: document.documentElement.clientWidth,
				documentWidth: document.documentElement.scrollWidth,
				headerWidth: element.scrollWidth,
				headerClientWidth: element.clientWidth,
			}));
			expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewport);
			expect(metrics.headerWidth).toBeLessThanOrEqual(metrics.headerClientWidth);
			for (const name of controlNames) {
				const control = header.getByRole("button", { name, exact: true });
				await expect(control).toBeVisible();
				await expect(control).toBeEnabled();
				const box = await control.boundingBox();
				expect(box).not.toBeNull();
				expect(box!.x).toBeGreaterThanOrEqual(0);
				expect(box!.x + box!.width).toBeLessThanOrEqual(metrics.viewport);
				// Layout dimensions avoid subpixel rounding from entrance transforms.
				const size = await control.evaluate((element) => {
					if (!(element instanceof HTMLButtonElement)) {
						throw new Error("Calendar controls must remain native buttons");
					}
					return { width: element.offsetWidth, height: element.offsetHeight };
				});
				expect(size.width).toBeGreaterThanOrEqual(26);
				expect(size.height).toBeGreaterThanOrEqual(26);
			}
			const label = header.getByText("September 2026", { exact: true });
			expect((await label.boundingBox())!.width).toBeGreaterThanOrEqual(155);
			if (width === 1440) {
				const previous = await header.getByRole("button", { name: "Previous month" }).boundingBox();
				const refresh = await header
					.getByRole("button", { name: "Refresh calendar" })
					.boundingBox();
				expect(previous!.y + previous!.height / 2).toBeCloseTo(refresh!.y + refresh!.height / 2, 0);
			}
		});
	}

	test("native focus and Enter/Space retain navigation, Today and Refresh callbacks", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 320, height: 900 });
		const { header, reads } = await openCalendar(page);
		const previous = header.getByRole("button", { name: "Previous month" });
		await previous.focus();
		await expect(previous).toBeFocused();
		await previous.press("Enter");
		await expect(header.getByText("August 2026", { exact: true })).toBeVisible();
		await header.getByRole("button", { name: "Next month" }).press("Space");
		await expect(header.getByText("September 2026", { exact: true })).toBeVisible();
		await previous.press("Space");
		await header.getByRole("button", { name: "Today", exact: true }).press("Enter");
		await expect(header.getByText("September 2026", { exact: true })).toBeVisible();
		const before = reads();
		await header.getByRole("button", { name: "Refresh calendar" }).press("Space");
		if (fixtureOrigin) {
			await expect(page.getByTestId("calendar-callbacks")).toHaveText(
				"previous:2 next:1 today:1 refresh:1",
			);
		} else {
			await expect.poll(reads).toBeGreaterThan(before);
		}
	});
});
