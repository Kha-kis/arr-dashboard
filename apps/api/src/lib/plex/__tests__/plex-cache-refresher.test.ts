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

import { describe, expect, it, vi } from "vitest";
import {
	evictStaleRows,
	refreshPlexCache,
	STALE_EVICTION_CHUNK_SIZE,
} from "../plex-cache-refresher.js";
import type { PlexClient } from "../plex-client.js";
import type { PrismaClient } from "../../prisma.js";
import type { FastifyBaseLogger } from "fastify";

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

	it("large-library end-to-end: refreshPlexCache completes with zero errors and no oversized DELETE (#323 regression)", async () => {
		// Stands in for "manual smoke on a Docker + SQLite deployment with a large
		// Plex library" — runs the full refreshPlexCache path with >1,000 items
		// and 1,500 pre-existing stale rows, then asserts:
		//   1. the refresh returns errors: 0 (i.e. no P2029 leaked through)
		//   2. every DELETE stays under the SQLite 999-parameter ceiling
		//   3. upserts are actually issued (we didn't silently short-circuit)
		const LIBRARY_SIZE = 1_200;
		const STALE_COUNT = 1_500;

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
			getLibrarySections: vi
				.fn()
				.mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue(libraryItems),
			getHistory: vi.fn().mockResolvedValue([]),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;

		// Pre-populate the "existing rows" list with the fresh upsert ids plus
		// a large stale tail — enough that the old `notIn: upsertedIds` path
		// would have been >999 params and tripped P2029.
		const upsertedIds: string[] = [];
		const existingIds: string[] = Array.from(
			{ length: STALE_COUNT },
			(_, i) => `stale-${i}`,
		);

		const deleteCalls: Array<{ idsInFilter: string[] }> = [];

		const mockPrisma = {
			plexCache: {
				upsert: vi.fn(async () => {
					const id = `fresh-${upsertedIds.length}`;
					upsertedIds.push(id);
					return { id };
				}),
				findMany: vi.fn(async () =>
					// Reflects state after upserts: the original stale rows + the
					// freshly-upserted rows. Eviction should keep the fresh set.
					[...existingIds, ...upsertedIds].map((id) => ({ id })),
				),
				deleteMany: vi.fn(
					async (args: { where: { id?: { in?: string[]; notIn?: string[] } } }) => {
						const inList = args.where.id?.in;
						if (!inList) {
							throw new Error(
								"Regression: DELETE used something other than `id: { in: [...] }` — likely a reintroduced notIn.",
							);
						}
						deleteCalls.push({ idsInFilter: inList });
						return { count: inList.length };
					},
				),
			},
			$transaction: vi.fn(async (ops: Promise<unknown>[] | unknown[]) => {
				const results: unknown[] = [];
				for (const op of ops) results.push(await op);
				return results;
			}),
		} as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, mockPrisma, "inst-1", silentLog);

		expect(result.errors).toBe(0);
		expect(result.errorMessages).toEqual([]);
		expect(result.upserted).toBe(LIBRARY_SIZE);

		// Every eviction DELETE must stay safely under SQLite's parameter ceiling.
		const SQLITE_PARAM_CEILING = 999;
		expect(deleteCalls.length).toBeGreaterThan(0);
		for (const call of deleteCalls) {
			expect(call.idsInFilter.length).toBeLessThanOrEqual(STALE_EVICTION_CHUNK_SIZE);
			expect(call.idsInFilter.length).toBeLessThan(SQLITE_PARAM_CEILING);
		}

		// Chunks should together wipe exactly the stale set, nothing more.
		const deletedIds = deleteCalls.flatMap((c) => c.idsInFilter);
		expect(deletedIds.length).toBe(STALE_COUNT);
		expect(new Set(deletedIds)).toEqual(new Set(existingIds));
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
});
