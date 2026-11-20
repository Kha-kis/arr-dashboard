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
 *  with a stable provider total. Each page has `pageSize` records.
 */
function makePagedFetcher(
	pageCount: number,
	pageSize: number,
): {
	fetcher: (p: number, ps: number) => Promise<{ records: Raw[]; totalRecords: number }>;
	calls: number[];
} {
	const calls: number[] = [];
	const fetcher = async (page: number, _ps: number) => {
		calls.push(page);
		if (page > pageCount) return { records: [], totalRecords: pageCount * pageSize };
		const records: Raw[] = Array.from({ length: pageSize }, (_, i) => ({
			id: (page - 1) * pageSize + i + 1,
			bulk: "x".repeat(50),
		}));
		return { records, totalRecords: pageCount * pageSize };
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
		// Raw coverage proves completion even though projected rows were dropped.
		expect(calls).toEqual([1, 2]);
	});

	it("stops on a partial page (end-of-list signal)", async () => {
		const counter: ApiCallCounter = { count: 0 };
		const calls: number[] = [];
		const fetcher = async (page: number, _ps: number) => {
			calls.push(page);
			// Page 1: full (3 records). Page 2: partial (1 record) ⇒ end of list.
			if (page === 1) {
				return {
					totalRecords: 4,
					records: [
						{ id: 1, bulk: "" },
						{ id: 2, bulk: "" },
						{ id: 3, bulk: "" },
					],
				};
			}
			if (page === 2) return { records: [{ id: 4, bulk: "" }], totalRecords: 4 };
			return { records: [], totalRecords: 4 };
		};

		const out = await fetchWantedWithWrapAround<Raw>(fetcher, {
			counter,
			logger: stubLogger,
			fetchSize: 3,
		});

		expect(out).toHaveLength(4);
		expect(calls).toEqual([1, 2]);
	});

	it("rejects an inventory beyond the read budget instead of returning a truncated pool", async () => {
		const counter: ApiCallCounter = { count: 0 };
		const { fetcher, calls } = makePagedFetcher(100, 2); // way more than the cap

		await expect(
			fetchWantedWithWrapAround<Raw>(fetcher, {
				counter,
				logger: stubLogger,
				fetchSize: 2,
			}),
		).rejects.toThrow(/wanted inventory.*incomplete/i);
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

		// Stable total proves completion without a fourth, empty GET.
		expect(counter.count).toBe(3);
	});

	it("rejects null records rather than claiming an empty wanted inventory", async () => {
		const counter: ApiCallCounter = { count: 0 };
		const fetcher = async () => ({ records: null });

		await expect(
			fetchWantedWithWrapAround<Raw>(fetcher, {
				counter,
				logger: stubLogger,
				fetchSize: 10,
			}),
		).rejects.toThrow(/wanted inventory.*invalid/i);
		expect(counter.count).toBe(1);
	});

	it("continues through provider-clamped pages until the reported total is covered", async () => {
		const counter = { count: 0 };
		const out = await fetchWantedWithWrapAround<Raw>(
			async (page) => ({
				records: [{ id: page, bulk: "" }],
				totalRecords: 3,
			}),
			{ counter, logger: stubLogger, fetchSize: 500 },
		);
		expect(out.map((row) => row.id)).toEqual([1, 2, 3]);
		expect(counter.count).toBe(3);
	});

	it("accepts complete inventory exactly at the read-budget boundary without an extra GET", async () => {
		const counter = { count: 0 };
		const out = await fetchWantedWithWrapAround<Raw>(
			async (page) => ({
				records: [{ id: page, bulk: "" }],
				totalRecords: 20,
			}),
			{ counter, logger: stubLogger, fetchSize: 1 },
		);
		expect(out.map((row) => row.id)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
		expect(counter.count).toBe(20);
	});

	it("rejects a premature empty page when the provider reports remaining records", async () => {
		await expect(
			fetchWantedWithWrapAround<Raw>(async () => ({ records: [], totalRecords: 1 }), {
				counter: { count: 0 },
				logger: stubLogger,
			}),
		).rejects.toThrow(/wanted inventory.*incomplete/i);
	});

	it.each([undefined, null])(
		"rejects missing provider total (%s) rather than guessing from a short page",
		async (totalRecords) => {
			await expect(
				fetchWantedWithWrapAround<Raw>(
					async () => ({
						records: [{ id: 1, bulk: "" }],
						totalRecords,
					}),
					{ counter: { count: 0 }, logger: stubLogger },
				),
			).rejects.toThrow(/wanted inventory.*invalid/i);
		},
	);

	it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects invalid provider totals (%s)",
		async (totalRecords) => {
			await expect(
				fetchWantedWithWrapAround<Raw>(async () => ({ records: [], totalRecords }), {
					counter: { count: 0 },
					logger: stubLogger,
				}),
			).rejects.toThrow(/wanted inventory.*invalid/i);
		},
	);

	it("rejects a total that changes during pagination", async () => {
		await expect(
			fetchWantedWithWrapAround<Raw>(
				async (page) => ({
					records: [{ id: page, bulk: "" }],
					totalRecords: page === 1 ? 2 : 3,
				}),
				{ counter: { count: 0 }, logger: stubLogger, fetchSize: 1 },
			),
		).rejects.toThrow(/wanted inventory.*changed/i);
	});

	it("rejects rows in excess of the reported total", async () => {
		await expect(
			fetchWantedWithWrapAround<Raw>(
				async () => ({
					records: [{ id: 1, bulk: "" }],
					totalRecords: 0,
				}),
				{ counter: { count: 0 }, logger: stubLogger },
			),
		).rejects.toThrow(/wanted inventory.*invalid/i);
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
				totalRecords: 6,
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
