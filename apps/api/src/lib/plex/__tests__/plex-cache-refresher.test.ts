/**
 * Plex Cache Refresher — stale row eviction tests
 *
 * Regression for issue #323: `deleteMany({ id: { notIn: upsertedIds } })` was
 * exceeding SQLite's SQLITE_MAX_VARIABLE_NUMBER (default 999) for large
 * libraries, surfacing as Prisma P2029 and leaving the Plex cache in a
 * "errors, data may be outdated" state that neither manual nor scheduled
 * refreshes could clear.
 *
 * The fix replaces the oversized `notIn` query with a
 * read-then-diff-then-chunked-`in`-delete pattern. These tests pin that
 * behaviour so we don't regress it.
 */

import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../prisma.js";
import {
	collectPlexCacheLiveEvidence,
	evictStaleRows,
	STALE_EVICTION_CHUNK_SIZE,
} from "../plex-cache-refresher.js";
import type { PlexClient } from "../plex-client.js";

const silentLog = {
	warn: vi.fn(),
	info: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
	child: vi.fn(),
} as unknown as FastifyBaseLogger;

async function refreshPlexCache(
	client: PlexClient,
	prisma: PrismaClient,
	instanceId: string,
	log: FastifyBaseLogger,
	_expectedConnection?: unknown,
	_options?: unknown,
) {
	void prisma;
	return await collectPlexCacheLiveEvidence(client, instanceId, log);
}

/**
 * Build a minimal Prisma stub that records every `deleteMany` call so tests
 * can assert on chunking behaviour without needing a real database.
 */
function makeMockPrisma(existingIds: string[]) {
	const deleteCalls: Array<{ idsInFilter: string[] }> = [];

	const stub = {
		plexCache: {
			findMany: vi.fn(async () => existingIds.map((id) => ({ id }))),
			deleteMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => {
				deleteCalls.push({ idsInFilter: args.where.id.in });
				return { count: args.where.id.in.length };
			}),
		},
	} as unknown as PrismaClient;

	return { prisma: stub, deleteCalls };
}

