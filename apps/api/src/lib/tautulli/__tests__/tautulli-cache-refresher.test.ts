/**
 * Tautulli Cache Refresher — stale row eviction tests
 *
 * Proactive hardening to match the Plex fix from PR #328 / issue #323.
 *
 * The original `deleteMany({ id: { notIn: upsertedIds } })` shape binds one
 * parameter per kept id, so the query overflows SQLite's SQLITE_MAX_VARIABLE_NUMBER
 * (default 999) — and for Tautulli specifically, the unbounded dimension is
 * the *accumulated table size* (i.e. the stale diff), not the per-refresh
 * upsert set. A single refresh is capped by `MAX_METADATA_LOOKUPS`, but the
 * cache keeps growing over time, so the keep-list that would be passed into
 * `notIn` grows with cache age regardless of how small any one refresh is.
 * These tests pin the replacement read-then-diff-then-chunked-`in`-delete
 * contract so the Tautulli refresher cannot regress into that failure mode.
 */

import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../prisma.js";
import {
	evictStaleRows,
	refreshTautulliCache,
	STALE_EVICTION_CHUNK_SIZE,
} from "../tautulli-cache-refresher.js";
import type { TautulliClient } from "../tautulli-client.js";

// Neutralise the inter-lookup rate-limit delay so the end-to-end test runs fast.
vi.mock("../../utils/delay.js", () => ({
	delay: vi.fn(async () => {}),
}));

const silentLog = {
	warn: vi.fn(),
	info: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
	child: vi.fn(),
} as unknown as FastifyBaseLogger;

/**
 * Build a minimal Prisma stub that records every `deleteMany` call so tests
 * can assert on chunking behaviour without needing a real database.
 */
function makeMockPrisma(existingIds: string[]) {
	const deleteCalls: Array<{ idsInFilter: string[] }> = [];

	const stub = {
		tautulliCache: {
			findMany: vi.fn(async () => existingIds.map((id) => ({ id }))),
			deleteMany: vi.fn(async (args: { where: { id?: { in?: string[]; notIn?: string[] } } }) => {
				const inList = args.where.id?.in;
				if (!inList) {
					throw new Error(
						"Regression: DELETE used something other than `id: { in: [...] }` — likely a reintroduced notIn.",
					);
				}
				deleteCalls.push({ idsInFilter: inList });
				return { count: inList.length };
			}),
		},
	} as unknown as PrismaClient;

	return { prisma: stub, deleteCalls };
}

describe("evictStaleRows (tautulli)", () => {
	it("returns 0 and issues no DELETE when nothing is stale", async () => {
		const keepIds = ["a", "b", "c"];
		const { prisma, deleteCalls } = makeMockPrisma(keepIds);

		const deleted = await evictStaleRows(prisma, "inst-1", keepIds);

		expect(deleted).toBe(0);
		expect(deleteCalls).toHaveLength(0);
	});

	it("deletes only rows whose id is not in keepIds", async () => {
		const existing = ["keep-1", "stale-1", "keep-2", "stale-2"];
		const keepIds = ["keep-1", "keep-2"];
		const { prisma, deleteCalls } = makeMockPrisma(existing);

		const deleted = await evictStaleRows(prisma, "inst-1", keepIds);

		expect(deleted).toBe(2);
		expect(deleteCalls).toHaveLength(1);
		expect(new Set(deleteCalls[0]!.idsInFilter)).toEqual(new Set(["stale-1", "stale-2"]));
	});

	it("chunks large stale sets so no single DELETE exceeds the SQLite parameter limit (parallels #328)", async () => {
		// Simulate a cache table large enough that the old `notIn: upsertedIds`
		// path would have generated a multi-thousand-parameter query, well past
		// SQLite's default 999-parameter ceiling.
		const TOTAL_EXISTING = 5_000;
		const existingIds = Array.from({ length: TOTAL_EXISTING }, (_, i) => `row-${i}`);
		// Keep none — worst case for parameter count.
		const keepIds: string[] = [];
		const { prisma, deleteCalls } = makeMockPrisma(existingIds);

		const deleted = await evictStaleRows(prisma, "inst-1", keepIds);

		expect(deleted).toBe(TOTAL_EXISTING);

		// Every DELETE must stay under SQLite's conservative 999-parameter ceiling.
		const SQLITE_PARAM_CEILING = 999;
		for (const call of deleteCalls) {
			expect(call.idsInFilter.length).toBeLessThanOrEqual(STALE_EVICTION_CHUNK_SIZE);
			expect(call.idsInFilter.length).toBeLessThan(SQLITE_PARAM_CEILING);
		}

		// Chunks must cover the full stale set with no duplicates.
		const seen = new Set<string>();
		for (const call of deleteCalls) {
			for (const id of call.idsInFilter) {
				expect(seen.has(id)).toBe(false);
				seen.add(id);
			}
		}
		expect(seen.size).toBe(TOTAL_EXISTING);

		// Sanity: we actually issued multiple chunked statements.
		expect(deleteCalls.length).toBe(Math.ceil(TOTAL_EXISTING / STALE_EVICTION_CHUNK_SIZE));
	});
});

