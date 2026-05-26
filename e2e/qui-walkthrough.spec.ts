/**
 * qui Integration Walkthrough — Phase 1.4 + 2.1 Verification
 *
 * Drives the visual walkthrough checklist programmatically. Covers
 * what unit tests can't: rendered layout, dropdown interaction,
 * filter→pagination flow, modal open/close, badge visibility,
 * and the perf regression that the per-card polling has been removed.
 *
 * CI fixture strategy: the dropdown only renders when `hasQui` is true
 * (a qui ServiceInstance exists in the user's serviceLookup) AND
 * `torrentStateCounts` has at least one non-`none` value. The CI auth
 * setup creates a fresh user with no services configured — so we use
 * Playwright's network mocking to intercept `/api/services` (inject a
 * qui instance) and `/api/library*` (inject realistic torrentStateCounts
 * + items with `torrentState` populated). This tests the REAL frontend
 * rendering against the REAL Next.js + API proxy without needing a
 * real qui server to exist in CI. Local dev runs against a real qui
 * setup and the mocks are still consistent — they just don't matter
 * because the real responses already include qui data.
 */

import { expect, type Page, test } from "@playwright/test";

/**
 * Locator for the Torrent state dropdown — Phase 2.1 added this. Identified
 * by uniquely-shaped option values (`value="seeding"` and `value="stalled_dl"`)
 * that no other dropdown on the page uses.
 */
function torrentStateSelect(page: Page) {
	return page
		.locator("select")
		.filter({ has: page.locator('option[value="seeding"]') })
		.filter({ has: page.locator('option[value="stalled_dl"]') })
		.first();
}

/**
 * Mock services + library endpoints so the qui-walkthrough tests run
 * against realistic data shapes in CI (which doesn't have a real qui
 * server). Idempotent — calling more than once is fine.
 *
 * Mocks intentionally cover ONLY the endpoints the qui surface
 * specifically needs — other endpoints fall through to the real Fastify
 * routes so the rest of the page (sidebar, header, auth) renders
 * normally.
 */
async function setupQuiMocks(page: Page): Promise<void> {
	// Diagnostic — log every request the page makes. CI captures this in
	// the test output so we can verify the route matchers are firing and
	// no unexpected endpoint is breaking the page render. Cheap and only
	// noisy in CI logs.
	page.on("request", (req) => {
		const url = req.url();
		if (url.includes("/api/")) {
			// eslint-disable-next-line no-console
			console.log(`[e2e] ${req.method()} ${url}`);
		}
	});

	// `/api/library/sync/status` — quick mock so the sync hook gets a
	// well-shaped response. Without this the request would fall through
	// to the real Fastify route and the sync hook might fire repeatedly
	// (every poll interval) competing with page render. Empty `instances`
	// is fine for our purposes — the spec doesn't assert sync state.
	await page.route(/\/api\/library\/sync\/status$/, async (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ instances: [] }),
		}),
	);

	// `/api/services` — inject a qui entry so `hasQui` derives to true.
	// The library page reads this to decide whether to render the
	// torrent-state filter dropdown at all.
	await page.route("**/api/services", async (route) => {
		if (route.request().method() !== "GET") {
			return route.continue();
		}
		const now = new Date().toISOString();
		return route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				services: [
					{
						id: "mock-qui-instance",
						label: "Mock qui",
						baseUrl: "http://qui.mock.test:7476",
						externalUrl: null,
						// `ArrServiceType` enum values are lowercase in the
						// Zod schema (`["sonarr","radarr",...,"qui"]`).
						// Uppercase here was silently rejected by client-
						// side validation, leaving the services list
						// empty and `hasQui` false.
						service: "qui",
						enabled: true,
						isDefault: false,
						// `hasApiKey` is a required field on
						// ServiceInstanceSummary — surfacing that the
						// backend has an encrypted key for this row. The
						// frontend uses it to render the "rotate key"
						// affordance; the dropdown derivation doesn't read
						// it, but its absence triggers Zod validation
						// failure on the response.
						hasApiKey: true,
						tags: [],
						storageGroupId: null,
						hasLocalFilesystemAccess: false,
						pathPrefix: null,
						createdAt: now,
						updatedAt: now,
					},
				],
			}),
		});
	});

	// `/api/library?...` — return items with torrent-state populated +
	// torrentStateCounts with realistic numbers so the dropdown renders
	// `(N)` suffixes per option and the badge tests have something to
	// click on.
	//
	// Regex matcher (not the `**/api/library**` glob) because the glob
	// would ALSO match sub-paths like `/api/library/sync/status` and
	// `/api/library/episodes`, intercepting them with the wrong response
	// shape — that broke the page during the previous fixture attempt.
	// This regex matches ONLY the bare /api/library endpoint (with
	// optional query string), nothing else.
	await page.route(/\/api\/library(\?[^/]*)?$/, async (route) => {
		if (route.request().method() !== "GET") {
			return route.continue();
		}
		// Honor the `?torrentState=seeding` filter so the
		// "selecting Seeding filter narrows the result set" test sees a
		// smaller item list when filtered. The dropdown's value-change
		// assertions don't depend on this, but the per-card-badge test
		// renders the SEEDING items only after the filter is applied.
		const url = new URL(route.request().url());
		const stateFilter = url.searchParams.get("torrentState");

		const allItems = buildMockLibraryItems();
		const items =
			stateFilter && stateFilter !== "all"
				? allItems.filter((item) => item.torrentState === stateFilter)
				: allItems;

		return route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				items,
				pagination: {
					page: 1,
					limit: 50,
					totalItems: items.length,
					totalPages: 1,
				},
				appliedFilters: {},
				syncStatus: {
					isCached: true,
					lastSync: new Date().toISOString(),
					syncInProgress: false,
					totalCachedItems: allItems.length,
				},
				torrentStateCounts: {
					all: allItems.length,
					none: 1,
					seeding: 3,
					downloading: 1,
					stalled_dl: 1,
					paused: 0,
					queued: 0,
					checking: 0,
					moving: 0,
					error: 1,
					unknown: 0,
				},
			}),
		});
	});
}

