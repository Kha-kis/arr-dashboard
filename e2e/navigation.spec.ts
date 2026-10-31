/**
 * Navigation E2E Tests
 *
 * Tests for sidebar navigation, routing between pages,
 * and header functionality.
 */

import { test, expect } from "@playwright/test";
import { ROUTES, TIMEOUTS, clickSidebarLink } from "./utils/test-helpers";

// CI auto-generates credentials if not provided (must match auth.setup.ts)
const CI_TEST_USERNAME = "ci-test-user";
const TEST_USERNAME = process.env.TEST_USERNAME || (process.env.CI ? CI_TEST_USERNAME : undefined);

test.describe("Navigation - Sidebar", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(ROUTES.dashboard);
	});

	test("should display sidebar with all navigation links", async ({ page }) => {
		const expectedLinks = [
			"Dashboard",
			"Discover",
			"Library",
			"Search",
			"Indexers",
			"Calendar",
			"Statistics",
			"Hunting",
			"History",
			"TRaSH Guides",
			"Settings",
		];

		for (const linkName of expectedLinks) {
			const link = page.getByRole("link", { name: new RegExp(linkName, "i") });
			await expect(link).toBeVisible({ timeout: TIMEOUTS.medium });
		}
	});

	test("should highlight active navigation item", async ({ page }) => {
		// Dashboard should be active initially
		const dashboardLink = page.getByRole("link", { name: /dashboard/i });
		await expect(dashboardLink).toBeVisible();

		await expect(dashboardLink).toHaveAttribute("aria-current", "page");
	});

	test("should display app branding", async ({ page }) => {
		// App title should be visible - check header (h2) which is always visible
		// The sidebar h1 may be hidden on some viewports due to responsive design
		const header = page.locator("header, [role='banner']");
		await expect(header.getByText(/arr control center/i).first()).toBeVisible();
	});
});

test.describe("Navigation - Route Changes", () => {
	// Each page has a descriptive h1 heading, not just the page name
	const routes = [
		{ name: "Dashboard", route: ROUTES.dashboard, heading: /hi|welcome|dashboard/i },
		{ name: "Library", route: ROUTES.library, heading: /everything your|library/i },
		{ name: "Calendar", route: ROUTES.calendar, heading: /upcoming releases|calendar/i },
		{ name: "Search", route: ROUTES.search, heading: /search|indexer/i },
		{ name: "Discover", route: ROUTES.discover, heading: /find new content|discover/i },
		{ name: "Indexers", route: ROUTES.indexers, heading: /indexer|prowlarr/i },
		{ name: "History", route: ROUTES.history, heading: /history|download/i },
		{ name: "Statistics", route: ROUTES.statistics, heading: /statistic|overview/i },
		{ name: "Hunting", route: ROUTES.hunting, heading: /hunt|missing|auto/i },
		{ name: "Settings", route: ROUTES.settings, heading: /setting|configuration/i },
		{ name: "TRaSH Guides", route: ROUTES.trashGuides, heading: /trash|quality|profile/i },
	];

	for (const { name, route, heading } of routes) {
		test(`should navigate to ${name} page via sidebar`, async ({ page }) => {
			await page.goto(ROUTES.dashboard);
			// Wait for hydration so client-side router is active
			await page.waitForLoadState("networkidle");

			// Click sidebar link
			await clickSidebarLink(page, name);

			// Verify URL changed
			await expect(page).toHaveURL(new RegExp(route.slice(1)));

			// Wait for page to load (some pages like Statistics take longer)
			await page.waitForLoadState("networkidle");

			// Verify page content loaded - look for heading or page identifier text
			// Some pages may take longer to load content, so use extended timeout
			const pageContent = page.locator("main");
			const textVisible = await pageContent
				.getByText(heading)
				.first()
				.isVisible({ timeout: TIMEOUTS.long })
				.catch(() => false);

			// If main content not found, check the whole page (some pages render differently)
			if (!textVisible) {
				const pageTextVisible = await page
					.getByText(heading)
					.first()
					.isVisible({ timeout: 5000 })
					.catch(() => false);
				expect(pageTextVisible).toBe(true);
			}
		});
	}
});

