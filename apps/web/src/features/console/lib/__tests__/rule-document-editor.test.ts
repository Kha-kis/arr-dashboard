/**
 * Unit tests for the composer's pure authoring layer — the editor-state ↔
 * RuleDocument transforms and the strict write-time validation choke point.
 *
 * These exercise the populated-data paths a live-verify on an empty dev DB is
 * blind to (feedback_review_catches_data_dependent_bugs): a composite with two
 * real conditions, populated array params, an illegal kind, a retired-kind
 * prefill, and the v0 down-convert parity the live evaluator depends on.
 */

import type { RuleDocument } from "@arr/shared";
import { describe, expect, it } from "vitest";
import {
	buildCriteriaDocument,
	type CriteriaEditorState,
	decomposeCriteriaDocument,
	toCriteriaV0Payload,
	validateCriteriaEditor,
} from "../rule-document-editor";

function singleState(kind: string, params: Record<string, unknown>): CriteriaEditorState {
	return { mode: "single", operator: "all", conditions: [{ id: "c0", kind, params }] };
}

describe("buildCriteriaDocument", () => {
	it("single mode → a bare predicate root", () => {
		const doc = buildCriteriaDocument(singleState("age", { operator: "older_than", days: 30 }));
		expect(doc).toEqual({
			version: 1,
			root: { kind: "age", params: { operator: "older_than", days: 30 } },
		});
	});

	it("composite mode → an all/any group of predicates", () => {
		const state: CriteriaEditorState = {
			mode: "composite",
			operator: "any",
			conditions: [
				{ id: "a", kind: "age", params: { operator: "older_than", days: 30 } },
				{ id: "b", kind: "size", params: { operator: "greater_than", sizeGb: 50 } },
			],
		};
		expect(buildCriteriaDocument(state)).toEqual({
			version: 1,
			root: {
				any: [
					{ kind: "age", params: { operator: "older_than", days: 30 } },
					{ kind: "size", params: { operator: "greater_than", sizeGb: 50 } },
				],
			},
		});
	});
});

describe("decomposeCriteriaDocument", () => {
	it("predicate root → single mode with one condition", () => {
		const doc: RuleDocument = {
			version: 1,
			root: { kind: "plex_watched_by", params: { operator: "includes_any", userNames: ["bob"] } },
		};
		expect(decomposeCriteriaDocument(doc)).toEqual({
			mode: "single",
			operator: "all",
			conditions: [
				{
					id: "cond-0",
					kind: "plex_watched_by",
					params: { operator: "includes_any", userNames: ["bob"] },
				},
			],
		});
	});

	it("all group → composite mode, operator all, child predicates", () => {
		const doc: RuleDocument = {
			version: 1,
			root: {
				all: [
					{ kind: "age", params: { operator: "older_than", days: 90 } },
					{ kind: "genre", params: { operator: "includes_any", genres: ["Horror"] } },
				],
			},
		};
		expect(decomposeCriteriaDocument(doc)).toEqual({
			mode: "composite",
			operator: "all",
			conditions: [
				{ id: "cond-0", kind: "age", params: { operator: "older_than", days: 90 } },
				{ id: "cond-1", kind: "genre", params: { operator: "includes_any", genres: ["Horror"] } },
			],
		});
	});

	it("preserves a retired (unavailableKind) predicate verbatim so edit doesn't drop it", () => {
		const doc: RuleDocument = {
			version: 1,
			root: {
				kind: "tautulli_last_watched",
				params: { operator: "older_than", days: 30 },
				unavailableKind: true,
			},
		};
		const state = decomposeCriteriaDocument(doc);
		expect(state.conditions[0]?.kind).toBe("tautulli_last_watched");
		// ...and validation then refuses to save it (illegal for the context).
		expect(validateCriteriaEditor(state, "library-cleanup")).toMatch(/not available/i);
	});

	it("round-trips build∘decompose for a composite (ignoring row ids)", () => {
		const doc: RuleDocument = {
			version: 1,
			root: {
				any: [
					{ kind: "size", params: { operator: "greater_than", sizeGb: 20 } },
					{ kind: "no_file", params: {} },
				],
			},
		};
		expect(buildCriteriaDocument(decomposeCriteriaDocument(doc))).toEqual(doc);
	});
});

describe("validateCriteriaEditor", () => {
	it("accepts a valid single condition", () => {
		expect(
			validateCriteriaEditor(
				singleState("age", { operator: "older_than", days: 30 }),
				"library-cleanup",
			),
		).toBeNull();
	});

	it("accepts a valid two-condition composite", () => {
		const state: CriteriaEditorState = {
			mode: "composite",
			operator: "all",
			conditions: [
				{ id: "a", kind: "age", params: { operator: "older_than", days: 90 } },
				{ id: "b", kind: "plex_watch_count", params: { operator: "less_than", count: 1 } },
			],
		};
		expect(validateCriteriaEditor(state, "library-cleanup")).toBeNull();
	});

	it("rejects an empty composite at the form (fix c — before the serializer's last-line guard)", () => {
		const state: CriteriaEditorState = { mode: "composite", operator: "all", conditions: [] };
		expect(validateCriteriaEditor(state, "library-cleanup")).toMatch(/at least one condition/i);
	});

	it("rejects a single condition with no chosen kind", () => {
		const state: CriteriaEditorState = {
			mode: "single",
			operator: "all",
			conditions: [{ id: "c", kind: "", params: {} }],
		};
		expect(validateCriteriaEditor(state, "library-cleanup")).toMatch(/choose a condition/i);
	});

	it("rejects a kind not legal for the context (field_match belongs to notifications)", () => {
		const state = singleState("field_match", {
			field: "eventType",
			operator: "equals",
			value: "X",
		});
		expect(validateCriteriaEditor(state, "library-cleanup")).toMatch(/not available/i);
	});

	it("rejects params that fail the kind's schema", () => {
		// age requires a positive integer `days`; -5 fails the schema.
		const state = singleState("age", { operator: "older_than", days: -5 });
		expect(validateCriteriaEditor(state, "library-cleanup")).toMatch(/age/i);
	});
});

describe("toCriteriaV0Payload", () => {
	it("down-converts a valid single condition to the v0 route payload", () => {
		const result = toCriteriaV0Payload(
			singleState("age", { operator: "older_than", days: 30 }),
			"library-cleanup",
		);
		expect(result.error).toBeUndefined();
		expect(result.payload).toEqual({
			ruleType: "age",
			parameters: { operator: "older_than", days: 30 },
			operator: null,
			conditions: null,
		});
	});

	it("down-converts a composite to the v0 composite payload (AND/OR mapped)", () => {
		const state: CriteriaEditorState = {
			mode: "composite",
			operator: "any",
			conditions: [
				{ id: "a", kind: "age", params: { operator: "older_than", days: 90 } },
				{ id: "b", kind: "size", params: { operator: "greater_than", sizeGb: 50 } },
			],
		};
		const result = toCriteriaV0Payload(state, "library-cleanup");
		expect(result.payload).toEqual({
			ruleType: "composite",
			parameters: {},
			operator: "OR",
			conditions: [
				{ ruleType: "age", parameters: { operator: "older_than", days: 90 } },
				{ ruleType: "size", parameters: { operator: "greater_than", sizeGb: 50 } },
			],
		});
	});

	it("returns the validation error instead of a payload when invalid", () => {
		const result = toCriteriaV0Payload(
			{ mode: "composite", operator: "all", conditions: [] },
			"library-cleanup",
		);
		expect(result.payload).toBeUndefined();
		expect(result.error).toMatch(/at least one condition/i);
	});
});
