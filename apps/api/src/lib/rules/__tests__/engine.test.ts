/**
 * Engine composition tests (unified-rule-grammar §4 step 2).
 *
 * Pins the legacy-exact reason semantics the cutover depends on:
 * `all` joins every reason with " AND " (cleanup's AND path), `any`
 * returns the FIRST matching reason only (cleanup's OR path). Also
 * pins the tier-2/tier-3 split: the engine never inspects kinds —
 * permissive null is the injected evaluator's job; annotation is
 * normalizeDocument's.
 */

import type { RuleDocument, RulePredicate } from "@arr/shared";
import { describe, expect, it } from "vitest";
import {
	evaluateDocument,
	evaluateNode,
	listUnavailableKinds,
	normalizeDocument,
	type PredicateEvaluator,
} from "../engine.js";

/** Evaluator stub: kind "match_*" matches with its suffix as reason. */
const stubEvaluator: PredicateEvaluator = (p: RulePredicate) =>
	p.kind.startsWith("match_") ? `reason:${p.kind.slice("match_".length)}` : null;

const doc = (root: RuleDocument["root"]): RuleDocument => ({ version: 1, root });

describe("evaluateNode — predicates", () => {
	it("returns the evaluator's reason on match", () => {
		expect(evaluateNode({ kind: "match_a", params: {} }, stubEvaluator)).toEqual({
			matched: true,
			reason: "reason:a",
		});
	});

	it("returns no-match when the evaluator returns null (tier-3 permissive null)", () => {
		expect(evaluateNode({ kind: "tautulli_last_watched", params: {} }, stubEvaluator)).toEqual({
			matched: false,
		});
	});
});

describe("evaluateNode — all groups (legacy AND semantics)", () => {
	it("joins every child reason with ' AND ' in order", () => {
		const result = evaluateNode(
			{
				all: [
					{ kind: "match_a", params: {} },
					{ kind: "match_b", params: {} },
				],
			},
			stubEvaluator,
		);
		expect(result).toEqual({ matched: true, reason: "reason:a AND reason:b" });
	});

	it("fails when ANY child fails", () => {
		const result = evaluateNode(
			{
				all: [
					{ kind: "match_a", params: {} },
					{ kind: "no_match", params: {} },
				],
			},
			stubEvaluator,
		);
		expect(result).toEqual({ matched: false });
	});

	it("empty all-group is vacuously true (notifications' match-all semantics)", () => {
		expect(evaluateNode({ all: [] }, stubEvaluator)).toEqual({ matched: true, reason: "" });
	});
});

describe("evaluateNode — any groups (legacy OR semantics)", () => {
	it("returns the FIRST matching reason only", () => {
		const result = evaluateNode(
			{
				any: [
					{ kind: "no_match", params: {} },
					{ kind: "match_b", params: {} },
					{ kind: "match_c", params: {} },
				],
			},
			stubEvaluator,
		);
		expect(result).toEqual({ matched: true, reason: "reason:b" });
	});

	it("fails when no child matches", () => {
		expect(evaluateNode({ any: [{ kind: "no_match", params: {} }] }, stubEvaluator)).toEqual({
			matched: false,
		});
	});

	it("empty any-group is false (standard existential on empty set)", () => {
		expect(evaluateNode({ any: [] }, stubEvaluator)).toEqual({ matched: false });
	});
});

describe("evaluateDocument — recursion ready", () => {
	it("evaluates nested groups correctly even though v1 writes are depth-1", () => {
		// The engine handles depth the grammar permits structurally; the
		// depth-1 restriction is a write-path policy, not an engine limit.
		const result = evaluateDocument(
			doc({
				all: [
					{ kind: "match_a", params: {} },
					{
						any: [
							{ kind: "no_match", params: {} },
							{ kind: "match_b", params: {} },
						],
					},
				],
			}),
			stubEvaluator,
		);
		expect(result).toEqual({ matched: true, reason: "reason:a AND reason:b" });
	});
});

describe("normalizeDocument (tier-2 annotation)", () => {
	const legal = new Set(["age", "size"]);

	it("annotates predicates whose kind is not legal for the context", () => {
		const normalized = normalizeDocument(
			doc({
				all: [
					{ kind: "age", params: {} },
					{ kind: "tautulli_last_watched", params: {} },
				],
			}),
			legal,
		);
		expect(normalized.root).toEqual({
			all: [
				{ kind: "age", params: {} },
				{ kind: "tautulli_last_watched", params: {}, unavailableKind: true },
			],
		});
	});

	it("never mutates the input document", () => {
		const input = doc({ kind: "tautulli_last_watched", params: {} });
		const before = JSON.parse(JSON.stringify(input));
		normalizeDocument(input, legal);
		expect(input).toEqual(before);
	});

	it("strips stale stored annotations — availability is computed, never trusted", () => {
		const normalized = normalizeDocument(
			doc({ kind: "age", params: {}, unavailableKind: true }),
			legal,
		);
		expect(normalized.root).toEqual({ kind: "age", params: {} });
	});
});

describe("listUnavailableKinds", () => {
	it("collects unique illegal kinds across the tree", () => {
		const kinds = listUnavailableKinds(
			doc({
				all: [
					{ kind: "age", params: {} },
					{ kind: "tautulli_watch_count", params: {} },
					{ any: [{ kind: "tautulli_watch_count", params: {} }] },
				],
			}),
			new Set(["age"]),
		);
		expect(kinds).toEqual(["tautulli_watch_count"]);
	});
});
