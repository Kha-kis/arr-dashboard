/**
 * C3 closeout — cleanup-side list-membership prefetch.
 *
 * Pins the contract that makes tmdb_list_member / trakt_list_member
 * rules WORK in cleanup runs: identifiers are collected from both
 * top-level rule params and composite sub-conditions, memberships load
 * from the per-user cache tables, and absent kinds cost zero queries.
 */

import { describe, expect, it, vi } from "vitest";
import { prefetchCleanupListMemberships } from "./cleanup-executor.js";
import type { CleanupExecutorDeps } from "./types.js";
import type { LibraryCleanupRule } from "../prisma.js";

function rule(overrides: Partial<LibraryCleanupRule>): LibraryCleanupRule {
	return {
		id: "r1",
		name: "Rule",
		enabled: true,
		ruleType: "age",
		parameters: "{}",
		operator: null,
		conditions: null,
	} as unknown as LibraryCleanupRule;
	// minimal stub; only fields the collector reads
}

function makeDeps(tmdbRows: Array<{ listId: string; tmdbId: number }>) {
	const findMany = vi.fn().mockResolvedValue(tmdbRows);
	return {
		deps: { prisma: { tmdbListCache: { findMany }, traktListCache: { findMany: vi.fn().mockResolvedValue([]) } } } as unknown as CleanupExecutorDeps,
		findMany,
	};
}

describe("prefetchCleanupListMemberships", () => {
	it("collects identifiers from top-level params AND composite conditions", async () => {
		const rules = [
			{ ...rule({}), ruleType: "tmdb_list_member", parameters: JSON.stringify({ listId: "8068", operator: "is_in" }) },
			{
				...rule({}),
				ruleType: "composite",
				operator: "AND",
				conditions: JSON.stringify([
					{ ruleType: "tmdb_list_member", parameters: { listId: "1234", operator: "not_in" } },
					{ ruleType: "age", parameters: { operator: "older_than", days: 30 } },
				]),
			},
		] as LibraryCleanupRule[];
		const { deps, findMany } = makeDeps([
			{ listId: "8068", tmdbId: 100 },
			{ listId: "8068", tmdbId: 200 },
			{ listId: "1234", tmdbId: 300 },
		]);

		const map = await prefetchCleanupListMemberships(deps, "user-1", rules, "tmdb");

		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { userId: "user-1", listId: { in: expect.arrayContaining(["8068", "1234"]) } },
			}),
		);
		expect(map.get("8068")).toEqual(new Set([100, 200]));
		expect(map.get("1234")).toEqual(new Set([300]));
	});

	it("returns an empty map with ZERO queries when no rule references the kind", async () => {
		const { deps, findMany } = makeDeps([]);
		const map = await prefetchCleanupListMemberships(
			deps,
			"user-1",
			[rule({})] as LibraryCleanupRule[],
			"tmdb",
		);
		expect(map.size).toBe(0);
		expect(findMany).not.toHaveBeenCalled();
	});

	it("unknown/unrefreshed list yields an absent map entry (evaluator no-match, never a throw)", async () => {
		const rules = [
			{ ...rule({}), ruleType: "tmdb_list_member", parameters: JSON.stringify({ listId: "999", operator: "is_in" }) },
		] as LibraryCleanupRule[];
		const { deps } = makeDeps([]); // cache has nothing for list 999
		const map = await prefetchCleanupListMemberships(deps, "user-1", rules, "tmdb");
		expect(map.get("999")).toBeUndefined();
	});
});