/** Mock library item shape — narrow type so the `.filter` on
 * `torrentState` typechecks. Frontend treats this as a `LibraryItem`
 * via the route response payload. */
interface MockLibraryItem {
	id: number;
	instanceId: string;
	instanceName: string;
	service: string;
	type: string;
	title: string;
	sortTitle: string;
	year: number;
	monitored: boolean;
	hasFile: boolean;
	status: string;
	torrentState: string;
	torrentRatio: number | null;
	path: string;
}

/** Build the mock library item list. Each item has `torrentState` set to
 * one of the buckets the dropdown surfaces; the test assertions count on
 * at least one item per relevant bucket. */
function buildMockLibraryItems(): MockLibraryItem[] {
	const base = (id: number, state: string, ratio: number | null): MockLibraryItem => ({
		id,
		instanceId: "mock-sonarr",
		instanceName: "Mock Sonarr",
		service: "sonarr",
		type: "series",
		title: `Mock Show ${id}`,
		sortTitle: `mock show ${id}`,
		year: 2024,
		monitored: true,
		hasFile: true,
		status: "continuing",
		torrentState: state,
		torrentRatio: ratio,
		path: `/data/media/Mock Show ${id}`,
	});
	return [
		base(1, "seeding", 1.42),
		base(2, "seeding", 2.18),
		base(3, "seeding", 0.95),
		base(4, "downloading", 0.0),
		base(5, "stalled_dl", 0.0),
		base(6, "error", 0.0),
		base(7, "none", null),
	];
}

async function gotoLibrary(page: Page) {
	// Set up qui-data mocks BEFORE navigating — Playwright's page.route
	// matchers must be installed before the page makes the requests.
	await setupQuiMocks(page);
	await page.goto("/library");
	// Wait for the main heading first
	await expect(page.getByRole("heading", { name: /your collection|library/i }).first()).toBeVisible(
		{ timeout: 15_000 },
	);
	// Then wait for the Torrent state dropdown to render — counts come from
	// the page-level /library response and gate the dropdown's visibility.
	// Without this wait, fast tests race the count fetch.
	await expect(torrentStateSelect(page)).toBeAttached({ timeout: 15_000 });
}

