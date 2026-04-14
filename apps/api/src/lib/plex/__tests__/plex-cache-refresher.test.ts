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
	STALE_EVICTION_CHUNK_SIZE,
} from "../plex-cache-refresher.js";
import type { PrismaClient } from "../../prisma.js";

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