// ---------------------------------------------------------------------------
// End-to-end: refreshTautulliCache against a realistic "large stale tail" shape
// ---------------------------------------------------------------------------

describe("refreshTautulliCache (end-to-end)", () => {
	it("large stale-tail regression: refresh succeeds with only bounded DELETEs", async () => {
		// Models the real failure mode: a cache that accumulated many rows over
		// previous refreshes, where one refresh returns a smaller fresh set. The
		// stale diff is what blows past SQLite's parameter limit, not the upsert
		// set — so we use a small fresh set and a large pre-existing tail.
		const FRESH_COUNT = 10;
		const STALE_TAIL = 2_000;

		// Tautulli history: one entry per fresh item, all movies.
		const libraries = [
			{ section_id: "1", section_name: "Movies", section_type: "movie", count: "10" },
		];
		const history = Array.from({ length: FRESH_COUNT }, (_, i) => ({
			rating_key: `rk-${i}`,
			parent_rating_key: "",
			grandparent_rating_key: "",
			title: `Movie ${i}`,
			grandparent_title: "",
			media_type: "movie",
			user: "alice",
			date: 1_700_000_000 + i,
			play_count: 1,
		}));

		const mockClient = {
			getLibraries: vi.fn().mockResolvedValue(libraries),
			// First page fills below HISTORY_PAGE_SIZE (50) so the pagination loop
			// exits after one call. Subsequent pages would return empty.
			getHistory: vi.fn().mockResolvedValue({
				data: history,
				recordsFiltered: FRESH_COUNT,
				recordsTotal: FRESH_COUNT,
			}),
			getMetadata: vi.fn(async (ratingKey: string) => {
				const i = Number.parseInt(ratingKey.replace("rk-", ""), 10);
				return {
					guids: [`tmdb://${20_000 + i}`],
					media_type: "movie",
					title: `Movie ${i}`,
					rating_key: ratingKey,
				};
			}),
		} as unknown as TautulliClient;

		const upsertedIds: string[] = [];
		const existingStaleIds = Array.from({ length: STALE_TAIL }, (_, i) => `stale-${i}`);
		const deleteCalls: Array<{ idsInFilter: string[] }> = [];

		const mockPrisma = {
			tautulliCache: {
				upsert: vi.fn(async () => {
					const id = `fresh-${upsertedIds.length}`;
					upsertedIds.push(id);
					return { id };
				}),
				findMany: vi.fn(async () => [...existingStaleIds, ...upsertedIds].map((id) => ({ id }))),
				deleteMany: vi.fn(async (args: { where: { id?: { in?: string[]; notIn?: string[] } } }) => {
					const inList = args.where.id?.in;
					if (!inList) {
						throw new Error(
							"Regression: Tautulli eviction used something other than `id: { in: [...] }` — likely a reintroduced notIn.",
						);
					}
					deleteCalls.push({ idsInFilter: inList });
					return { count: inList.length };
				}),
			},
		} as unknown as PrismaClient;

		const result = await refreshTautulliCache(mockClient, mockPrisma, "inst-1", silentLog);

		expect(result.errors).toBe(0);
		expect(result.errorMessages).toEqual([]);
		expect(result.upserted).toBe(FRESH_COUNT);

		// Every eviction DELETE stays under SQLite's 999-parameter ceiling.
		const SQLITE_PARAM_CEILING = 999;
		expect(deleteCalls.length).toBeGreaterThan(0);
		for (const call of deleteCalls) {
			expect(call.idsInFilter.length).toBeLessThanOrEqual(STALE_EVICTION_CHUNK_SIZE);
			expect(call.idsInFilter.length).toBeLessThan(SQLITE_PARAM_CEILING);
		}

		// Chunks together wipe exactly the stale tail, nothing more.
		const deletedIds = deleteCalls.flatMap((c) => c.idsInFilter);
		expect(deletedIds.length).toBe(STALE_TAIL);
		expect(new Set(deletedIds)).toEqual(new Set(existingStaleIds));
	});
});

