/**
 * Tests for the rejection-memory truth table (issue #474).
 *
 * `resolveRejectionMemoryWindow` is the load-bearing translation from the
 * (rule, config) pair to the executor's dedup branching. The truth table is
 * easy to get subtly wrong (null/0/N semantics + per-rule-override fallback),
 * so we pin every cell here.
 *
 * Encoding contract:
 *   - `rejectionMemoryDays = 0`    → mode "off"  (no memory; current pre-#474 behavior)
 *   - `rejectionMemoryDays = N>0`  → mode "days" (remember rejection for N days)
 *   - `rejectionMemoryDays = null` → mode "forever" (never re-propose until cleared)
 *
 * Per-rule override precedence:
 *   - `useGlobalRejectionMemory = true`  → inherit config's value
 *   - `useGlobalRejectionMemory = false` → use rule's own rejectionMemoryDays
 */

import { describe, expect, it } from "vitest";
import {
	buildDedupOrClauses,
	type RejectionMemoryWindow,
	resolveRejectionMemoryWindow,
} from "../cleanup-executor.js";

type ConfigSlice = Parameters<typeof resolveRejectionMemoryWindow>[1];
type RuleSlice = Parameters<typeof resolveRejectionMemoryWindow>[0];

const cfg = (days: number | null): ConfigSlice => ({ rejectionMemoryDays: days });
const inheritedRule = (): RuleSlice => ({
	useGlobalRejectionMemory: true,
	rejectionMemoryDays: 999, // ignored because override is off
});
const overrideRule = (days: number | null): RuleSlice => ({
	useGlobalRejectionMemory: false,
	rejectionMemoryDays: days,
});

describe("resolveRejectionMemoryWindow — inheriting from config", () => {
	it("config days=0 → mode 'off' (preserves pre-#474 behavior)", () => {
		const result = resolveRejectionMemoryWindow(inheritedRule(), cfg(0));
		expect(result).toEqual<RejectionMemoryWindow>({ mode: "off" });
	});

	it("config days=30 → mode 'days' with N=30", () => {
		expect(resolveRejectionMemoryWindow(inheritedRule(), cfg(30))).toEqual({
			mode: "days",
			days: 30,
		});
	});

	it("config days=null → mode 'forever'", () => {
		expect(resolveRejectionMemoryWindow(inheritedRule(), cfg(null))).toEqual({
			mode: "forever",
		});
	});

	it("rule's own days field is ignored when override is off", () => {
		// Rule says 90, but override is off → config (0) wins.
		const r: RuleSlice = { useGlobalRejectionMemory: true, rejectionMemoryDays: 90 };
		expect(resolveRejectionMemoryWindow(r, cfg(0))).toEqual({ mode: "off" });
	});
});

describe("resolveRejectionMemoryWindow — per-rule override", () => {
	it("rule days=0 with override → mode 'off' regardless of config", () => {
		expect(resolveRejectionMemoryWindow(overrideRule(0), cfg(null))).toEqual({
			mode: "off",
		});
	});

	it("rule days=N>0 with override → mode 'days' with that N", () => {
		expect(resolveRejectionMemoryWindow(overrideRule(7), cfg(30))).toEqual({
			mode: "days",
			days: 7,
		});
	});

	it("rule days=null with override → mode 'forever' regardless of config", () => {
		expect(resolveRejectionMemoryWindow(overrideRule(null), cfg(0))).toEqual({
			mode: "forever",
		});
	});

	it("override forever wins over config off", () => {
		// Operator wants permanent rejection on THIS rule even though the
		// global default is no-memory.
		expect(resolveRejectionMemoryWindow(overrideRule(null), cfg(0))).toEqual({
			mode: "forever",
		});
	});

	it("override off wins over config forever", () => {
		// Inverse: rule says always re-propose, even though global default
		// would have remembered the rejection forever.
		expect(resolveRejectionMemoryWindow(overrideRule(0), cfg(null))).toEqual({
			mode: "off",
		});
	});
});

// ============================================================================
// `buildDedupOrClauses` — the Prisma OR-clause shape that drives the actual
// dedup query inside executeWithApproval. The helper exists so we can pin the
// cutoff math + clause structure without mocking Prisma. Per-mode boundaries:
//   - off:     only the pending-dedup clause, no rejected-skip
//   - days:    rejected-skip with `reviewedAt: { gt: now - days }`
//   - forever: rejected-skip with no time bound
// ============================================================================

describe("buildDedupOrClauses", () => {
	// Fixed reference instant so the cutoff math is deterministic across runs.
	const NOW = new Date("2026-05-27T12:00:00.000Z");

	it("mode 'off' → only the pending-dedup clause (no rejection skip)", () => {
		const clauses = buildDedupOrClauses({ mode: "off" }, NOW);
		expect(clauses).toEqual([{ status: "pending" }]);
	});

	it("mode 'forever' → pending + unconditional rejected skip", () => {
		const clauses = buildDedupOrClauses({ mode: "forever" }, NOW);
		expect(clauses).toEqual([{ status: "pending" }, { status: "rejected" }]);
		// No reviewedAt clause on the rejected branch — forever means
		// "remember this rejection regardless of when it happened."
		const rejectedClause = clauses[1] as { status: string; reviewedAt?: unknown };
		expect(rejectedClause.reviewedAt).toBeUndefined();
	});

	it("mode 'days' → rejected skip with cutoff = now - N days", () => {
		const clauses = buildDedupOrClauses({ mode: "days", days: 7 }, NOW);
		expect(clauses).toHaveLength(2);
		expect(clauses[0]).toEqual({ status: "pending" });
		const rejectedClause = clauses[1] as { status: string; reviewedAt: { gt: Date } };
		expect(rejectedClause.status).toBe("rejected");
		// Cutoff: 7 days before NOW = 2026-05-20T12:00:00Z
		expect(rejectedClause.reviewedAt.gt.toISOString()).toBe("2026-05-20T12:00:00.000Z");
	});

	it("mode 'days' with days=1 → cutoff = 24h ago (smallest meaningful window)", () => {
		const clauses = buildDedupOrClauses({ mode: "days", days: 1 }, NOW);
		const rejectedClause = clauses[1] as { reviewedAt: { gt: Date } };
		expect(rejectedClause.reviewedAt.gt.toISOString()).toBe("2026-05-26T12:00:00.000Z");
	});

	it("mode 'days' with days=365 → cutoff = 1y ago (sanity on large windows)", () => {
		const clauses = buildDedupOrClauses({ mode: "days", days: 365 }, NOW);
		const rejectedClause = clauses[1] as { reviewedAt: { gt: Date } };
		expect(rejectedClause.reviewedAt.gt.toISOString()).toBe("2025-05-27T12:00:00.000Z");
	});

	it("default `now` argument falls back to Date.now() — production-ready without injection", () => {
		// The argumentless form is what the executor uses in production. Verify
		// it doesn't throw and produces a cutoff within ~1s of now (i.e. uses
		// the system clock rather than e.g. a hard-coded epoch).
		const before = Date.now();
		const clauses = buildDedupOrClauses({ mode: "days", days: 30 });
		const after = Date.now();
		const rejectedClause = clauses[1] as { reviewedAt: { gt: Date } };
		const cutoff = rejectedClause.reviewedAt.gt.getTime();
		const expectedRangeMin = before - 30 * 86400000;
		const expectedRangeMax = after - 30 * 86400000;
		expect(cutoff).toBeGreaterThanOrEqual(expectedRangeMin);
		expect(cutoff).toBeLessThanOrEqual(expectedRangeMax);
	});
});
