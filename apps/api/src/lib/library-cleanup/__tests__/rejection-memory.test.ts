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
import { type RejectionMemoryWindow, resolveRejectionMemoryWindow } from "../cleanup-executor.js";

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
