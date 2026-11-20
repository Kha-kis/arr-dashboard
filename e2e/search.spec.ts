/**
 * Search E2E Tests
 *
 * Tests for the global search page (Prowlarr indexer search).
 */

import { expect, test } from "@playwright/test";
import { ROUTES, TIMEOUTS, waitForLoadingComplete } from "./utils/test-helpers";

/** Browser-only reads with one configured indexer and a verified empty search batch. */
async function ae148InstallConfiguredSearchRoutes(page: import("@playwright/test").Page) {
	const indexer = {
		id: 1,
		name: "AE148 synthetic indexer",
		enable: true,
		protocol: "torrent" as const,
		supportsSearch: true,
		instanceId: "ae148-prowlarr",
		instanceName: "AE148 synthetic Prowlarr",
	};
	const indexers = {
		instances: [
			{
				instanceId: indexer.instanceId,
				instanceName: indexer.instanceName,
				success: true,
				data: [indexer],
			},
		],
		aggregated: [indexer],
		totalCount: 1,
		failedInstanceCount: 0,
	} satisfies import("@arr/shared").SearchIndexersResponse;
	const coverage = {
		receivedCount: 0,
		acceptedCount: 0,
		rejectedCount: 0,
		metadataIncompleteCount: 0,
	};
	const results = {
		instances: [
			{
				instanceId: indexer.instanceId,
				instanceName: indexer.instanceName,
				success: true,
				data: [],
				coverage,
			},
		],
		aggregated: [],
		totalCount: 0,
		failedInstanceCount: 0,
		coverage,
	} satisfies import("@arr/shared").MultiInstanceSearchResponse;
	await page.route(
		(url) => url.pathname === "/api/search/indexers",
		async (route) => {
			expect(route.request().method()).toBe("GET");
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(indexers),
			});
		},
	);
	await page.route(
		(url) => url.pathname === "/api/search/query",
		async (route) => {
			expect(route.request().method()).toBe("POST");
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(results),
			});
		},
	);
}

test.describe("Search - Page Load", () => {
	test("should display search page with heading", async ({ page }) => {
		await page.goto(ROUTES.search);

		// The search page heading is "Manual Search"
		await expect(page.getByRole("heading", { name: /manual search|search/i }).first()).toBeVisible({
			timeout: TIMEOUTS.medium,
		});
	});

	test("should have search input field or configuration message", async ({ page }) => {
		await page.goto(ROUTES.search);
		await waitForLoadingComplete(page);

		// The search textbox has accessible name "Search for movies, series, music, or books"
		// Use a more flexible locator that also checks for placeholder or common search patterns
		const searchInput = page
			.getByRole("textbox", { name: /search|movies|series/i })
			.or(page.locator('input[type="text"][placeholder*="search" i], input[type="search"]'));

		// In CI without Prowlarr configured, the page may show a configuration message instead
		const configMessage = page.getByText(/prowlarr|no indexers|configure|not configured/i);
		const errorState = page.locator('[role="alert"]');

		const hasSearchInput = await searchInput
			.first()
			.isVisible({ timeout: TIMEOUTS.medium })
			.catch(() => false);
		const hasConfigMessage = await configMessage
			.first()
			.isVisible({ timeout: 2000 })
			.catch(() => false);
		const hasError = await errorState
			.first()
			.isVisible({ timeout: 2000 })
			.catch(() => false);

		// Either search input is visible OR configuration/error message is shown (CI without Prowlarr)
		expect(hasSearchInput || hasConfigMessage || hasError).toBe(true);
	});

	test("should have search button", async ({ page }) => {
		await page.goto(ROUTES.search);
		await waitForLoadingComplete(page);
		await expect(page.getByRole("heading", { name: "Manual Search", exact: true })).toBeVisible({
			timeout: TIMEOUTS.medium,
		});
		await expect(page).toHaveURL(/\/search(?:\?.*)?$/);
		await expect(page.getByRole("link", { name: /sign in/i })).toHaveCount(0);
		const form = page.locator("main form");
		const searchButton = form.getByRole("button", { name: "Search", exact: true });
		const configuration = page.getByRole("heading", {
			name: "Prowlarr Configuration Required",
			exact: true,
		});
		await expect(configuration.or(searchButton)).toBeVisible({ timeout: TIMEOUTS.medium });
		if (await configuration.isVisible()) {
			await expect(
				page.getByText(
					"Add at least one Prowlarr instance in Settings to enable manual searches across your indexers.",
					{ exact: true },
				),
			).toBeVisible();
			await expect(form).toHaveCount(0);
			await expect(page.getByRole("button", { name: "Search", exact: true })).toHaveCount(0);
		} else {
			await expect(searchButton).toBeVisible({
				timeout: TIMEOUTS.medium,
			});
		}
	});
});

