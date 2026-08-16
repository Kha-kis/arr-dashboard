import { describe, expect, it } from "vitest";
import { planApprovalCleanupSelection, planDirectCleanupSelection } from "../selection-planner.js";

const fresh = (...keys: string[]) => keys.map((key) => ({ key, value: key }));
const freshCandidate = (key: string, value: string) => ({ key, value });
const retry = (id: string, reviewedAt: Date | null = null) => ({
	id,
	key: id,
	value: id,
	reviewedAt,
	createdAt: new Date("2026-06-01T00:00:00.000Z"),
});

describe("planDirectCleanupSelection", () => {
	it("uses deterministic retry order and reserves only remaining budget for fresh work", () => {
		const plan = planDirectCleanupSelection({
			limit: 3,
			fresh: fresh("fresh-1", "fresh-2", "fresh-3"),
			pendingRetries: [retry("retry-2"), retry("retry-1")],
			inFlightRetries: [],
			retryStateLoaded: true,
		});

		expect(plan.selectedRetries.map((candidate) => candidate.id)).toEqual(["retry-1", "retry-2"]);
		expect(plan.selectedFresh.map((candidate) => candidate.key)).toEqual(["fresh-1"]);
		expect(plan.counts.deferredBudget).toBe(2);
	});

	it("deduplicates fresh candidates before the run budget", () => {
		const plan = planDirectCleanupSelection({
			limit: 2,
			fresh: [
				freshCandidate("first", "first"),
				freshCandidate("first", "first-duplicate-before-limit"),
				freshCandidate("second", "second"),
				freshCandidate("first", "first-duplicate-after-limit"),
				freshCandidate("third", "third"),
			],
			pendingRetries: [],
			inFlightRetries: [],
			retryStateLoaded: true,
		});

		expect(plan.selectedFresh.map((candidate) => candidate.value)).toEqual(["first", "second"]);
		expect(plan.counts).toMatchObject({
			selectedFresh: 2,
			deferredDuplicateTarget: 2,
			deferredBudget: 1,
			total: 5,
		});
	});

	it("defers retries attempted since the prior run when distinct fresh work exists", () => {
		const boundary = new Date("2026-07-01T00:00:00.000Z");
		const plan = planDirectCleanupSelection({
			limit: 2,
			fresh: fresh("retry-new", "fresh-1", "fresh-2"),
			pendingRetries: [
				retry("retry-old", new Date("2026-06-30T23:59:59.000Z")),
				retry("retry-new", boundary),
			],
			inFlightRetries: [],
			previousRunStartedAt: boundary,
			retryStateLoaded: true,
		});

		expect(plan.selectedRetries.map((candidate) => candidate.id)).toEqual(["retry-old"]);
		expect(plan.selectedFresh.map((candidate) => candidate.key)).toEqual(["fresh-1"]);
		expect(plan.counts.deferredRetryFairness).toBe(1);
	});

	it("reports in-flight work without selecting its matching fresh target", () => {
		const plan = planDirectCleanupSelection({
			limit: 2,
			fresh: fresh("in-flight", "fresh"),
			pendingRetries: [],
			inFlightRetries: [retry("in-flight")],
			retryStateLoaded: true,
		});

		expect(plan.selectedFresh.map((candidate) => candidate.key)).toEqual(["fresh"]);
		expect(plan.counts).toMatchObject({ inFlight: 1, deferredInFlightTarget: 1, total: 3 });
	});

	it("defers pending retries whose target is owned by an in-flight record", () => {
		const timestamp = new Date("2026-07-01T00:00:00.000Z");
		const plan = planDirectCleanupSelection({
			limit: 2,
			fresh: fresh("same-target", "fresh"),
			pendingRetries: [
				{ ...retry("pending-z", timestamp), key: "same-target", createdAt: timestamp },
				{ ...retry("pending-a", timestamp), key: "same-target", createdAt: timestamp },
			],
			inFlightRetries: [
				{ ...retry("executing", timestamp), key: "same-target", createdAt: timestamp },
			],
			retryStateLoaded: true,
		});

		expect(plan.selectedRetries).toEqual([]);
		expect(plan.selectedFresh.map((candidate) => candidate.key)).toEqual(["fresh"]);
		expect(plan.counts).toMatchObject({
			deferredInFlightTarget: 2,
			deferredDuplicateTarget: 1,
			inFlight: 1,
			total: 5,
		});
	});

	it("elects one stable pending owner per target regardless of database order", () => {
		const timestamp = new Date("2026-07-01T00:00:00.000Z");
		const pending = [
			{ ...retry("retry-z", timestamp), key: "same-retry", createdAt: timestamp },
			{ ...retry("retry-b", timestamp), key: "other-retry", createdAt: timestamp },
			{ ...retry("retry-a", timestamp), key: "same-retry", createdAt: timestamp },
		];
		const inputFresh = [
			freshCandidate("same-retry", "fresh-shadowed-by-retry"),
			freshCandidate("fresh", "fresh-first"),
			freshCandidate("fresh", "fresh-duplicate"),
			freshCandidate("last", "last-budget-deferred"),
		];
		const buildPlan = (pendingRetries: typeof pending) =>
			planDirectCleanupSelection({
				limit: 3,
				fresh: inputFresh,
				pendingRetries,
				inFlightRetries: [],
				retryStateLoaded: true,
			});

		for (const plan of [buildPlan(pending), buildPlan([...pending].reverse())]) {
			expect(plan.selectedRetries.map((candidate) => candidate.id)).toEqual(["retry-a", "retry-b"]);
			expect(plan.selectedFresh.map((candidate) => candidate.value)).toEqual(["fresh-first"]);
			expect(plan.counts).toMatchObject({
				selectedRetries: 2,
				selectedFresh: 1,
				deferredDuplicateTarget: 3,
				deferredBudget: 1,
				total: 7,
			});
		}
	});

	it("fails closed when durable retry state is unavailable", () => {
		const plan = planDirectCleanupSelection({
			limit: 100,
			fresh: fresh("first", "second"),
			pendingRetries: [],
			inFlightRetries: [],
			retryStateLoaded: false,
		});

		expect(plan.selectedFresh).toEqual([]);
		expect(plan.selectedRetries).toEqual([]);
		expect(plan.counts).toMatchObject({ retryStateUnavailable: 2, retryState: "unavailable" });
	});

	it.each([
		{ limit: 0, selected: [] },
		{ limit: -1, selected: [] },
		{ limit: 1, selected: ["first"] },
		{ limit: 2, selected: ["first", "second"] },
		{ limit: 101, selected: [] },
	])("applies maxRemovalsPerRun boundary $limit", ({ limit, selected }) => {
		const plan = planDirectCleanupSelection({
			limit,
			fresh: fresh("first", "second", "third"),
			pendingRetries: [],
			inFlightRetries: [],
			retryStateLoaded: true,
		});

		expect(plan.selectedFresh.map((candidate) => candidate.key)).toEqual(selected);
	});
});

