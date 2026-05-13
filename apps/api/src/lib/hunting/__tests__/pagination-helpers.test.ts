/**
 * Tests for fetchWantedWithWrapAround — the paginator that drives the
 * Sonarr/Radarr/Lidarr/Readarr wanted-missing and wanted-cutoff hunts.
 *
 * Why this layer matters for issue #427: a 50k-album Lidarr returns
 * up to 10,000 fat records (~13 KB each, with embedded artist.links[])
 * across 20 pages. The pre-fix accumulator held all 10k fat records
 * simultaneously before the caller's `.map(projectAlbum).filter(...)`
 * chain could slim them — ~130-200 MB resident at peak, which on a
 * 768 MB container heap was enough to push the process toward OOM.
 *
 * The `project` option moves slimming inside the page loop, so each
 * page's fat records become GC-eligible at the iteration boundary.
 * These tests pin the contract:
 *
 *   1. Back-compat — no `project` ⇒ raw records flow through as before.
 *   2. With `project` ⇒ only the slim shape is in the result.
 *   3. `project` returning null drops the record (orphan-FK case).
 *   4. Page completion still uses the *raw* record count, so a fully
 *      loaded page whose projection drops every record still advances.
 *   5. The 20-page cap still bounds API usage on pathological libraries.
 *   6. Counter increments per actual fetch, not per projected record.
 */

import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { type ApiCallCounter, fetchWantedWithWrapAround } from "../pagination-helpers.js";

