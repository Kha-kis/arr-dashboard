/**
 * Unit tests for Library Cleanup's qui seeding filter (Phase 2.2).
 *
 * The filter is small but security-sensitive: a regression that drops
 * the NULL-state clause would silently exclude every legitimate
 * candidate from users who have never configured qui — turning Library
 * Cleanup into a no-op for them. Pin the shape so a future refactor
 * can't slip that past.
 */

import { describe, expect, it } from "vitest";
import { applyQuiSeedingFilter, type CleanupBaseWhere } from "../qui-filter.js";

const seed = (): CleanupBaseWhere => ({ instanceId: { in: ["inst-1", "inst-2"] } });

describe("applyQuiSeedingFilter", () => {
	it("is a no-op when respectQuiSeeding is false", () => {
		const where = seed();
		const result = applyQuiSeedingFilter(where, false);
		expect(result).toBe(where); // same ref — callers chain.
		expect(result.OR).toBeUndefined();
		expect(result.instanceId).toEqual({ in: ["inst-1", "inst-2"] });
	});

	it("adds an OR clause that keeps NULL-state rows in the candidate set", () => {
		const where = applyQuiSeedingFilter(seed(), true);
		// The NULL branch is the load-bearing piece: users without qui
		// configured have every LibraryCache row with `torrentState: null`.
		// Dropping the NULL branch would gate them out entirely — the
		// feature would become a no-op for users who never configured qui.
		expect(where.OR).toEqual([
			{ torrentState: null },
			{ torrentState: { notIn: ["seeding", "downloading"] } },
		]);
	});

	it("only excludes 'seeding' and 'downloading' — not 'paused' or 'error'", () => {
		const where = applyQuiSeedingFilter(seed(), true);
		// Distinct from `queue-cleaner/qui-gate.ts:GATED_STATES` (paused/error).
		// The two gates key on different state subsets on purpose:
		//   - Cleanup respects seeding obligations.
		//   - Queue cleaner skips strikes when qui or operator is already acting.
		// Mixing them would either delete actively-seeding items (wrong) or
		// strike paused items (wrong in a different way).
		const orClause = where.OR?.[1] as { torrentState: { notIn: string[] } };
		expect(orClause.torrentState.notIn).toEqual(["seeding", "downloading"]);
		expect(orClause.torrentState.notIn).not.toContain("paused");
		expect(orClause.torrentState.notIn).not.toContain("error");
	});

	it("preserves the existing instanceId filter when adding OR", () => {
		const where = applyQuiSeedingFilter(seed(), true);
		expect(where.instanceId).toEqual({ in: ["inst-1", "inst-2"] });
	});
});