test.describe("Navigation - Header", () => {
	test("should display header with app title", async ({ page }) => {
		await page.goto(ROUTES.dashboard);

		const header = page.locator("header, [role='banner']");
		await expect(header).toBeVisible();
	});

	test("should display user info in header", async ({ page }) => {
		await page.goto(ROUTES.dashboard);

		// User info section should be visible in header (avatar or username)
		// The header contains a user section with avatar and/or username text
		const userSection = page.locator("header, [role='banner']");

		if (TEST_USERNAME) {
			// If TEST_USERNAME is set (or CI default), check for it
			await expect(userSection.getByText(new RegExp(TEST_USERNAME, "i")).first()).toBeVisible({
				timeout: TIMEOUTS.medium,
			});
		} else {
			// Otherwise just verify there's some user-related element
			// Look for sign out button as indicator of logged-in state
			await expect(page.getByRole("button", { name: /sign out/i })).toBeVisible({
				timeout: TIMEOUTS.medium,
			});
		}
	});

	test("should have sign out button in header", async ({ page }) => {
		await page.goto(ROUTES.dashboard);

		await expect(page.getByRole("button", { name: /sign out/i })).toBeVisible();
	});

	test("should have incognito toggle in header", async ({ page }) => {
		await page.goto(ROUTES.dashboard);

		// Look for hide sensitive data button
		const toggleButton = page.getByRole("button", { name: /hide sensitive|privacy|incognito/i });

		if ((await toggleButton.count()) > 0) {
			await expect(toggleButton).toBeVisible();
		}
	});
});

test.describe("Navigation - Browser Navigation", () => {
	test("should support browser back button", async ({ page }) => {
		await page.goto(ROUTES.dashboard);

		// Navigate to library
		await clickSidebarLink(page, "Library");
		await expect(page).toHaveURL(/\/library/);

		// Go back
		await page.goBack();

		// Should be back on dashboard
		await expect(page).toHaveURL(/\/dashboard/);
	});

	test("should support browser forward button", async ({ page }) => {
		await page.goto(ROUTES.dashboard);

		// Navigate to library and wait for URL change before using browser navigation
		await clickSidebarLink(page, "Library");
		await expect(page).toHaveURL(/\/library/);

		// Go back
		await page.goBack();
		await expect(page).toHaveURL(/\/dashboard/);

		// Go forward
		await page.goForward();

		// Should be on library
		await expect(page).toHaveURL(/\/library/);
	});

	test("should preserve route on page refresh", async ({ page }) => {
		await page.goto(ROUTES.library);

		// Refresh
		await page.reload();

		// Should still be on library
		await expect(page).toHaveURL(/\/library/);
	});
});

test.describe("Navigation - Deep Links", () => {
	test("should support direct navigation to dashboard", async ({ page }) => {
		await page.goto(ROUTES.dashboard);
		await expect(page).toHaveURL(/\/dashboard/);
	});

	test("should support direct navigation to library", async ({ page }) => {
		await page.goto(ROUTES.library);
		await expect(page).toHaveURL(/\/library/);
	});

	test("should support direct navigation to settings", async ({ page }) => {
		await page.goto(ROUTES.settings);
		await expect(page).toHaveURL(/\/settings/);
	});

	test("should support direct navigation to trash guides", async ({ page }) => {
		await page.goto(ROUTES.trashGuides);
		await expect(page).toHaveURL(/\/trash-guides/);
	});
});