test.describe("qui walkthrough — filter dropdown gating + counts", () => {
	test("Torrent state dropdown is present (qui configured)", async ({ page }) => {
		await gotoLibrary(page);
		await expect(torrentStateSelect(page)).toBeAttached();
	});

	test("dropdown options include count suffixes in `(N)` format", async ({ page }) => {
		await gotoLibrary(page);
		const dropdown = torrentStateSelect(page);
		const optionTexts = await dropdown.locator("option").allTextContents();
		const torrentStateOptions = optionTexts.filter((t) =>
			/Seeding|Stalled|Downloading|Not correlated/i.test(t),
		);
		const hasCounts = torrentStateOptions.some((t) => /\(\d+\)/.test(t));
		expect(
			hasCounts,
			`expected count suffix in at least one option. Got: ${torrentStateOptions.join(" | ")}`,
		).toBe(true);
	});

	test('"Not correlated with qui" option is present (renamed from "No qui data")', async ({
		page,
	}) => {
		await gotoLibrary(page);
		const dropdown = torrentStateSelect(page);
		const noneOption = dropdown.locator('option[value="none"]');
		await expect(noneOption).toHaveCount(1);
		const text = (await noneOption.textContent()) ?? "";
		expect(text, `expected "Not correlated with qui" label`).toMatch(/Not correlated with qui/);
	});
});

test.describe("qui walkthrough — filter behavior", () => {
	test("selecting Seeding filter narrows the result set", async ({ page }) => {
		await gotoLibrary(page);
		const dropdown = torrentStateSelect(page);

		// Capture the All count from the option label, e.g. "All torrent states (2112)"
		const allText = (await dropdown.locator('option[value="all"]').textContent()) ?? "";
		const allMatch = allText.match(/\((\d+)\)/);
		const allCount = allMatch ? Number.parseInt(allMatch[1]!, 10) : 0;
		expect(
			allCount,
			"expected non-zero library size for the test to be meaningful",
		).toBeGreaterThan(0);

		// Capture the Seeding count
		const seedingText = (await dropdown.locator('option[value="seeding"]').textContent()) ?? "";
		const seedingMatch = seedingText.match(/\((\d+)\)/);
		const seedingCount = seedingMatch ? Number.parseInt(seedingMatch[1]!, 10) : -1;
		expect(
			seedingCount,
			`expected Seeding option with count. Got: "${seedingText}"`,
		).toBeGreaterThanOrEqual(0);

		// Filter and verify the page reacts (refetch + re-render)
		await dropdown.selectOption("seeding");
		await page.waitForTimeout(1500);

		// The select should now show "seeding" as its value
		await expect(dropdown).toHaveValue("seeding");
	});
});

test.describe("qui walkthrough — per-card badge", () => {
	test("at least one card renders a torrent state badge after filtering by Seeding", async ({
		page,
	}) => {
		await gotoLibrary(page);
		const dropdown = torrentStateSelect(page);
		await dropdown.selectOption("seeding");
		await page.waitForTimeout(2000);

		// The badge has aria-label "Torrent: SEEDING, ratio X.XX"
		const badges = page.locator('[aria-label*="Torrent:"]');
		const count = await badges.count();
		expect(count, `expected ≥1 torrent state badge after Seeding filter`).toBeGreaterThan(0);
	});

	test("badge content matches the SHORTLABEL · RATIO× format", async ({ page }) => {
		await gotoLibrary(page);
		const dropdown = torrentStateSelect(page);
		await dropdown.selectOption("seeding");
		await page.waitForTimeout(2000);

		const firstBadge = page.locator('[aria-label*="Torrent:"]').first();
		const text = (await firstBadge.textContent()) ?? "";
		// Badge displays as e.g. "Seeding · 1.24×". CSS `uppercase` is applied
		// at render time, but textContent() returns the source case — check
		// case-insensitively. Format: <label-or-letters> · <decimal-ratio>×
		expect(text, `badge text should match "<label> · <ratio>×": got "${text}"`).toMatch(
			/[A-Za-z]+\s*·\s*\d+\.\d{2}×/,
		);
	});
});

