import { describe, expect, it } from "vitest";
import { planCleanupSelection } from "../selection-planner.js";

const fresh = (...keys: string[]) => keys.map((key) => ({ key, value: key }));
const freshCandidate = (key: string, value: string) => ({ key, value });
const retry = (id: string, reviewedAt: Date | null = null) => ({
	id,
	key: id,
	value: id,
	reviewedAt,
	createdAt: new Date("2026-06-01T00:00:00.000Z"),
});

describe("planCleanupSelection", () => {
	it("excludes approval memory before applying the run limit", () => {
		const plan = planCleanupSelection({
			mode: "approval",
			limit: 2,
			fresh: fresh("pending", "rejected", "first", "second", "capped"),
			approvalExclusions: new Map([
				["pending", "Already pending approval"],
				["rejected", "Previously rejected — rejection memory: forever"],
			]),
			nonterminalRetryKeys: new Set(),
			inFlightRetries: [],
			retryStateLoaded: true,
		});

		expect(plan.selectedFresh.map((candidate) => candidate.key)).toEqual(["first", "second"]);
		expect(plan.counts).toMatchObject({
			selectedFresh: 2,
			deferredApproval: 2,
			deferredBudget: 1,
		});
	});

	it("deduplicates approval candidates before applying the run budget", () => {
		const plan = planCleanupSelection({
			mode: "approval",
			limit: 2,
			fresh: [
				freshCandidate("same", "same-first"),
				freshCandidate("same", "same-duplicate-before-limit"),
				freshCandidate("distinct", "distinct"),
			],
			approvalExclusions: new Map(),
			nonterminalRetryKeys: new Set(),
			inFlightRetries: [],
			retryStateLoaded: true,
		});

		expect(plan.selectedFresh.map((candidate) => candidate.value)).toEqual([
			"same-first",
			"distinct",
		]);
		expect(plan.counts).toMatchObject({
			selectedFresh: 2,
			deferredDuplicateTarget: 1,
			deferredBudget: 0,
			total: 3,
		});
		expect(
			plan.decisions.find((decision) => decision.candidate.value === "same-duplicate-before-limit"),
		).toMatchObject({
			disposition: "deferred_duplicate_target",
			reason: expect.stringContaining("already owns this cleanup target"),
		});
	});

	it("classifies an approval duplicate after the limit separately from budget deferral", () => {
		const plan = planCleanupSelection({
			mode: "approval",
			limit: 2,
			fresh: [
				freshCandidate("first", "first"),
				freshCandidate("second", "second"),
				freshCandidate("first", "first-duplicate-after-limit"),
				freshCandidate("third", "third"),
			],
			approvalExclusions: new Map(),
			nonterminalRetryKeys: new Set(),
			inFlightRetries: [],
			retryStateLoaded: true,
		});

		expect(plan.selectedFresh.map((candidate) => candidate.value)).toEqual(["first", "second"]);
		expect(plan.counts).toMatchObject({
			deferredDuplicateTarget: 1,
			deferredBudget: 1,
			total: 4,
		});
		expect(
			plan.decisions.find((decision) => decision.candidate.value === "first-duplicate-after-limit")
				?.disposition,
		).toBe("deferred_duplicate_target");
		expect(
			plan.decisions.find((decision) => decision.candidate.value === "third")?.disposition,
		).toBe("deferred_budget");
	});

	it("fails every approval candidate closed when retry or dedup state is incomplete", () => {
		const plan = planCleanupSelection({
			mode: "approval",
			limit: 2,
			fresh: fresh("first", "second"),
			approvalExclusions: new Map(),
			nonterminalRetryKeys: new Set(),
			inFlightRetries: [],
			retryStateLoaded: false,
		});

		expect(plan.selectedFresh).toEqual([]);
		expect(plan.counts).toMatchObject({
			selectedFresh: 0,
			inFlight: 0,
			retryStateUnavailable: 2,
			retryState: "unavailable",
			total: 2,
		});
	});

	it("reports approval in-flight retries without consuming fresh approval budget", () => {
		const plan = planCleanupSelection({
			mode: "approval",
			limit: 2,
			fresh: fresh("first", "second", "third"),
			approvalExclusions: new Map(),
			nonterminalRetryKeys: new Set(["running"]),
			inFlightRetries: [retry("running")],
			retryStateLoaded: true,
		});

		expect(plan.selectedFresh.map((candidate) => candidate.key)).toEqual(["first", "second"]);
		expect(plan.selectedRetries).toEqual([]);
		expect(plan.counts).toMatchObject({
			selectedFresh: 2,
			inFlight: 1,
			deferredBudget: 1,
			retryState: "complete",
			total: 4,
		});
	});

	it("uses deterministic retry order and reserves only the remaining budget for fresh work", () => {
		const plan = planCleanupSelection({
			mode: "direct",
			limit: 3,
			fresh: fresh("fresh-1", "fresh-2", "fresh-3"),
			pendingRetries: [retry("retry-1"), retry("retry-2")],
			inFlightRetries: [],
			retryStateLoaded: true,
		});

		expect(plan.selectedRetries.map((candidate) => candidate.id)).toEqual(["retry-1", "retry-2"]);
		expect(plan.selectedFresh.map((candidate) => candidate.key)).toEqual(["fresh-1"]);
		expect(plan.counts.deferredBudget).toBe(2);
	});

	it("deduplicates direct fresh candidates on both sides of the budget boundary", () => {
		const plan = planCleanupSelection({
			mode: "direct",
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
		expect(
			plan.decisions
				.filter((decision) => decision.disposition === "deferred_duplicate_target")
				.map((decision) => decision.candidate.value),
		).toEqual(["first-duplicate-before-limit", "first-duplicate-after-limit"]);
	});

	it("defers retries attempted since the prior run when distinct fresh work exists", () => {
		const boundary = new Date("2026-07-01T00:00:00.000Z");
		const plan = planCleanupSelection({
			mode: "direct",
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

	it("reports in-flight work without duplicating the matching fresh target", () => {
		const plan = planCleanupSelection({
			mode: "direct",
			limit: 2,
			fresh: fresh("in-flight", "fresh"),
			pendingRetries: [],
			inFlightRetries: [retry("in-flight")],
			retryStateLoaded: true,
		});

		expect(plan.selectedFresh.map((candidate) => candidate.key)).toEqual(["fresh"]);
		expect(plan.counts.inFlight).toBe(1);
		expect(plan.counts.deferredDuplicateTarget).toBe(1);
		expect(plan.counts.total).toBe(3);
	});

	it("defers every pending retry whose target is owned by an in-flight record", () => {
		const timestamp = new Date("2026-07-01T00:00:00.000Z");
		const plan = planCleanupSelection({
			mode: "direct",
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
			deferredInFlightTarget: 1,
			deferredDuplicateTarget: 2,
			inFlight: 1,
			retryState: "complete",
			total: 5,
		});
		expect(
			plan.decisions
				.filter((decision) => decision.disposition === "deferred_in_flight_target")
				.map((decision) => decision.candidate.value),
		).toEqual(["pending-a"]);
		expect(
			plan.decisions.find((decision) => decision.candidate.value === "pending-a")?.reason,
		).toContain("already executing");
	});

	it("elects one stable pending owner per target before sharing remaining budget with fresh work", () => {
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
			planCleanupSelection({
				mode: "direct",
				limit: 3,
				fresh: inputFresh,
				pendingRetries,
				inFlightRetries: [],
				retryStateLoaded: true,
			});

		const firstRun = buildPlan(pending);
		const restartedRun = buildPlan([...pending].reverse());

		for (const plan of [firstRun, restartedRun]) {
			expect(plan.selectedRetries.map((candidate) => candidate.id)).toEqual(["retry-a", "retry-b"]);
			expect(plan.selectedFresh.map((candidate) => candidate.value)).toEqual(["fresh-first"]);
			expect(plan.counts).toMatchObject({
				selectedRetries: 2,
				selectedFresh: 1,
				deferredDuplicateTarget: 3,
				deferredBudget: 1,
				total: 7,
			});
			expect(
				plan.decisions
					.filter((decision) => decision.disposition === "selected")
					.map((decision) => decision.candidate.key),
			).toEqual(["same-retry", "other-retry", "fresh"]);
		}
	});

	it("uses retry id as the final tie-breaker for equal timestamps", () => {
		const timestamp = new Date("2026-07-01T00:00:00.000Z");
		const plan = planCleanupSelection({
			mode: "direct",
			limit: 1,
			fresh: [],
			pendingRetries: [
				{ ...retry("retry-z", timestamp), createdAt: timestamp },
				{ ...retry("retry-a", timestamp), createdAt: timestamp },
			],
			inFlightRetries: [],
			retryStateLoaded: true,
		});

		expect(plan.selectedRetries.map((candidate) => candidate.id)).toEqual(["retry-a"]);
		expect(plan.decisions.map((decision) => decision.candidate.key)).toEqual([
			"retry-a",
			"retry-z",
		]);
	});

	it("fails closed for every fresh candidate when retry state cannot be loaded", () => {
		const plan = planCleanupSelection({
			mode: "direct",
			limit: 100,
			fresh: fresh("first", "second"),
			pendingRetries: [],
			inFlightRetries: [],
			retryStateLoaded: false,
		});

		expect(plan.selectedFresh).toEqual([]);
		expect(plan.selectedRetries).toEqual([]);
		expect(plan.counts.retryStateUnavailable).toBe(2);
		expect(plan.counts.retryState).toBe("unavailable");
	});

	it.each([
		{ limit: 0, selected: [] },
		{ limit: -1, selected: [] },
		{ limit: 1, selected: ["first"] },
		{ limit: 2, selected: ["first", "second"] },
		{ limit: 101, selected: [] },
	])("applies maxRemovalsPerRun boundary $limit", ({ limit, selected }) => {
		const plan = planCleanupSelection({
			mode: "direct",
			limit,
			fresh: fresh("first", "second", "third"),
			pendingRetries: [],
			inFlightRetries: [],
			retryStateLoaded: true,
		});

		expect(plan.selectedFresh.map((candidate) => candidate.key)).toEqual(selected);
	});
});
