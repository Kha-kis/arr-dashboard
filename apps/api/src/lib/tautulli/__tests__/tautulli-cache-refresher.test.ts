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
			row_id: i + 1,
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
			// First page fills below HISTORY_PAGE_SIZE so the pagination loop
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

		const publishedRows: unknown[] = [];
		const replacementDelete = vi.fn().mockResolvedValue({ count: STALE_TAIL });
		const tx = {
			tautulliCache: {
				deleteMany: replacementDelete,
				createMany: vi.fn(async ({ data }: { data: unknown[] }) => {
					publishedRows.push(...data);
					return { count: data.length };
				}),
			},
			cacheRefreshStatus: { upsert: vi.fn().mockResolvedValue({}) },
		};

		const mockPrisma = {
			$transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
				callback(tx),
			),
		} as unknown as PrismaClient;

		const result = await refreshTautulliCache(
			mockClient,
			mockPrisma,
			"inst-1",
			silentLog,
			undefined,
		);

		expect(result.errors).toBe(0);
		expect(result.errorMessages).toEqual([]);
		expect(result.upserted).toBe(FRESH_COUNT);

		expect(replacementDelete).toHaveBeenCalledWith({ where: { instanceId: "inst-1" } });
		expect(publishedRows).toHaveLength(FRESH_COUNT);
		expect(tx.cacheRefreshStatus.upsert).toHaveBeenCalledOnce();
	});

	it("reports incomplete evidence when unique metadata exceeds the lookup cap", async () => {
		const history = Array.from({ length: 501 }, (_, index) => ({
			row_id: index + 1,
			rating_key: `rk-${index}`,
			parent_rating_key: "",
			grandparent_rating_key: "",
			title: `Movie ${index}`,
			grandparent_title: "",
			media_type: "movie",
			user: "alice",
			date: 1_700_000_000 + index,
			play_count: 1,
		}));
		const mockClient = {
			getLibraries: vi
				.fn()
				.mockResolvedValue([
					{ section_id: "1", section_name: "Movies", section_type: "movie", count: "501" },
				]),
			getHistory: vi.fn(async ({ start, length }: { start: number; length: number }) => ({
				data: history.slice(start, start + length),
				recordsFiltered: history.length,
				recordsTotal: history.length,
			})),
			getMetadata: vi.fn(async (ratingKey: string) => ({
				guids: [`tmdb://${Number.parseInt(ratingKey.replace("rk-", ""), 10) + 1}`],
				media_type: "movie",
				title: ratingKey,
				rating_key: ratingKey,
			})),
		} as unknown as TautulliClient;
		const mockPrisma = {
			tautulliCache: {
				upsert: vi.fn(async ({ where }: { where: { instanceId_tmdbId_mediaType: unknown } }) => ({
					id: JSON.stringify(where.instanceId_tmdbId_mediaType),
				})),
				findMany: vi.fn().mockResolvedValue([]),
				deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
			},
		} as unknown as PrismaClient;

		const result = await refreshTautulliCache(
			mockClient,
			mockPrisma,
			"inst-1",
			silentLog,
			undefined,
		);

		expect(result.errors).toBe(1);
		expect(result.errorMessages).toContain("Tautulli metadata inventory exceeded 500 unique items");
		expect(mockClient.getMetadata).toHaveBeenCalledTimes(500);
		expect(result.upserted).toBe(0);
	});

	it("evicts stale rows when a discovered library has a complete empty history", async () => {
		const mockClient = {
			getLibraries: vi
				.fn()
				.mockResolvedValue([
					{ section_id: "1", section_name: "Movies", section_type: "movie", count: "0" },
				]),
			getHistory: vi.fn().mockResolvedValue({
				data: [],
				recordsFiltered: 0,
				recordsTotal: 0,
			}),
			getMetadata: vi.fn(),
		} as unknown as TautulliClient;
		const deleteMany = vi.fn().mockResolvedValue({ count: 2 });
		const tx = {
			tautulliCache: { deleteMany, createMany: vi.fn() },
			cacheRefreshStatus: { upsert: vi.fn().mockResolvedValue({}) },
		};
		const prisma = {
			$transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
				callback(tx),
			),
		} as unknown as PrismaClient;

		const result = await refreshTautulliCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ errors: 0, complete: true, upserted: 0 });
		expect(deleteMany).toHaveBeenCalledWith({ where: { instanceId: "inst-1" } });
		expect(tx.tautulliCache.createMany).not.toHaveBeenCalled();
	});

	it("collects a verified live snapshot without publishing cache state", async () => {
		const watchedAt = 1_723_000_000;
		const mockClient = {
			getLibraries: vi
				.fn()
				.mockResolvedValue([
					{ section_id: "1", section_name: "Movies", section_type: "movie", count: "1" },
				]),
			getHistory: vi.fn().mockResolvedValue({
				data: [
					{
						row_id: 1,
						rating_key: "rk-1",
						parent_rating_key: "",
						grandparent_rating_key: "",
						title: "Recent Movie",
						grandparent_title: "",
						media_type: "movie",
						user: "alice",
						date: watchedAt,
						play_count: 1,
					},
				],
				recordsFiltered: 1,
				recordsTotal: 1,
			}),
			getMetadata: vi.fn().mockResolvedValue({
				guids: ["tmdb://12345"],
				media_type: "movie",
				title: "Recent Movie",
				rating_key: "rk-1",
			}),
		} as unknown as TautulliClient;
		const transaction = vi.fn();
		const prisma = { $transaction: transaction } as unknown as PrismaClient;

		const result = await refreshTautulliCache(mockClient, prisma, "inst-1", silentLog, undefined, {
			publish: false,
		});

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 0 });
		expect(result.snapshot?.rows).toEqual([
			expect.objectContaining({
				instanceId: "inst-1",
				tmdbId: 12345,
				lastWatchedAt: new Date(watchedAt * 1000),
				watchCount: 1,
			}),
		]);
		expect(transaction).not.toHaveBeenCalled();
	});

	it("discards an outgoing Tautulli generation after its connection changes before publication", async () => {
		let resolveHistory: (result: {
			data: unknown[];
			recordsFiltered: number;
			recordsTotal: number;
		}) => void = () => {};
		const pendingHistory = new Promise<{
			data: unknown[];
			recordsFiltered: number;
			recordsTotal: number;
		}>((resolve) => {
			resolveHistory = resolve;
		});
		let currentGeneration = 7;
		const mockClient = {
			getLibraries: vi
				.fn()
				.mockResolvedValue([
					{ section_id: "1", section_name: "Movies", section_type: "movie", count: "0" },
				]),
			getHistory: vi
				.fn()
				.mockReturnValueOnce(pendingHistory)
				.mockResolvedValue({ data: [], recordsFiltered: 0, recordsTotal: 0 }),
			getMetadata: vi.fn(),
		} as unknown as TautulliClient;
		const tx = {
			serviceInstance: {
				findUnique: vi.fn(async () => ({
					service: "TAUTULLI",
					enabled: true,
					connectionGeneration: currentGeneration,
				})),
			},
			tautulliCache: { deleteMany: vi.fn(), createMany: vi.fn() },
			cacheRefreshStatus: { upsert: vi.fn() },
		};
		const prisma = {
			$transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
				callback(tx),
			),
		} as unknown as PrismaClient;

		const refresh = refreshTautulliCache(mockClient, prisma, "inst-1", silentLog, {
			service: "TAUTULLI",
			connectionGeneration: 7,
		});
		await vi.waitFor(() => expect(mockClient.getHistory).toHaveBeenCalledOnce());
		currentGeneration = 8;
		resolveHistory({ data: [], recordsFiltered: 0, recordsTotal: 0 });
		const result = await refresh;

		expect(result).toMatchObject({ complete: false, superseded: true, upserted: 0 });
		expect(tx.tautulliCache.deleteMany).not.toHaveBeenCalled();
		expect(tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});

	it("fails closed when no media libraries can be discovered", async () => {
		const mockClient = {
			getLibraries: vi.fn().mockResolvedValue([]),
			getHistory: vi.fn(),
			getMetadata: vi.fn(),
		} as unknown as TautulliClient;
		const { prisma, deleteCalls } = makeMockPrisma(["stale-1"]);

		const result = await refreshTautulliCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result.complete).toBe(false);
		expect(result.errors).toBeGreaterThan(0);
		expect(deleteCalls).toHaveLength(0);
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
				row_id: 1,
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
				row_id: 2,
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
				row_id: 3,
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

		const result = await refreshTautulliCache(mockClient, mockPrisma, "inst-1", log, undefined);

		// The incomplete scan publishes nothing; the previous generation remains intact.
		expect(result.upserted).toBe(0);
		expect(result.errors).toBe(1);
		expect(result.complete).toBe(false);
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

describe("refreshTautulliCache — authoritative completeness", () => {
	it("publishes complete history beyond the legacy 1,000-row page cap", async () => {
		const history = Array.from({ length: 1_001 }, (_, index) => ({
			row_id: index + 1,
			rating_key: "rk-established",
			parent_rating_key: "",
			grandparent_rating_key: "",
			title: "Established Movie",
			grandparent_title: "",
			media_type: "movie",
			user: "alice",
			date: 1_700_000_000 + index,
			play_count: 1,
		}));
		const getHistory = vi.fn(async ({ start, length }: { start: number; length: number }) => ({
			data: history.slice(start, start + length),
			recordsFiltered: history.length,
			recordsTotal: history.length,
		}));
		const mockClient = {
			getLibraries: vi
				.fn()
				.mockResolvedValue([
					{ section_id: "1", section_name: "Movies", section_type: "movie", count: "1" },
				]),
			getHistory,
			getMetadata: vi.fn().mockResolvedValue({
				guids: ["tmdb://12345"],
				media_type: "movie",
				title: "Established Movie",
				rating_key: "rk-established",
			}),
		} as unknown as TautulliClient;
		const publishedRows: Array<{ watchCount: number }> = [];
		const tx = {
			tautulliCache: {
				deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
				createMany: vi.fn(async ({ data }: { data: Array<{ watchCount: number }> }) => {
					publishedRows.push(...data);
					return { count: data.length };
				}),
			},
			cacheRefreshStatus: { upsert: vi.fn().mockResolvedValue({}) },
		};
		const prisma = {
			$transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
				callback(tx),
			),
		} as unknown as PrismaClient;

		const result = await refreshTautulliCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 1 });
		expect(getHistory).toHaveBeenCalledTimes(12);
		expect(getHistory).toHaveBeenCalledWith({
			section_id: "1",
			length: 1,
			start: 1_000,
			order_column: "row_id",
			order_dir: "asc",
			grouping: 0,
			include_activity: 0,
		});
		expect(getHistory).toHaveBeenLastCalledWith({
			section_id: "1",
			length: 1,
			start: 1_000,
			order_column: "row_id",
			order_dir: "asc",
			grouping: 0,
			include_activity: 0,
		});
		expect(publishedRows).toEqual([expect.objectContaining({ watchCount: 1_001 })]);
	});

	it("fails closed before paging history beyond the production safety bound", async () => {
		const getHistory = vi.fn().mockResolvedValue({
			data: [],
			recordsFiltered: 100_001,
			recordsTotal: 100_001,
		});
		const mockClient = {
			getLibraries: vi
				.fn()
				.mockResolvedValue([
					{ section_id: "1", section_name: "Movies", section_type: "movie", count: "1" },
				]),
			getHistory,
			getMetadata: vi.fn(),
		} as unknown as TautulliClient;
		const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

		const result = await refreshTautulliCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages.join(" ")).toMatch(/exceeding the safe 100000-row refresh limit/i);
		expect(getHistory).toHaveBeenCalledOnce();
		expect(mockClient.getMetadata).not.toHaveBeenCalled();
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});

	it("fails closed when pagination repeats a row across pages", async () => {
		const rows = Array.from({ length: 200 }, (_, index) => ({
			row_id: index + 1,
			rating_key: `rk-${index}`,
			parent_rating_key: "",
			grandparent_rating_key: "",
			title: `Movie ${index}`,
			grandparent_title: "",
			media_type: "movie",
			user: "alice",
			date: 1_700_000_000 + index,
			play_count: 1,
		}));
		const mockClient = {
			getLibraries: vi
				.fn()
				.mockResolvedValue([
					{ section_id: "1", section_name: "Movies", section_type: "movie", count: "201" },
				]),
			getHistory: vi.fn(async ({ start }: { start: number }) => ({
				data: start === 0 ? rows : [rows[0]!],
				recordsFiltered: 201,
				recordsTotal: 201,
			})),
			getMetadata: vi.fn(),
		} as unknown as TautulliClient;
		const deleteMany = vi.fn();
		const prisma = { tautulliCache: { deleteMany } } as unknown as PrismaClient;

		const result = await refreshTautulliCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result.complete).toBe(false);
		expect(result.errors).toBeGreaterThan(0);
		expect(mockClient.getMetadata).not.toHaveBeenCalled();
		expect(deleteMany).not.toHaveBeenCalled();
	});

	it("applies the history row limit across all libraries before paging or publishing", async () => {
		const firstRow = {
			row_id: 1,
			rating_key: "rk-1",
			parent_rating_key: "",
			grandparent_rating_key: "",
			title: "Movie",
			grandparent_title: "",
			media_type: "movie",
			user: "alice",
			date: 1_700_000_000,
			play_count: 1,
		};
		const getHistory = vi
			.fn()
			.mockResolvedValueOnce({ data: [firstRow], recordsFiltered: 60_000, recordsTotal: 60_000 })
			.mockResolvedValueOnce({ data: [firstRow], recordsFiltered: 40_001, recordsTotal: 40_001 });
		const mockClient = {
			getLibraries: vi.fn().mockResolvedValue([
				{ section_id: "1", section_name: "Movies", section_type: "movie", count: "1" },
				{ section_id: "2", section_name: "More Movies", section_type: "movie", count: "1" },
			]),
			getHistory,
			getMetadata: vi.fn(),
		} as unknown as TautulliClient;
		const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

		const result = await refreshTautulliCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages.join(" ")).toMatch(/100001 aggregate rows/i);
		expect(getHistory).toHaveBeenCalledTimes(2);
		expect(mockClient.getMetadata).not.toHaveBeenCalled();
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});

	it("fails closed when new plays append during oldest-first paging", async () => {
		const history = Array.from({ length: 202 }, (_, index) => ({
			row_id: index + 1,
			rating_key: "rk-established",
			parent_rating_key: "",
			grandparent_rating_key: "",
			title: "Established Movie",
			grandparent_title: "",
			media_type: "movie",
			user: "alice",
			date: 1_700_000_000 + index,
			play_count: 1,
		}));
		const getHistory = vi
			.fn()
			.mockResolvedValueOnce({
				data: history.slice(0, 200),
				recordsFiltered: 201,
				recordsTotal: 201,
			})
			.mockResolvedValueOnce({
				data: history.slice(200, 201),
				recordsFiltered: 202,
				recordsTotal: 202,
			})
			.mockResolvedValueOnce({
				data: history.slice(1, 201),
				recordsFiltered: 202,
				recordsTotal: 202,
			});
		const mockClient = {
			getLibraries: vi
				.fn()
				.mockResolvedValue([
					{ section_id: "1", section_name: "Movies", section_type: "movie", count: "1" },
				]),
			getHistory,
			getMetadata: vi.fn().mockResolvedValue({
				guids: ["tmdb://12345"],
				media_type: "movie",
				title: "Established Movie",
				rating_key: "rk-established",
			}),
		} as unknown as TautulliClient;
		const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

		const result = await refreshTautulliCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages.join(" ")).toMatch(/changed before the snapshot/i);
		expect(prisma.$transaction).not.toHaveBeenCalled();
		expect(getHistory).toHaveBeenNthCalledWith(1, expect.objectContaining({ order_dir: "asc" }));
		expect(getHistory).toHaveBeenNthCalledWith(2, {
			section_id: "1",
			length: 1,
			start: 200,
			order_column: "row_id",
			order_dir: "asc",
			grouping: 0,
			include_activity: 0,
		});
	});

	it("fails closed when the first play appears after an empty-library probe", async () => {
		const firstPlay = {
			row_id: 1,
			rating_key: "rk-new",
			parent_rating_key: "",
			grandparent_rating_key: "",
			title: "Newly Watched",
			grandparent_title: "",
			media_type: "movie",
			user: "alice",
			date: 1_700_000_000,
			play_count: 1,
		};
		const getHistory = vi
			.fn()
			.mockResolvedValueOnce({ data: [], recordsFiltered: 0, recordsTotal: 0 })
			.mockResolvedValueOnce({ data: [firstPlay], recordsFiltered: 1, recordsTotal: 1 });
		const mockClient = {
			getLibraries: vi
				.fn()
				.mockResolvedValue([
					{ section_id: "1", section_name: "Movies", section_type: "movie", count: "1" },
				]),
			getHistory,
			getMetadata: vi.fn(),
		} as unknown as TautulliClient;
		const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

		const result = await refreshTautulliCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages.join(" ")).toMatch(/changed before the snapshot/i);
		expect(getHistory).toHaveBeenCalledTimes(2);
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});

	it("fails closed when history changes during metadata enrichment", async () => {
		const firstPlay = {
			row_id: 1,
			rating_key: "rk-established",
			parent_rating_key: "",
			grandparent_rating_key: "",
			title: "Established Movie",
			grandparent_title: "",
			media_type: "movie",
			user: "alice",
			date: 1_700_000_000,
			play_count: 1,
		};
		const secondPlay = { ...firstPlay, row_id: 2, date: 1_700_000_001 };
		const getHistory = vi
			.fn()
			.mockResolvedValueOnce({ data: [firstPlay], recordsFiltered: 1, recordsTotal: 1 })
			.mockResolvedValueOnce({
				data: [firstPlay, secondPlay],
				recordsFiltered: 2,
				recordsTotal: 2,
			});
		const mockClient = {
			getLibraries: vi
				.fn()
				.mockResolvedValue([
					{ section_id: "1", section_name: "Movies", section_type: "movie", count: "1" },
				]),
			getHistory,
			getMetadata: vi.fn().mockResolvedValue({
				guids: ["tmdb://12345"],
				media_type: "movie",
				title: "Established Movie",
			}),
		} as unknown as TautulliClient;
		const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

		const result = await refreshTautulliCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages.join(" ")).toMatch(/changed before the snapshot/i);
		expect(getHistory).toHaveBeenCalledTimes(2);
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});

	it("counts distinct same-second plays by stable row identity and disables grouping", async () => {
		const history = [
			{
				row_id: 10,
				rating_key: "rk-established",
				parent_rating_key: "",
				grandparent_rating_key: "",
				title: "Established Movie",
				grandparent_title: "",
				media_type: "movie",
				user: "alice",
				date: 1_700_000_000,
				play_count: 1,
			},
			{
				row_id: 11,
				rating_key: "rk-established",
				parent_rating_key: "",
				grandparent_rating_key: "",
				title: "Established Movie",
				grandparent_title: "",
				media_type: "movie",
				user: "alice",
				date: 1_700_000_000,
				play_count: 1,
			},
		];
		const getHistory = vi
			.fn()
			.mockResolvedValueOnce({ data: history, recordsFiltered: 2, recordsTotal: 2 })
			.mockResolvedValueOnce({
				data: history,
				recordsFiltered: 2,
				recordsTotal: 2,
			});
		const mockClient = {
			getLibraries: vi
				.fn()
				.mockResolvedValue([
					{ section_id: "1", section_name: "Movies", section_type: "movie", count: "1" },
				]),
			getHistory,
			getMetadata: vi.fn().mockResolvedValue({
				guids: ["tmdb://12345"],
				media_type: "movie",
				title: "Established Movie",
			}),
		} as unknown as TautulliClient;
		const publishedRows: Array<{ watchCount: number }> = [];
		const tx = {
			tautulliCache: {
				deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
				createMany: vi.fn(async ({ data }: { data: Array<{ watchCount: number }> }) => {
					publishedRows.push(...data);
					return { count: data.length };
				}),
			},
			cacheRefreshStatus: { upsert: vi.fn().mockResolvedValue({}) },
		};
		const prisma = {
			$transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
				callback(tx),
			),
		} as unknown as PrismaClient;

		const result = await refreshTautulliCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 1 });
		expect(publishedRows).toEqual([expect.objectContaining({ watchCount: 2 })]);
		expect(getHistory).toHaveBeenCalledWith(
			expect.objectContaining({ grouping: 0, include_activity: 0 }),
		);
	});

	it("fails closed when play_count reports aggregation even with group_count one", async () => {
		const mockClient = {
			getLibraries: vi
				.fn()
				.mockResolvedValue([
					{ section_id: "1", section_name: "Movies", section_type: "movie", count: "1" },
				]),
			getHistory: vi.fn().mockResolvedValue({
				data: [
					{
						row_id: 10,
						rating_key: "rk-established",
						parent_rating_key: "",
						grandparent_rating_key: "",
						title: "Established Movie",
						grandparent_title: "",
						media_type: "movie",
						user: "alice",
						date: 1_700_000_000,
						play_count: 2,
						group_count: 1,
					},
				],
				recordsFiltered: 1,
				recordsTotal: 1,
			}),
			getMetadata: vi.fn(),
		} as unknown as TautulliClient;
		const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

		const result = await refreshTautulliCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages.join(" ")).toMatch(/grouped play rows/i);
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});

	it("fails closed when Tautulli does not honor row_id ordering", async () => {
		const history = [2, 1].map((rowId) => ({
			row_id: rowId,
			rating_key: "rk-established",
			parent_rating_key: "",
			grandparent_rating_key: "",
			title: "Established Movie",
			grandparent_title: "",
			media_type: "movie",
			user: "alice",
			date: 1_700_000_000 + rowId,
			play_count: 1,
		}));
		const mockClient = {
			getLibraries: vi
				.fn()
				.mockResolvedValue([
					{ section_id: "1", section_name: "Movies", section_type: "movie", count: "1" },
				]),
			getHistory: vi.fn().mockResolvedValue({
				data: history,
				recordsFiltered: history.length,
				recordsTotal: history.length,
			}),
			getMetadata: vi.fn(),
		} as unknown as TautulliClient;
		const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

		const result = await refreshTautulliCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages.join(" ")).toMatch(/stable row ordering/i);
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});

	it("fails closed on equal-count churn in a middle page", async () => {
		const history = Array.from({ length: 401 }, (_, index) => ({
			row_id: index + 1,
			rating_key: "rk-established",
			parent_rating_key: "",
			grandparent_rating_key: "",
			title: "Established Movie",
			grandparent_title: "",
			media_type: "movie",
			user: "alice",
			date: 1_700_000_000 + index,
			play_count: 1,
		}));
		let requestCount = 0;
		const getHistory = vi.fn(async ({ start, length }: { start: number; length: number }) => {
			requestCount++;
			const data = history.slice(start, start + length).map((item) => ({ ...item }));
			if (requestCount === 5) data[50] = { ...data[50]!, user: "bob" };
			return { data, recordsFiltered: history.length, recordsTotal: history.length };
		});
		const mockClient = {
			getLibraries: vi
				.fn()
				.mockResolvedValue([
					{ section_id: "1", section_name: "Movies", section_type: "movie", count: "1" },
				]),
			getHistory,
			getMetadata: vi.fn().mockResolvedValue({
				guids: ["tmdb://12345"],
				media_type: "movie",
				title: "Established Movie",
			}),
		} as unknown as TautulliClient;
		const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

		const result = await refreshTautulliCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages.join(" ")).toMatch(/changed before the snapshot/i);
		expect(getHistory).toHaveBeenCalledTimes(6);
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});

	it("fails closed without evicting when relevant history metadata has no TMDb mapping", async () => {
		const mockClient = {
			getLibraries: vi
				.fn()
				.mockResolvedValue([
					{ section_id: "1", section_name: "Movies", section_type: "movie", count: "1" },
				]),
			getHistory: vi.fn().mockResolvedValue({
				data: [
					{
						row_id: 1,
						rating_key: "rk-missing",
						parent_rating_key: "",
						grandparent_rating_key: "",
						title: "Missing Movie",
						grandparent_title: "",
						media_type: "movie",
						user: "alice",
						date: 1_700_000_000,
						play_count: 1,
					},
				],
				recordsFiltered: 1,
				recordsTotal: 1,
			}),
			getMetadata: vi.fn().mockResolvedValue({
				guids: [],
				media_type: "unknown",
				title: "",
			}),
		} as unknown as TautulliClient;
		const deleteMany = vi.fn();
		const prisma = {
			tautulliCache: {
				upsert: vi.fn(),
				findMany: vi.fn(),
				deleteMany,
			},
		} as unknown as PrismaClient;

		const result = await refreshTautulliCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: false, errors: 0, upserted: 0 });
		expect(deleteMany).not.toHaveBeenCalled();
	});
});
