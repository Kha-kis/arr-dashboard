/**
 * Tautulli Cache Refresher — stale row eviction tests
 *
 * Proactive hardening to match the Plex fix from PR #328 / issue #323.
 *
 * The original `deleteMany({ id: { notIn: upsertedIds } })` shape would
 * exceed SQLite's SQLITE_MAX_VARIABLE_NUMBER (default 999) whenever the
 * upsert set is large, surfacing as Prisma P2029. These tests pin the
 * replacement read-then-diff-then-chunked-`in`-delete contract so the
 * Tautulli refresher cannot regress into the same failure mode.
 */

import { describe, expect, it, vi } from "vitest";
import {
	evictStaleRows,
	STALE_EVICTION_CHUNK_SIZE,
} from "../tautulli-cache-refresher.js";
import type { PrismaClient } from "../../prisma.js";

/**
 * Build a minimal Prisma stub that records every `deleteMany` call so tests
 * can assert on chunking behaviour without needing a real database.
 */
function makeMockPrisma(existingIds: string[]) {
	const deleteCalls: Array<{ idsInFilter: string[] }> = [];

	const stub = {
		tautulliCache: {
			findMany: vi.fn(async () => existingIds.map((id) => ({ id }))),
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