// ---------------------------------------------------------------------------
// Sparse metadata regression (#497)
// ---------------------------------------------------------------------------
//
// Tautulli's get_metadata can return a "success" envelope with empty/sparse
// data when the rating_key isn't in its database (e.g., item deleted from
// Plex but still in watch history). Before the schema fix, the missing
// rating_key field caused UpstreamValidationError on every such response,
// flooding Pulse/Dashboard with false-positive warnings. With the schema
// tolerant of empty data, the refresher silently skips items whose metadata
// can't be resolved — without logging warnings for the expected "not found"
// case — while still surfacing real failures.

describe("refreshTautulliCache — sparse metadata handling (#497)", () => {
	it("silently skips items returning sparse metadata, without counting errors", async () => {
		const libraries = [
			{ section_id: "1", section_name: "Movies", section_type: "movie", count: "3" },
		];
		const history = [
			{
				rating_key: "rk-found",
				parent_rating_key: "",
				grandparent_rating_key: "",
				title: "Found Movie",
				grandparent_title: "",
				media_type: "movie",
				user: "alice",
				date: 1_700_000_000,
				play_count: 1,
			},
			{
				rating_key: "rk-missing",
				parent_rating_key: "",
				grandparent_rating_key: "",
				title: "Deleted Movie",
				grandparent_title: "",
				media_type: "movie",
				user: "alice",
				date: 1_700_000_001,
				play_count: 1,
			},
			{
				rating_key: "rk-error",
				parent_rating_key: "",
				grandparent_rating_key: "",
				title: "Network-Failed Movie",
				grandparent_title: "",
				media_type: "movie",
				user: "alice",
				date: 1_700_000_002,
				play_count: 1,
			},
		];

		const mockClient = {
			getLibraries: vi.fn().mockResolvedValue(libraries),
			getHistory: vi.fn().mockResolvedValue({
				data: history,
				recordsFiltered: history.length,
				recordsTotal: history.length,
			}),
			getMetadata: vi.fn(async (ratingKey: string) => {
				if (ratingKey === "rk-found") {
					return {
						guids: ["tmdb://12345"],
						media_type: "movie",
						title: "Found Movie",
						rating_key: "rk-found",
					};
				}
				if (ratingKey === "rk-missing") {
					// Tautulli's "rating_key not in DB" shape: success envelope with
					// empty data, normalised by the schema's preprocess defaults.
					return {
						guids: [],
						media_type: "unknown",
						title: "",
						// rating_key omitted entirely
					};
				}
				// rk-error: real upstream failure path (network, HTTP 500, etc.)
				throw new Error("ECONNREFUSED");
			}),
		} as unknown as TautulliClient;

		const mockPrisma = {
			tautulliCache: {
				upsert: vi.fn(async () => ({ id: "fresh-1" })),
				findMany: vi.fn(async () => [{ id: "fresh-1" }]),
				deleteMany: vi.fn(async () => ({ count: 0 })),
			},
		} as unknown as PrismaClient;

		const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;

		const result = await refreshTautulliCache(mockClient, mockPrisma, "inst-1", log);

		// Only the rk-found item upserts; rk-missing is silently skipped (no guid),
		// rk-error throws and is caught + counted as a real error.
		expect(result.upserted).toBe(1);
		expect(result.errors).toBe(1);
		expect(result.errorMessages).toHaveLength(1);
		expect(result.errorMessages[0]).toContain("rk-error");

		// The crucial regression assertion: the empty-metadata item must NOT
		// produce a "failed to fetch metadata for item" warning. Before the fix,
		// it would — one warning per missing rating_key, flooding the operator
		// dashboards. With the schema tolerant of sparse responses, only the
		// genuine ECONNREFUSED logs a warning.
		const metadataWarnings = (
			log.warn as unknown as { mock: { calls: unknown[][] } }
		).mock.calls.filter((call) => {
			const msg = call[1];
			return typeof msg === "string" && msg.includes("failed to fetch metadata");
		});
		expect(metadataWarnings).toHaveLength(1);
		const errCallArg = metadataWarnings[0]?.[0] as { ratingKey?: string } | undefined;
		expect(errCallArg?.ratingKey).toBe("rk-error");
	});
});