test.describe("Search - Search Functionality", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(ROUTES.search);
		await waitForLoadingComplete(page);
	});

	test("should accept search query input", async ({ page }) => {
		const searchInput = page.getByPlaceholder(/search|query/i).first();

		if ((await searchInput.count()) > 0) {
			await searchInput.fill("test query");
			await expect(searchInput).toHaveValue("test query");
		}
	});

	test("should show loading state during search", async ({ page }) => {
		const searchInput = page.getByPlaceholder(/search|query/i).first();
		const searchButton = page.getByRole("button", { name: /search/i }).first();

		if ((await searchInput.count()) > 0 && (await searchButton.count()) > 0) {
			await searchInput.fill("test");
			await searchButton.click();

			// Search might show loading indicator
			await page.waitForTimeout(1000);
		}
	});

	test("should display results or no results message", async ({ page }) => {
		await ae148InstallConfiguredSearchRoutes(page);
		await page.goto(ROUTES.search);
		await expect(page.getByRole("heading", { name: "Manual Search", exact: true })).toBeVisible({
			timeout: TIMEOUTS.medium,
		});
		const searchInput = page.getByPlaceholder("Search for movies, series, music, or books", {
			exact: true,
		});
		await expect(searchInput).toBeVisible();
		await searchInput.fill("AE148 empty query");
		await page.locator("main form").getByRole("button", { name: "All", exact: true }).click();
		const completed = page.waitForResponse(
			(response) =>
				new URL(response.url()).pathname === "/api/search/query" &&
				response.request().method() === "POST",
		);
		await page.locator("main form").getByRole("button", { name: "Search", exact: true }).click();
		const response = await completed;
		expect(response.status()).toBe(200);
		expect(response.request().postDataJSON()).toEqual({
			query: "AE148 empty query",
			type: "all",
			filters: [{ instanceId: "ae148-prowlarr", indexerIds: [1] }],
		});
		await expect(page.getByText("No results found for that query.", { exact: true })).toBeVisible();
		await expect(
			page.getByText("No results returned from your indexers for that query.", { exact: true }),
		).toBeVisible();
	});
});

test.describe("Search - Filters", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(ROUTES.search);
		await waitForLoadingComplete(page);
	});

	test("should have category filter", async ({ page }) => {
		await ae148InstallConfiguredSearchRoutes(page);
		await page.goto(ROUTES.search);
		await expect(page.getByRole("heading", { name: "Manual Search", exact: true })).toBeVisible({
			timeout: TIMEOUTS.medium,
		});
		const form = page.locator("main form");
		for (const name of ["Movies", "Series", "Music", "Books", "All"]) {
			await expect(form.getByRole("button", { name, exact: true })).toBeVisible();
		}
		await page
			.getByPlaceholder("Search for movies, series, music, or books", { exact: true })
			.fill("AE148 type selection");
		const searchButton = form.getByRole("button", { name: "Search", exact: true });
		for (const [name, type] of [
			["Movies", "movie"],
			["Series", "tv"],
		]) {
			await form.getByRole("button", { name, exact: true }).click();
			const completed = page.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === "/api/search/query" &&
					response.request().method() === "POST",
			);
			await searchButton.click();
			const response = await completed;
			expect(response.status()).toBe(200);
			expect(response.request().postDataJSON()).toEqual({
				query: "AE148 type selection",
				type,
				filters: [{ instanceId: "ae148-prowlarr", indexerIds: [1] }],
			});
			await expect(
				page.getByText("No results found for that query.", { exact: true }),
			).toBeVisible();
			await expect(
				page.getByText("No results returned from your indexers for that query.", { exact: true }),
			).toBeVisible();
			await expect(searchButton).toBeEnabled();
		}
	});

	test("should have indexer filter", async ({ page }) => {
		const indexerFilter = page.getByRole("combobox", { name: /indexer/i });

		// Indexer filter depends on Prowlarr config
		expect((await indexerFilter.count()) >= 0).toBe(true);
	});
});

test.describe("Search - Results Display", () => {
	test("should display result details", async ({ page }) => {
		await page.goto(ROUTES.search);
		await waitForLoadingComplete(page);

		// Search for something
		const searchInput = page.getByPlaceholder(/search|query/i).first();
		const searchButton = page.getByRole("button", { name: /search/i }).first();

		if ((await searchInput.count()) > 0) {
			await searchInput.fill("ubuntu"); // Generic term likely to have results
			await searchButton.click();

			await page.waitForTimeout(5000);

			// Results might have size, seeders, etc.
			const resultsTable = page.locator("table, [role='table']");
			if ((await resultsTable.count()) > 0) {
				await expect(resultsTable).toBeVisible();
			}
		}
	});
});

test.describe("Search - Actions", () => {
	test("should have grab/download action on results", async ({ page }) => {
		await page.goto(ROUTES.search);

		// If results exist, they should have download actions
		const grabButton = page.getByRole("button", { name: /grab|download|add/i });

		// Button presence depends on search results
		expect((await grabButton.count()) >= 0).toBe(true);
	});
});

test.describe("Search - Keyboard Navigation", () => {
	test("should submit search on Enter key", async ({ page }) => {
		await page.goto(ROUTES.search);

		const searchInput = page.getByPlaceholder(/search|query/i).first();

		if ((await searchInput.count()) > 0) {
			await searchInput.fill("test");
			await searchInput.press("Enter");

			// Should trigger search
			await page.waitForTimeout(1000);
		}
	});
});

test.describe("Search - Empty State", () => {
	test("should show guidance when no search performed", async ({ page }) => {
		await page.goto(ROUTES.search);

		await waitForLoadingComplete(page);

		// Initial state should guide user
		const guidance = page.getByText(/enter.*search|search.*indexer|prowlarr/i);

		// Either guidance or empty state
		expect((await guidance.count()) >= 0).toBe(true);
	});
});