describe("planApprovalCleanupSelection", () => {
	it("applies approval memory before the hard run budget", () => {
		const plan = planApprovalCleanupSelection({
			limit: 2,
			fresh: fresh("pending", "rejected", "selected-1", "selected-2", "deferred"),
			approvalExclusions: new Map([
				["pending", "Already pending in the approval queue"],
				["rejected", "Previously rejected"],
			]),
			nonterminalRetryKeys: new Set(),
			inFlightRetries: [],
			retryStateLoaded: true,
		});

		expect(plan.selectedFresh.map((candidate) => candidate.key)).toEqual([
			"selected-1",
			"selected-2",
		]);
		expect(plan.counts).toMatchObject({ deferredApproval: 2, deferredBudget: 1 });
	});

	it("defers durable retry ownership and duplicate fresh targets before selection", () => {
		const plan = planApprovalCleanupSelection({
			limit: 2,
			fresh: fresh("retry-owned", "first", "first", "second"),
			approvalExclusions: new Map(),
			nonterminalRetryKeys: new Set(["retry-owned"]),
			inFlightRetries: [],
			retryStateLoaded: true,
		});

		expect(plan.selectedFresh.map((candidate) => candidate.key)).toEqual(["first", "second"]);
		expect(plan.counts).toMatchObject({
			deferredApproval: 1,
			deferredDuplicateTarget: 1,
		});
	});

	it("reports in-flight retries without charging approval-run budget", () => {
		const plan = planApprovalCleanupSelection({
			limit: 1,
			fresh: fresh("fresh"),
			approvalExclusions: new Map(),
			nonterminalRetryKeys: new Set(),
			inFlightRetries: [retry("executing")],
			retryStateLoaded: true,
		});

		expect(plan.selectedFresh.map((candidate) => candidate.key)).toEqual(["fresh"]);
		expect(plan.counts).toMatchObject({ selectedFresh: 1, inFlight: 1, total: 2 });
	});

	it("represents an in-flight target once when the same target still matches a rule", () => {
		const plan = planApprovalCleanupSelection({
			limit: 1,
			fresh: fresh("executing", "fresh"),
			approvalExclusions: new Map(),
			nonterminalRetryKeys: new Set(["executing"]),
			inFlightRetries: [retry("executing"), { ...retry("duplicate"), key: "executing" }],
			retryStateLoaded: true,
		});

		expect(plan.selectedFresh.map((candidate) => candidate.key)).toEqual(["fresh"]);
		expect(plan.counts).toMatchObject({ selectedFresh: 1, inFlight: 1, total: 2 });
		expect(
			plan.decisions.filter((decision) => decision.candidate.key === "executing"),
		).toHaveLength(1);
	});

	it("fails closed when approval or retry state is unavailable", () => {
		const plan = planApprovalCleanupSelection({
			limit: 2,
			fresh: fresh("first", "second"),
			approvalExclusions: new Map(),
			nonterminalRetryKeys: new Set(),
			inFlightRetries: [],
			retryStateLoaded: false,
		});

		expect(plan.selectedFresh).toEqual([]);
		expect(plan.counts).toMatchObject({
			retryState: "unavailable",
			retryStateUnavailable: 2,
		});
	});
});