const stubLogger = {
	child: vi.fn().mockReturnThis(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
} as unknown as FastifyBaseLogger;

type Raw = { id: number; bulk: string };
type Slim = { id: number };

/** Build a paginated fetcher that serves `pageCount` fully-loaded pages
 *  followed by an empty page. Each page has `pageSize` records.
 */
function makePagedFetcher(
	pageCount: number,
	pageSize: number,
): { fetcher: (p: number, ps: number) => Promise<{ records: Raw[] }>; calls: number[] } {
	const calls: number[] = [];
	const fetcher = async (page: number, _ps: number) => {
		calls.push(page);
		if (page > pageCount) return { records: [] };
		const records: Raw[] = Array.from({ length: pageSize }, (_, i) => ({
			id: (page - 1) * pageSize + i + 1,
			bulk: "x".repeat(50),
		}));
		return { records };
	};
	return { fetcher, calls };
}

describe("fetchWantedWithWrapAround", () => {
	it("returns raw records when no project is supplied (back-compat)", async () => {
		const counter: ApiCallCounter = { count: 0 };
		const { fetcher } = makePagedFetcher(2, 3);

		const out = await fetchWantedWithWrapAround<Raw>(fetcher, {
			counter,
			logger: stubLogger,
			fetchSize: 3,
		});

		expect(out).toHaveLength(6);
		expect(out[0]).toEqual({ id: 1, bulk: "x".repeat(50) });
		expect(out[5]).toEqual({ id: 6, bulk: "x".repeat(50) });
	});

	it("slims records when project is supplied", async () => {
		const counter: ApiCallCounter = { count: 0 };
		const { fetcher } = makePagedFetcher(2, 3);

		const out = await fetchWantedWithWrapAround<Raw, Slim>(fetcher, {
			counter,
			logger: stubLogger,
			fetchSize: 3,
			project: (raw) => ({ id: raw.id }),
		});

		expect(out).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }]);
		// No `.bulk` field survives — that's the whole point of projecting in-loop.
		expect(out[0]).not.toHaveProperty("bulk");
	});

	it("drops records when project returns null", async () => {
		const counter: ApiCallCounter = { count: 0 };
		const { fetcher } = makePagedFetcher(1, 4);

		const out = await fetchWantedWithWrapAround<Raw, Slim>(fetcher, {
			counter,
			logger: stubLogger,
			fetchSize: 4,
			project: (raw) => (raw.id % 2 === 0 ? { id: raw.id } : null),
		});

		expect(out).toEqual([{ id: 2 }, { id: 4 }]);
	});

	it("advances past a fully-loaded page even when projection drops every record", async () => {
		// Regression guard: the page-completion check must use the *raw* record
		// count, not the projected count. Otherwise a page where every record
		// fails the FK check would falsely terminate the loop early and hide
		// later pages from the hunt.
		const counter: ApiCallCounter = { count: 0 };
		const { fetcher, calls } = makePagedFetcher(2, 3);

		const out = await fetchWantedWithWrapAround<Raw, Slim>(fetcher, {
			counter,
			logger: stubLogger,
			fetchSize: 3,
			// Drop page 1's records; keep page 2's.
			project: (raw) => (raw.id > 3 ? { id: raw.id } : null),
		});

		expect(out).toEqual([{ id: 4 }, { id: 5 }, { id: 6 }]);
		// Should have fetched both data pages plus the trailing empty page.
		expect(calls).toEqual([1, 2, 3]);
	});

	it("stops on a partial page (end-of-list signal)", async () => {
		const counter: ApiCallCounter = { count: 0 };
		const calls: number[] = [];
		const fetcher = async (page: number, _ps: number) => {
			calls.push(page);
			// Page 1: full (3 records). Page 2: partial (1 record) ⇒ end of list.
			if (page === 1) {
				return {
					records: [
						{ id: 1, bulk: "" },
						{ id: 2, bulk: "" },
						{ id: 3, bulk: "" },
					],
				};
			}
			if (page === 2) return { records: [{ id: 4, bulk: "" }] };
			return { records: [] };
		};

		const out = await fetchWantedWithWrapAround<Raw>(fetcher, {
			counter,
			logger: stubLogger,
			fetchSize: 3,
		});

		expect(out).toHaveLength(4);
		expect(calls).toEqual([1, 2]);
	});

	it("respects the 20-page MAX_PAGES cap even when more pages exist", async () => {
		const counter: ApiCallCounter = { count: 0 };
		const { fetcher, calls } = makePagedFetcher(100, 2); // way more than the cap

		const out = await fetchWantedWithWrapAround<Raw>(fetcher, {
			counter,
			logger: stubLogger,
			fetchSize: 2,
		});

		// 20 pages × 2 records each = 40 records max under the cap.
		expect(out).toHaveLength(40);
		expect(calls).toHaveLength(20);
		expect(counter.count).toBe(20);
	});

	it("increments the API counter per fetch, not per projected record", async () => {
		const counter: ApiCallCounter = { count: 0 };
		const { fetcher } = makePagedFetcher(3, 5);

		await fetchWantedWithWrapAround<Raw, Slim>(fetcher, {
			counter,
			logger: stubLogger,
			fetchSize: 5,
			// Even though projection drops half the records, counter still tracks pages.
			project: (raw) => (raw.id % 2 === 0 ? { id: raw.id } : null),
		});

		// 3 data pages + 1 trailing empty page = 4 fetches.
		expect(counter.count).toBe(4);
	});

	it("handles null records gracefully (e.g. malformed upstream response)", async () => {
		const counter: ApiCallCounter = { count: 0 };
		const fetcher = async () => ({ records: null });

		const out = await fetchWantedWithWrapAround<Raw>(fetcher, {
			counter,
			logger: stubLogger,
			fetchSize: 10,
		});

		expect(out).toEqual([]);
		expect(counter.count).toBe(1);
	});

	it("propagates errors thrown by `project` without silently returning a partial result", async () => {
		// The pre-fix code path ran projection in `.map()` after the paginator
		// returned, so a throw killed the post-fetch transform cleanly. Now
		// projection runs inside the page loop. We DO NOT want the helper to
		// swallow a thrown error and return a partial accumulator — that would
		// silently lose records from later pages. Pinning current behavior so
		// any future "defensive try/catch" addition is a deliberate decision.
		const counter: ApiCallCounter = { count: 0 };
		const { fetcher } = makePagedFetcher(2, 3);

		await expect(
			fetchWantedWithWrapAround<Raw, Slim>(fetcher, {
				counter,
				logger: stubLogger,
				fetchSize: 3,
				project: (raw) => {
					if (raw.id === 4) throw new Error("malformed record");
					return { id: raw.id };
				},
			}),
		).rejects.toThrow("malformed record");

		// The first page's fetch did happen — counter reflects observable work.
		expect(counter.count).toBeGreaterThanOrEqual(1);
	});

	it("propagates errors thrown by `fetcher` without silently returning a partial result", async () => {
		// Same contract as the projection-throws case: a transient upstream
		// failure (network blip, 5xx) must propagate so the outer hunt handler
		// at hunt-executor.ts:1205/1456/1702 can mark the hunt failed. The
		// helper must not return a partial `allRecords` from earlier pages.
		const counter: ApiCallCounter = { count: 0 };
		let page = 0;
		const fetcher = async () => {
			page++;
			if (page === 2) throw new Error("upstream 503");
			return {
				records: [
					{ id: page, bulk: "" },
					{ id: page + 100, bulk: "" },
					{ id: page + 200, bulk: "" },
				],
			};
		};

		await expect(
			fetchWantedWithWrapAround<Raw>(fetcher, {
				counter,
				logger: stubLogger,
				fetchSize: 3,
			}),
		).rejects.toThrow("upstream 503");
	});
});