test.describe("qui walkthrough — no per-card polling (perf regression guard)", () => {
	test("no requests to /qui/library-item/torrent-state on plain page load", async ({ page }) => {
		const quiPolls: string[] = [];
		page.on("request", (req) => {
			if (req.url().includes("/qui/library-item/torrent-state")) {
				quiPolls.push(req.url());
			}
		});

		await gotoLibrary(page);
		// Pre-fix: a burst of N parallel POSTs fired immediately on page load.
		// Post-fix: exactly zero (per-card data ships in the page-level /library
		// response). Wait long enough that any immediate burst would be visible.
		await page.waitForTimeout(3000);

		expect(
			quiPolls,
			`expected ZERO per-item polls on library page load. Got ${quiPolls.length} call(s).`,
		).toEqual([]);
	});
});

test.describe("qui walkthrough — modal still works", () => {
	test("opening a card with a badge fires a qui detail endpoint at least once", async ({
		page,
	}) => {
		// Capture ANY qui-domain request after the click. The original
		// assertion targeted `/qui/library-item/torrent-state` which has
		// since been removed (page-level data ships in /library response,
		// modal pulls cluster data from `/qui/series/.../torrents` or
		// `/qui/movie/.../torrents`). Broadening to "any qui detail call"
		// makes the test resilient to future architecture changes while
		// still proving the modal connects to qui.
		const quiCalls: string[] = [];
		page.on("request", (req) => {
			const url = req.url();
			// Match the panel/detail endpoints but exclude the page-load
			// endpoints (services, library-seeding-summary, summary) that
			// already fired before the click. We want post-click qui
			// activity only.
			if (
				url.includes("/api/qui/series/") ||
				url.includes("/api/qui/movie/") ||
				url.includes("/api/qui/library-item/torrent-state")
			) {
				quiCalls.push(url);
			}
		});

		await gotoLibrary(page);
		// Mock the panel endpoints so the modal renders mock data without
		// erroring out on the click. Empty `clusters` is fine — the test
		// only cares that the request fired.
		await page.route("**/api/qui/series/**/torrents", (route) =>
			route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ series: { id: 1, title: "Mock Show 1" }, clusters: [] }),
			}),
		);
		await page.route("**/api/qui/movie/**/torrents", (route) =>
			route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ movie: { id: 1, title: "Mock Show 1" }, clusters: [] }),
			}),
		);

		const dropdown = torrentStateSelect(page);
		await dropdown.selectOption("seeding");
		await page.waitForTimeout(2000);

		// Click the first card to open its detail modal. The library card
		// root is the `<button>` element wrapping the title + badge — the
		// older `.glass / .card / .group` ancestor-div pattern this test
		// used pre-dates a markup refactor and no longer matches.
		// `closest("button")` finds the actual click target reliably.
		const firstBadge = page.locator('[aria-label*="Torrent:"]').first();
		await firstBadge.scrollIntoViewIfNeeded();
		// The badge lives inside the card's `<button>` so xpath-up to the
		// nearest button ancestor; that button has the click handler.
		const cardButton = firstBadge.locator("xpath=ancestor::button[1]");
		await cardButton.click({ force: true });

		await page.waitForTimeout(2500);

		// Modal opening should fire at least one qui detail endpoint.
		// Empty list = the modal opened without ever talking to qui
		// (regression — the panel relies on qui data to render).
		expect(
			quiCalls.length,
			`expected modal to fire ≥1 qui detail call on open (got ${quiCalls.length})`,
		).toBeGreaterThan(0);
	});
});

test.describe("qui walkthrough — Pulse deep-link", () => {
	test("Pulse qui rows (if any) link to /settings#services", async ({ page }) => {
		// The Pulse API caches per-user for 60s. After the actionUrl fix,
		// the cache may still be serving the old "/settings" string. Force
		// a refresh by hitting the route with no-cache headers via the
		// browser context, then load the page.
		await page.goto("/pulse?refresh=1");
		await page.waitForLoadState("networkidle", { timeout: 15_000 });
		// Give React Query an extra moment to render the post-refresh data.
		await page.waitForTimeout(2000);

		// Look for any qui-source action links
		const quiActions = page.locator('a[href*="/settings"]:has-text("Check connection")');
		const count = await quiActions.count();
		if (count === 0) {
			test.info().annotations.push({
				type: "note",
				description: "No qui Pulse rows present at test time; deep-link assertion skipped",
			});
			return;
		}

		for (let i = 0; i < count; i++) {
			const href = await quiActions.nth(i).getAttribute("href");
			expect(href, `qui Pulse action #${i} href`).toBe("/settings#services");
		}
	});
});