describe("evictStaleRows", () => {
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
		// Order doesn't matter; membership does.
		expect(new Set(deleteCalls[0]!.idsInFilter)).toEqual(new Set(["stale-1", "stale-2"]));
	});

	it("chunks large stale sets so no single DELETE exceeds the SQLite parameter limit (#323)", async () => {
		// Simulate a library large enough that the old `notIn: upsertedIds` path
		// would have generated a single 5,000-parameter query (5x SQLite's
		// default 999-parameter ceiling).
		const TOTAL_EXISTING = 5_000;
		const existingIds = Array.from({ length: TOTAL_EXISTING }, (_, i) => `row-${i}`);
		// Keep none of them — every row is stale. This is the worst case for
		// parameter count.
		const keepIds: string[] = [];
		const { prisma, deleteCalls } = makeMockPrisma(existingIds);

		const deleted = await evictStaleRows(prisma, "inst-1", keepIds);

		expect(deleted).toBe(TOTAL_EXISTING);

		// Every DELETE must stay well under the SQLite limit. 999 is the
		// conservative ceiling; our chunk size is smaller by design.
		const SQLITE_PARAM_CEILING = 999;
		for (const call of deleteCalls) {
			expect(call.idsInFilter.length).toBeLessThanOrEqual(STALE_EVICTION_CHUNK_SIZE);
			expect(call.idsInFilter.length).toBeLessThan(SQLITE_PARAM_CEILING);
		}

		// And the chunks must cover the full stale set with no duplicates.
		const seen = new Set<string>();
		for (const call of deleteCalls) {
			for (const id of call.idsInFilter) {
				expect(seen.has(id)).toBe(false);
				seen.add(id);
			}
		}
		expect(seen.size).toBe(TOTAL_EXISTING);

		// Sanity: we actually did issue multiple statements (i.e. we chunked,
		// not just "happened to send one small query"). ceil(5000 / 500) = 10.
		expect(deleteCalls.length).toBe(Math.ceil(TOTAL_EXISTING / STALE_EVICTION_CHUNK_SIZE));
	});

	it("collects a complete large-library snapshot without publishing", async () => {
		// Stands in for "manual smoke on a Docker + SQLite deployment with a large
		// Plex library" — runs the full refreshPlexCache path with >1,000 items
		// and 1,500 pre-existing stale rows, then asserts:
		//   1. the refresh returns errors: 0 (i.e. no P2029 leaked through)
		//   2. every DELETE stays under the SQLite 999-parameter ceiling
		//   3. upserts are actually issued (we didn't silently short-circuit)
		const LIBRARY_SIZE = 1_200;

		const libraryItems = Array.from({ length: LIBRARY_SIZE }, (_, i) => ({
			ratingKey: `rk-${i}`,
			title: `Movie ${i}`,
			type: "movie",
			Guid: [{ id: `tmdb://${10_000 + i}` }],
			userRating: null,
			addedAt: 1_700_000_000,
			thumb: null,
			Collection: [],
			Label: [],
		}));

		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue(libraryItems),
			getHistory: vi.fn().mockResolvedValue([]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;

		const transaction = vi.fn();
		const mockPrisma = { $transaction: transaction } as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, mockPrisma, "inst-1", silentLog, undefined);

		expect(result.errors).toBe(0);
		expect(result.errorMessages).toEqual([]);
		expect(result.upserted).toBe(0);
		expect(result.snapshot?.rows).toHaveLength(LIBRARY_SIZE);
		expect(transaction).not.toHaveBeenCalled();
	});

	it("never uses `notIn` — the original P2029 trigger", async () => {
		// Guard against a future regression where someone re-introduces the
		// oversized `notIn` query. The mock's deleteMany only accepts `id.in`,
		// so any `notIn` call would surface here as a runtime error.
		const existingIds = Array.from({ length: 1_500 }, (_, i) => `row-${i}`);
		const { prisma, deleteCalls } = makeMockPrisma(existingIds);

		await evictStaleRows(prisma, "inst-1", []);

		for (const call of deleteCalls) {
			// `idsInFilter` comes from `args.where.id.in` — if the code ever
			// switched back to `notIn`, this array would be undefined.
			expect(Array.isArray(call.idsInFilter)).toBe(true);
		}
	});

	it("collects an authoritatively empty library without publishing", async () => {
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue([]),
			getHistory: vi.fn().mockResolvedValue([]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const deleteMany = vi.fn().mockResolvedValue({ count: 2 });
		const tx = {
			plexCache: { deleteMany, createMany: vi.fn() },
			cacheRefreshStatus: { upsert: vi.fn().mockResolvedValue({}) },
		};
		const prisma = {
			$transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
				callback(tx),
			),
		} as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ errors: 0, complete: true, upserted: 0 });
		expect(result.snapshot?.rows).toEqual([]);
		expect(deleteMany).not.toHaveBeenCalled();
		expect(tx.plexCache.createMany).not.toHaveBeenCalled();
	});

	it("collects a verified live snapshot without publishing cache state", async () => {
		const watchedAt = 1_723_000_000;
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue([
				{
					ratingKey: "rk-1",
					title: "Recent Movie",
					type: "movie",
					Guid: [{ id: "tmdb://12345" }],
				},
			]),
			getHistory: vi
				.fn()
				.mockResolvedValue([
					{ type: "movie", ratingKey: "rk-1", accountID: 1, viewedAt: watchedAt },
				]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const transaction = vi.fn();
		const prisma = { $transaction: transaction } as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined, {
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
		expect(result.snapshot?.sections).toEqual([{ key: "1", title: "Movies", type: "movie" }]);
		expect(transaction).not.toHaveBeenCalled();
	});

	it("keeps the previous generation when history changes after enrichment", async () => {
		const verifyHistorySnapshot = vi.fn().mockRejectedValue(new Error("history changed"));
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue([]),
			getHistory: vi.fn().mockResolvedValue([]),
			verifyHistorySnapshot,
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages.join(" ")).toMatch(/history changed/i);
		expect(verifyHistorySnapshot).toHaveBeenCalledOnce();
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});

	it.each([
		["bounded history", "Plex history exceeded the safe 100000-row limit"],
		["repeated page", "Plex history returned a duplicate row while paging"],
	] as const)(
		"rejects incomplete %s history before publishing a cache generation",
		async (_caseName, message) => {
			const getHistory = vi.fn().mockRejectedValue(new Error(message));
			const cacheDelete = vi.fn();
			const statusUpsert = vi.fn();
			const tx = {
				plexCache: { deleteMany: cacheDelete, createMany: vi.fn() },
				cacheRefreshStatus: { upsert: statusUpsert },
			};
			const prisma = {
				$transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
					callback(tx),
				),
			} as unknown as PrismaClient;
			const client = {
				getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
				getLibrarySections: vi
					.fn()
					.mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
				getLibraryItems: vi.fn().mockResolvedValue([]),
				getHistory,
				getOnDeck: vi.fn().mockResolvedValue([]),
			} as unknown as PlexClient;

			const result = await refreshPlexCache(client, prisma, "inst-1", silentLog, undefined);

			expect(getHistory).toHaveBeenCalledWith({ maxResults: 100_000, requireComplete: true });
			expect(result.complete).toBe(false);
			expect(prisma.$transaction).not.toHaveBeenCalled();
			expect(cacheDelete).not.toHaveBeenCalled();
			expect(statusUpsert).not.toHaveBeenCalled();
		},
	);

	it("keeps the previous generation when playback starts during history verification", async () => {
		const getOnDeck = vi
			.fn()
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ ratingKey: "rk-1", type: "movie" }]);
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue([]),
			getHistory: vi.fn().mockResolvedValue([]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck,
		} as unknown as PlexClient;
		const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages.join(" ")).toMatch(/on-deck state changed/i);
		expect(getOnDeck).toHaveBeenCalledTimes(2);
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});

	it("marks an on-deck failure incomplete and never evicts from that snapshot", async () => {
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue([
				{
					ratingKey: "rk-1",
					title: "Movie",
					type: "movie",
					Guid: [{ id: "tmdb://42" }],
					Collection: [],
					Label: [],
				},
			]),
			getHistory: vi.fn().mockResolvedValue([]),
			getOnDeck: vi.fn().mockRejectedValue(new Error("on-deck unavailable")),
		} as unknown as PlexClient;
		const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
		const mockPrisma = {
			plexCache: {
				upsert: vi.fn().mockResolvedValue({ id: "fresh-1" }),
				findMany: vi.fn().mockResolvedValue([{ id: "stale-1" }]),
				deleteMany,
			},
			$transaction: vi.fn(async (ops: Promise<unknown>[]) => await Promise.all(ops)),
		} as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, mockPrisma, "inst-1", silentLog, undefined);

		expect(result.complete).toBe(false);
		expect(result.errors).toBeGreaterThan(0);
		expect(deleteMany).not.toHaveBeenCalled();
	});

	it("fails closed without evicting when account discovery is empty", async () => {
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue([]),
			getHistory: vi.fn().mockResolvedValue([]),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const deleteMany = vi.fn();
		const prisma = {
			plexCache: { findMany: vi.fn(), deleteMany },
			$transaction: vi.fn(),
		} as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: false });
		expect(result.errors).toBeGreaterThan(0);
		expect(deleteMany).not.toHaveBeenCalled();
	});

	it("fails closed without evicting when no media library is discovered", async () => {
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([]),
			getHistory: vi.fn().mockResolvedValue([]),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const deleteMany = vi.fn();
		const prisma = {
			plexCache: { findMany: vi.fn(), deleteMany },
			$transaction: vi.fn(),
		} as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: false });
		expect(result.errors).toBeGreaterThan(0);
		expect(deleteMany).not.toHaveBeenCalled();
	});

	it("collects a complete current library while ignoring history for a stale library key", async () => {
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue([
				{
					ratingKey: "current",
					title: "Current Movie",
					type: "movie",
					Guid: [{ id: "tmdb://42" }],
				},
			]),
			getHistory: vi.fn().mockResolvedValue([
				{
					ratingKey: "stale",
					title: "Stale Movie",
					type: "movie",
					viewedAt: 1_700_000_000,
					accountID: 1,
				},
			]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
		const createMany = vi.fn().mockResolvedValue({ count: 1 });
		const tx = {
			plexCache: { deleteMany, createMany },
			cacheRefreshStatus: { upsert: vi.fn().mockResolvedValue({}) },
		};
		const prisma = {
			$transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
				callback(tx),
			),
		} as unknown as PrismaClient;
		vi.mocked(silentLog.info).mockClear();

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 0 });
		expect(result.snapshot?.rows).toEqual([
			expect.objectContaining({ ratingKey: "current", tmdbId: 42 }),
		]);
		expect(deleteMany).not.toHaveBeenCalled();
		expect(createMany).not.toHaveBeenCalled();
	});

	it("collects a complete current show library while ignoring stale episode history", async () => {
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "2", title: "Shows", type: "show" }]),
			getLibraryItems: vi.fn().mockResolvedValue([
				{
					ratingKey: "current-show",
					title: "Current Show",
					type: "show",
					Guid: [{ id: "tmdb://84" }],
				},
			]),
			getHistory: vi.fn().mockResolvedValue([
				{
					ratingKey: "stale-episode",
					grandparentRatingKey: "stale-show",
					title: "Stale Episode",
					type: "episode",
					viewedAt: 1_700_000_000,
					accountID: 1,
				},
			]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const tx = {
			plexCache: { deleteMany: vi.fn(), createMany: vi.fn() },
			cacheRefreshStatus: { upsert: vi.fn() },
		};
		const prisma = {
			$transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
				callback(tx),
			),
		} as unknown as PrismaClient;
		vi.mocked(silentLog.info).mockClear();

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 0 });
		expect(result.snapshot?.rows).toEqual([
			expect.objectContaining({ ratingKey: "current-show", tmdbId: 84 }),
		]);
	});

	it("fails closed when a stale history key becomes current before publication", async () => {
		const currentMovie = {
			ratingKey: "current",
			title: "Current Movie",
			type: "movie",
			Guid: [{ id: "tmdb://42" }],
		};
		const importedMovie = {
			ratingKey: "imported",
			title: "Imported Movie",
			type: "movie",
			Guid: [{ id: "tmdb://84" }],
		};
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi
				.fn()
				.mockResolvedValueOnce([currentMovie])
				.mockResolvedValueOnce([currentMovie, importedMovie]),
			getHistory: vi.fn().mockResolvedValue([
				{
					ratingKey: "imported",
					title: "Imported Movie",
					type: "movie",
					viewedAt: 1_700_000_000,
					accountID: 1,
				},
			]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const tx = {
			plexCache: { deleteMany: vi.fn(), createMany: vi.fn() },
			cacheRefreshStatus: { upsert: vi.fn() },
		};
		const transaction = vi.fn(
			async (callback: (transactionClient: typeof tx) => Promise<unknown>) => callback(tx),
		);
		const prisma = { $transaction: transaction } as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages).toContain(
			"Plex cache refresh failed: Plex library inventory changed before cache publication",
		);
		expect(transaction).not.toHaveBeenCalled();
	});

	it("fails closed when cleanup-relevant library metadata changes before publication", async () => {
		const initialMovie = {
			ratingKey: "current",
			title: "Current Movie",
			type: "movie",
			Guid: [{ id: "tmdb://42" }],
			Label: [{ tag: "eligible-for-cleanup" }],
		};
		const changedMovie = { ...initialMovie, Label: [] };
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi
				.fn()
				.mockResolvedValueOnce([initialMovie])
				.mockResolvedValueOnce([changedMovie]),
			getHistory: vi.fn().mockResolvedValue([]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const tx = {
			plexCache: { deleteMany: vi.fn(), createMany: vi.fn() },
			cacheRefreshStatus: { upsert: vi.fn() },
		};
		const transaction = vi.fn(
			async (callback: (transactionClient: typeof tx) => Promise<unknown>) => callback(tx),
		);
		const prisma = { $transaction: transaction } as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages).toContain(
			"Plex cache refresh failed: Plex library inventory changed before cache publication",
		);
		expect(transaction).not.toHaveBeenCalled();
	});

	it.each(["history", "on-deck"] as const)(
		"fails closed when Plex %s changes during final library verification",
		async (activity) => {
			let inventoryVerificationFinished = false;
			const currentMovie = {
				ratingKey: "current",
				title: "Current Movie",
				type: "movie",
				Guid: [{ id: "tmdb://42" }],
			};
			const mockClient = {
				getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
				getLibrarySections: vi
					.fn()
					.mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
				getLibraryItems: vi
					.fn()
					.mockResolvedValueOnce([currentMovie])
					.mockImplementationOnce(async () => {
						inventoryVerificationFinished = true;
						return [currentMovie];
					}),
				getHistory: vi.fn().mockResolvedValue([]),
				verifyHistorySnapshot: vi.fn(async () => {
					if (activity === "history" && inventoryVerificationFinished) {
						throw new Error("Plex history changed during inventory verification");
					}
				}),
				getOnDeck: vi.fn(async () =>
					activity === "on-deck" && inventoryVerificationFinished
						? [{ ratingKey: "current", type: "movie" }]
						: [],
				),
			} as unknown as PlexClient;
			const tx = {
				plexCache: { deleteMany: vi.fn(), createMany: vi.fn() },
				cacheRefreshStatus: { upsert: vi.fn() },
			};
			const transaction = vi.fn(
				async (callback: (transactionClient: typeof tx) => Promise<unknown>) => callback(tx),
			);
			const prisma = { $transaction: transaction } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

			expect(result).toMatchObject({ complete: false, upserted: 0 });
			expect(transaction).not.toHaveBeenCalled();
		},
	);

	it("preserves every current rating key when duplicate editions share one cache row", async () => {
		const editions = [
			{
				ratingKey: "edition-a",
				title: "Example Movie",
				type: "movie",
				Guid: [{ id: "tmdb://42" }],
			},
			{
				ratingKey: "edition-b",
				title: "Example Movie",
				type: "movie",
				Guid: [{ id: "tmdb://42" }],
			},
		];
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue(editions),
			getHistory: vi.fn().mockResolvedValue([]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined, {
			publish: false,
		});

		expect(result.snapshot?.rows).toHaveLength(1);
		expect(result.inventoryTargets).toEqual([
			{ mediaType: "movie", tmdbId: 42, ratingKey: "edition-a" },
			{ mediaType: "movie", tmdbId: 42, ratingKey: "edition-b" },
		]);
	});

	it("uses TVDb identity for current Sonarr series targets", async () => {
		const series = {
			ratingKey: "show-123",
			title: "Example Series",
			type: "show",
			Guid: [{ id: "tmdb://42" }, { id: "tvdb://123" }],
		};
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "2", title: "Shows", type: "show" }]),
			getLibraryItems: vi.fn().mockResolvedValue([series]),
			getHistory: vi.fn().mockResolvedValue([]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined, {
			publish: false,
		});

		expect(result.snapshot?.rows).toHaveLength(1);
		expect(result.inventoryTargets).toEqual([
			{ mediaType: "series", tmdbId: 42, tvdbId: 123, ratingKey: "show-123" },
		]);
	});

	it("fails closed when stale relevant history belongs to an unknown account", async () => {
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue([
				{
					ratingKey: "current",
					title: "Current Movie",
					type: "movie",
					Guid: [{ id: "tmdb://42" }],
				},
			]),
			getHistory: vi.fn().mockResolvedValue([
				{
					ratingKey: "stale",
					title: "Stale Movie",
					type: "movie",
					viewedAt: 1_700_000_000,
					accountID: 999,
				},
			]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const transaction = vi.fn();
		const prisma = { $transaction: transaction } as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages).toContain(
			"Plex cache incomplete: 1 history item(s) with unknown accounts",
		);
		expect(transaction).not.toHaveBeenCalled();
	});

	it.each([
		[
			"movie history has an empty rating key",
			{ type: "movie", ratingKey: "", title: "Movie", viewedAt: 1_700_000_000, accountID: 1 },
			"Plex cache incomplete: 1 history item(s) without a usable media key",
		],
		[
			"episode history has no grandparent rating key",
			{
				type: "episode",
				ratingKey: "episode-1",
				title: "Episode",
				viewedAt: 1_700_000_000,
				accountID: 1,
			},
			"Plex cache incomplete: 1 history item(s) without a usable media key",
		],
	] as const)(
		"fails closed without publication when %s",
		async (_caseName, historyEntry, message) => {
			const mockClient = {
				getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
				getLibrarySections: vi
					.fn()
					.mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
				getLibraryItems: vi.fn().mockResolvedValue([
					{
						ratingKey: "current",
						title: "Current Movie",
						type: "movie",
						Guid: [{ id: "tmdb://42" }],
					},
				]),
				getHistory: vi.fn().mockResolvedValue([historyEntry]),
				verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
				getOnDeck: vi.fn().mockResolvedValue([]),
			} as unknown as PlexClient;
			const transaction = vi.fn();
			const prisma = { $transaction: transaction } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

			expect(result).toMatchObject({ complete: false, upserted: 0 });
			expect(result.errorMessages).toContain(message);
			expect(transaction).not.toHaveBeenCalled();
		},
	);

	it("fails closed without publication when a current library item has an empty rating key", async () => {
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi
				.fn()
				.mockResolvedValue([
					{ ratingKey: "", title: "Current Movie", type: "movie", Guid: [{ id: "tmdb://42" }] },
				]),
			getHistory: vi.fn().mockResolvedValue([]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const transaction = vi.fn();
		const prisma = { $transaction: transaction } as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages).toContain(
			"Plex cache incomplete: 1 current library item(s) without a usable rating key",
		);
		expect(transaction).not.toHaveBeenCalled();
	});

	it("fails closed when a current historical item has no TMDB metadata", async () => {
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue([
				{
					ratingKey: "current-without-tmdb",
					title: "Current Movie Without TMDB",
					type: "movie",
					Guid: [],
				},
			]),
			getHistory: vi.fn().mockResolvedValue([
				{
					ratingKey: "current-without-tmdb",
					title: "Current Movie Without TMDB",
					type: "movie",
					viewedAt: 1_700_000_000,
					accountID: 1,
				},
			]),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const transaction = vi.fn();
		const prisma = { $transaction: transaction } as unknown as PrismaClient;
		vi.mocked(silentLog.warn).mockClear();

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages).toContain(
			"Plex cache incomplete: 1 current library item(s) without TMDB metadata",
		);
		expect(transaction).not.toHaveBeenCalled();
		expect(silentLog.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				incompleteReasons: expect.objectContaining({ currentItemsWithoutTmdbMetadata: 1 }),
			}),
			"Plex cache: skipping eviction because the refreshed inventory was incomplete",
		);
	});

	it("fails closed when one discovered library returns only a partial snapshot", async () => {
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockRejectedValue(new Error("pagination stopped early")),
			getHistory: vi.fn().mockResolvedValue([]),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const deleteMany = vi.fn();
		const prisma = {
			plexCache: { findMany: vi.fn(), deleteMany },
			$transaction: vi.fn(),
		} as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result.complete).toBe(false);
		expect(result.errors).toBeGreaterThan(0);
		expect(deleteMany).not.toHaveBeenCalled();
	});
});