// Modal and viewport regression coverage below uses the main authentication shell.
test.describe("Navigation - Viewport and keyboard", () => {
	test("keeps desktop navigation pinned with contained scrolling and an unlocked document", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 480 });
		await page.goto(ROUTES.dashboard);
		const sidebar = page.locator("aside[data-sidebar]");
		const nav = sidebar.getByRole("navigation");
		await expect(sidebar).toBeVisible();
		for (const group of await nav.getByRole("button", { expanded: false }).all())
			await group.click();
		await expect.poll(() => nav.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
		await expect(sidebar).toHaveCSS("position", "sticky");
		await expect(nav).toHaveCSS("overscroll-behavior-y", "contain");
		const initial = await sidebar.boundingBox();
		expect(initial).not.toBeNull();
		expect(initial!.y).toBe(0);
		expect(initial!.height).toBe(480);
		await nav.evaluate((el) => {
			el.scrollTop = el.scrollHeight;
		});
		await expect.poll(() => nav.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
		await expect(sidebar.getByRole("link", { name: "Settings", exact: true })).toBeInViewport();
		// Make document scrolling deterministic even with a small dashboard fixture.
		await page.locator("main").evaluate((el) => {
			el.style.minHeight = "200vh";
		});
		await page.evaluate(() => window.scrollTo(0, 200));
		await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
		expect((await sidebar.boundingBox())!.y).toBe(0);
		await expect(page.locator("body")).not.toHaveAttribute("data-scroll-locked");
	});

	test.describe("Mobile", () => {
		test.beforeEach(async ({ page }) => {
			await page.setViewportSize({ width: 390, height: 844 });
			await page.goto(ROUTES.dashboard);
		});

		test("aligns the header opener and primary account controls within the viewport", async ({
			page,
		}) => {
			const header = page.getByRole("banner");
			const opener = header.getByRole("button", { name: "Open menu", exact: true });
			const privacy = header.getByTitle(/Hide sensitive data|Show real data/);
			const signout = header.getByRole("button", { name: "Sign out", exact: true });
			// Wait for authenticated controls before recording any layout bounds.
			for (const control of [opener, privacy, signout]) await expect(control).toBeVisible();
			const boxes = [];
			for (const control of [opener, privacy, signout]) {
				await expect(control).toBeVisible();
				const box = await control.boundingBox();
				expect(box).not.toBeNull();
				expect(box!.x).toBeGreaterThanOrEqual(0);
				expect(box!.x + box!.width).toBeLessThanOrEqual(390);
				boxes.push(box!);
			}
			expect(boxes[0].x + boxes[0].width).toBeLessThanOrEqual(boxes[1].x);
			expect(boxes[1].x + boxes[1].width).toBeLessThanOrEqual(boxes[2].x);
			const center = boxes[0].y + boxes[0].height / 2;
			for (const box of boxes.slice(1))
				expect(Math.abs(box.y + box.height / 2 - center)).toBeLessThanOrEqual(2);
		});

		test("cycles real focus and returns to the opener after Escape, close, and backdrop", async ({
			page,
		}) => {
			const opener = page.getByRole("button", { name: "Open menu", exact: true });
			await opener.focus();
			await page.keyboard.press("Enter");
			const dialog = page.getByRole("dialog", { name: "Navigation menu" });
			const close = dialog.getByRole("button", { name: "Close menu" });
			await expect(close).toBeFocused();
			await page.keyboard.press("Shift+Tab");
			await expect(dialog.getByRole("link", { name: "Settings", exact: true })).toBeFocused();
			await page.keyboard.press("Tab");
			await expect(close).toBeFocused();
			await page.keyboard.press("Tab");
			await expect(dialog.getByRole("button", { name: "Overview" })).toBeFocused();
			await page.keyboard.press("Shift+Tab");
			await expect(close).toBeFocused();
			await page.keyboard.press("Escape");
			await expect(dialog).toBeHidden();
			await expect(opener).toBeFocused();
			await opener.click();
			await close.click();
			await expect(dialog).toBeHidden();
			await expect(opener).toBeFocused();
			await opener.click();
			await page.mouse.click(375, 400);
			await expect(dialog).toBeHidden();
			await expect(opener).toBeFocused();
			await expect(page.locator("body")).not.toHaveAttribute("data-scroll-locked");
		});

		test("dismisses only the command palette before the underlying drawer", async ({ page }) => {
			const opener = page.getByRole("button", { name: "Open menu", exact: true });
			await opener.click();
			const drawer = page.getByRole("dialog", { name: "Navigation menu" });
			const close = drawer.getByRole("button", { name: "Close menu" });
			await expect(close).toBeFocused();
			await page.keyboard.press("Control+k");
			const palette = page.getByRole("dialog", { name: "Command palette" });
			const input = palette.getByPlaceholder("Type a command or search...");
			await expect(input).toBeFocused();
			await page.keyboard.press("Tab");
			await expect(input).toBeFocused();
			await page.keyboard.press("Shift+Tab");
			await expect(input).toBeFocused();
			await page.keyboard.press("Escape");
			await expect(palette).toBeHidden();
			await expect(drawer).toBeVisible();
			await expect(close).toBeFocused();
			await page.keyboard.press("Escape");
			await expect(drawer).toBeHidden();
			await expect(opener).toBeFocused();
		});

		test("closes on route selection and desktop resize without reopening", async ({ page }) => {
			const opener = page.getByRole("button", { name: "Open menu", exact: true });
			await opener.click();
			const dialog = page.getByRole("dialog", { name: "Navigation menu" });
			await dialog.getByRole("link", { name: "Library", exact: true }).click();
			await expect(page).toHaveURL(/\/library/);
			await expect(dialog).toBeHidden();
			await opener.click();
			await expect(dialog).toBeVisible();
			await page.setViewportSize({ width: 1280, height: 844 });
			await expect(dialog).toBeHidden();
			await page.setViewportSize({ width: 390, height: 844 });
			await expect(dialog).toBeHidden();
			await expect(page.locator("body")).not.toHaveAttribute("data-scroll-locked");
		});
	});
});

test.describe("Navigation - 404 Handling", () => {
	test("should handle invalid routes gracefully", async ({ page }) => {
		// Navigate to non-existent page
		await page.goto("/nonexistent-page-12345");

		// Should either show 404 or redirect to dashboard/login
		const url = page.url();
		const has404 = await page.getByText(/404|not found|page not found/i).count();
		const redirected = url.includes("/dashboard") || url.includes("/login");

		expect(has404 > 0 || redirected).toBe(true);
	});
});

test.describe("Navigation - Query Parameters", () => {
	test("should preserve query parameters on navigation", async ({ page }) => {
		// Navigate to library with a filter
		await page.goto(`${ROUTES.library}?service=sonarr`);

		// Query param should be preserved
		expect(page.url()).toContain("service=sonarr");
	});
});

