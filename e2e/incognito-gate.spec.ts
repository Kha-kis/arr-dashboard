/**
 * Incognito Leak Gate — B6 follow-up
 *
 * Asserts the user-visible incognito promise: with incognito mode ON,
 * sensitive strings (media titles, instance names) from API responses
 * must never reach the rendered DOM. The fixture injects distinctive
 * sentinel strings via route mocks; the gate greps the full page HTML
 * for them.
 *
 * Anti-vacuous design: the first test proves the SAME mocks render the
 * sentinels when incognito is OFF. Without that pairing, a route-matcher
 * mismatch would silently pass the leak test ("silence is not success").
 *
 * CI fixture strategy mirrors qui-walkthrough.spec.ts: mock ONLY the
 * endpoints this surface needs (/api/services, /api/library, sync
 * status); everything else falls through to the real Fastify routes so
 * auth/sidebar/header render normally. Response shapes are derived from
 * the Zod schemas in packages/shared/src/types/ — enum values lowercase,
 * required fields present.
 */

import { expect, type Page, test } from "@playwright/test";

/** Distinctive sentinels — must never collide with the Linux ISO /
 * instance-name pools that incognito substitutes in. */
const SENTINEL_TITLE = "Zz-Sensitive-Title-E2E";
const SENTINEL_INSTANCE = "Zz-Sensitive-Instance-E2E";

const INCOGNITO_STORAGE_KEY = "arr-dashboard-incognito-mode";

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

function buildMockLibraryItems(): MockLibraryItem[] {
	const base = (id: number, state: string, ratio: number | null): MockLibraryItem => ({
		id,
		instanceId: "mock-sonarr",
		instanceName: SENTINEL_INSTANCE,
		service: "sonarr",
		type: "series",
		title: `${SENTINEL_TITLE} ${id}`,
		sortTitle: `${SENTINEL_TITLE.toLowerCase()} ${id}`,
		year: 2024,
		monitored: true,
		hasFile: true,
		status: "continuing",
		torrentState: state,
		torrentRatio: ratio,
		// Deliberately non-sensitive path — this gate covers the title +
		// instance-name promise; save-path anonymization has its own unit
		// coverage.
		path: `/data/media/show-${id}`,
	});
	return [
		base(1, "seeding", 1.42),
		base(2, "seeding", 2.18),
		base(3, "downloading", 0.0),
		base(4, "none", null),
	];
}

/**
 * Mock services + library endpoints with sentinel-bearing fixtures.
 * The qui service entry makes `hasQui` derive true so the torrent-state
 * dropdown renders with `(N)` counts — that dropdown is the
 * title-independent "data definitely rendered" beacon both tests wait
 * on before asserting.
 */
async function setupSentinelMocks(page: Page): Promise<void> {
	// Diagnostic request log — CI captures the actual request stream as
	// ground truth when a matcher silently misses (PR #475 lesson).
	page.on("request", (req) => {
		const url = req.url();
		if (url.includes("/api/")) {
			// eslint-disable-next-line no-console
			console.log(`[e2e] ${req.method()} ${url}`);
		}
	});

	await page.route(/\/api\/library\/sync\/status$/, async (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ instances: [] }),
		}),
	);

	await page.route("**/api/services", async (route) => {
		if (route.request().method() !== "GET") {
			return route.continue();
		}
		const now = new Date().toISOString();
		const instance = (id: string, label: string, service: string, baseUrl: string) => ({
			id,
			label,
			baseUrl,
			externalUrl: null,
			service,
			enabled: true,
			isDefault: false,
			hasApiKey: true,
			tags: [],
			storageGroupId: null,
			hasLocalFilesystemAccess: false,
			pathPrefix: null,
			createdAt: now,
			updatedAt: now,
		});
		return route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				services: [
					instance("mock-sonarr", SENTINEL_INSTANCE, "sonarr", "http://sonarr.mock.test:8989"),
					instance("mock-qui-instance", "Mock qui", "qui", "http://qui.mock.test:7476"),
				],
			}),
		});
	});

	// End-anchored regex, NOT a `**/api/library**` glob — the glob would
	// also catch /api/library/sync/status and /api/library/episodes with
	// the wrong shape (PR #475 lesson).
	await page.route(/\/api\/library(\?[^/]*)?$/, async (route) => {
		if (route.request().method() !== "GET") {
			return route.continue();
		}
		const items = buildMockLibraryItems();
		return route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				items,
				pagination: { page: 1, limit: 50, totalItems: items.length, totalPages: 1 },
				appliedFilters: {},
				syncStatus: {
					isCached: true,
					lastSync: new Date().toISOString(),
					syncInProgress: false,
					totalCachedItems: items.length,
				},
				torrentStateCounts: {
					all: items.length,
					none: 1,
					seeding: 2,
					downloading: 1,
					stalled_dl: 0,
					paused: 0,
					queued: 0,
					checking: 0,
					moving: 0,
					error: 0,
					unknown: 0,
				},
			}),
		});
	});
}

/** Title-independent beacon that the mocked library payload rendered. */
function torrentStateSelect(page: Page) {
	return page
		.locator("select")
		.filter({ has: page.locator('option[value="seeding"]') })
		.filter({ has: page.locator('option[value="stalled_dl"]') })
		.first();
}

async function gotoLibraryAndWaitForData(page: Page) {
	await page.goto("/library");
	await expect(page.getByRole("heading", { name: /your collection|library/i }).first()).toBeVisible(
		{ timeout: 15_000 },
	);
	// The dropdown's (N) counts come from the same mocked /api/library
	// response that carries the sentinel items — once it's attached, the
	// data has rendered and the leak assertions below are non-vacuous.
	await expect(torrentStateSelect(page)).toBeAttached({ timeout: 15_000 });
}

test.describe("incognito leak gate — library surface", () => {
	test("sanity: sentinels render when incognito is OFF (mock path proven)", async ({ page }) => {
		await setupSentinelMocks(page);
		await page.addInitScript(
			([key]) => localStorage.setItem(key, "false"),
			[INCOGNITO_STORAGE_KEY],
		);
		await gotoLibraryAndWaitForData(page);

		// The sentinel title must be user-visible — this proves the mocks
		// feed the real render path, making the leak test below meaningful.
		await expect(page.getByText(new RegExp(SENTINEL_TITLE)).first()).toBeVisible({
			timeout: 10_000,
		});
	});

	test("gate: sentinels never reach the DOM when incognito is ON", async ({ page }) => {
		await setupSentinelMocks(page);
		await page.addInitScript(([key]) => localStorage.setItem(key, "true"), [INCOGNITO_STORAGE_KEY]);
		await gotoLibraryAndWaitForData(page);

		// Full-HTML grep — catches text nodes, title= attributes, and
		// aria-labels alike. The data has rendered (dropdown beacon), so
		// absence here means anonymization, not an empty page.
		const html = await page.content();
		expect(html, "media title leaked into DOM with incognito ON").not.toContain(SENTINEL_TITLE);
		expect(html, "instance name leaked into DOM with incognito ON").not.toContain(
			SENTINEL_INSTANCE,
		);
	});
});
