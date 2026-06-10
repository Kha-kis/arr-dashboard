/**
 * Grammar structural tests + the vocabulary/schema-map drift invariant
 * (unified-rule-grammar §2.1, §6.2 — the survey's kind count went stale
 * once already; this pins the enum and the param-schema map together).
 */

import { describe, expect, it } from "vitest";
import {
	CONTEXT_KINDS,
	isKindLegalForContext,
	listKindsMissingParamSchemas,
	nodeDepth,
	type RuleDocument,
	ruleDocumentSchema,
	validateV1Depth,
	walkPredicates,
} from "../index.js";

const predicate = { kind: "age", params: { operator: "older_than", days: 30 } };

describe("ruleDocumentSchema", () => {
	it("accepts a bare predicate root", () => {
		const doc = { version: 1, root: predicate };
		expect(ruleDocumentSchema.parse(doc)).toEqual(doc);
	});

	it("accepts all/any groups", () => {
		expect(() =>
			ruleDocumentSchema.parse({ version: 1, root: { all: [predicate] } }),
		).not.toThrow();
		expect(() =>
			ruleDocumentSchema.parse({ version: 1, root: { any: [predicate] } }),
		).not.toThrow();
	});

	it("permits recursion structurally (depth is a separate write-time check)", () => {
		const nested = { version: 1, root: { all: [{ any: [predicate] }] } };
		expect(() => ruleDocumentSchema.parse(nested)).not.toThrow();
	});

	it("rejects non-v1 versions", () => {
		expect(() => ruleDocumentSchema.parse({ version: 2, root: predicate })).toThrow();
	});
});

describe("depth validation", () => {
	it("predicate root is depth 0; one group level is depth 1 — both legal in v1", () => {
		expect(nodeDepth(predicate)).toBe(0);
		expect(nodeDepth({ all: [predicate] })).toBe(1);
		expect(validateV1Depth({ version: 1, root: { all: [predicate] } })).toBeNull();
	});

	it("nested groups exceed the v1 limit", () => {
		const doc: RuleDocument = { version: 1, root: { all: [{ any: [predicate] }] } };
		expect(validateV1Depth(doc)).toMatch(/depth limit/);
	});

	it("an empty group is depth 1 (legal) — the disabled-orphan shape", () => {
		expect(validateV1Depth({ version: 1, root: { all: [] } })).toBeNull();
	});
});

describe("walkPredicates", () => {
	it("yields every predicate depth-first", () => {
		const root = { all: [predicate, { any: [{ kind: "size", params: {} }] }] };
		expect([...walkPredicates(root)].map((p) => p.kind)).toEqual(["age", "size"]);
	});
});

describe("context registry", () => {
	it("cleanup and auto-tag share the criteria vocabulary; composite is not a kind", () => {
		expect(CONTEXT_KINDS["library-cleanup"]).toBe(CONTEXT_KINDS["auto-tag"]);
		expect(CONTEXT_KINDS["library-cleanup"].has("composite")).toBe(false);
		expect(CONTEXT_KINDS["library-cleanup"].has("age")).toBe(true);
	});

	it("notifications registers only field_match", () => {
		expect([...CONTEXT_KINDS.notifications]).toEqual(["field_match"]);
	});

	it("retired kinds are not legal at write time (tautulli_*, removed in 3.0)", () => {
		expect(isKindLegalForContext("library-cleanup", "tautulli_last_watched")).toBe(false);
		expect(isKindLegalForContext("notifications", "age")).toBe(false);
	});

	it("every criteria kind has a param schema (vocabulary/schema-map drift guard)", () => {
		expect(listKindsMissingParamSchemas()).toEqual([]);
	});
});
