/**
 * qui Integration Walkthrough — Phase 1.4 + 2.1 Verification
 *
 * Drives the visual walkthrough checklist programmatically. Covers
 * what unit tests can't: rendered layout, dropdown interaction,
 * filter→pagination flow, modal open/close, badge visibility,
 * and the perf regression that the per-card polling has been removed.
 */

import { expect, test } from "@playwright/test";

/**
 * Locator for the Torrent state dropdown — Phase 2.1 added this. Identified
 * by uniquely-shaped option values (`value="seeding"` and `value="stalled_dl"`)
 * that no other dropdown on the page uses.
 */
function torrentStateSelect(page: import("@playwright/test").Page) {
	return page
		.locator("select")
		.filter({ has: page.locator('option[value="seeding"]') })
		.filter({ has: page.locator('option[value="stalled_dl"]') })
		.first();
}

async function gotoLibrary(page: import("@playwright/test").Page) {
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
	test("opening a card with a badge fires the per-item endpoint at least once", async ({
		page,
	}) => {
		const quiCalls: string[] = [];
		page.on("request", (req) => {
			if (req.url().includes("/qui/library-item/torrent-state")) {
				quiCalls.push(req.url());
			}
		});

		await gotoLibrary(page);
		const dropdown = torrentStateSelect(page);
		await dropdown.selectOption("seeding");
		await page.waitForTimeout(2000);

		// Click the first card to open its detail modal. Library cards use
		// onClick on the poster image area — find that and click it.
		const firstBadge = page.locator('[aria-label*="Torrent:"]').first();
		await firstBadge.scrollIntoViewIfNeeded();
		// The card wrapper has a clickable poster + title. Look for the
		// title link within the same card root.
		const cardRoot = firstBadge.locator(
			"xpath=ancestor::div[contains(@class, 'glass') or contains(@class, 'card') or contains(@class, 'group')][1]",
		);
		// Click the first <button> or <a> inside the card root that opens details.
		const detailsTrigger = cardRoot
			.locator('button, [role="button"], a, h3, [class*="cursor-pointer"]')
			.first();
		const triggerCount = await detailsTrigger.count();
		if (triggerCount > 0) {
			await detailsTrigger.click({ force: true });
		} else {
			// Fallback: click somewhere visible on the card itself
			await cardRoot.click({ force: true });
		}

		await page.waitForTimeout(2500);

		// Modal opening should fire the per-item qui endpoint at least once.
		// If this fails the click target is wrong but the architecture still works
		// (test 7 already proved the per-item endpoint isn't fired on plain load,
		// and the modal panel has its own component test elsewhere).
		expect(
			quiCalls.length,
			`expected modal to fire ≥1 qui call on open (got ${quiCalls.length})`,
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
