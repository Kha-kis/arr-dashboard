/**
 * Grammar structural tests + the vocabulary/schema-map drift invariant
 * (unified-rule-grammar §2.1, §6.2 — the survey's kind count went stale
 * once already; this pins the enum and the param-schema map together).
 */

import { describe, expect, it } from "vitest";
import {
	CONTEXT_KINDS,
	groupChildren,
	isKindLegalForContext,
	isRuleGroup,
	listKindsMissingParamSchemas,
	nodeCount,
	nodeDepth,
	RULE_DOCUMENT_V1_MAX_DEPTH,
	RULE_DOCUMENT_V1_MAX_NODES,
	type RuleDocument,
	type RuleNot,
	ruleDocumentSchema,
	validateV1Bounds,
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

	it("accepts recursive NOT nodes alongside all/any groups", () => {
		const doc = {
			version: 1,
			root: { all: [predicate, { not: { any: [predicate] } }] },
		};
		expect(ruleDocumentSchema.parse(doc)).toEqual(doc);
	});

	it("accepts nested groups within the document bounds", () => {
		const nested = { version: 1, root: { all: [{ any: [predicate] }] } };
		expect(() => ruleDocumentSchema.parse(nested)).not.toThrow();
	});

	it("rejects non-v1 versions", () => {
		expect(() => ruleDocumentSchema.parse({ version: 2, root: predicate })).toThrow();
	});

	it.each([
		{ version: 1, root: predicate, unexpected: true },
		{ version: 1, root: { ...predicate, unexpected: true } },
		{ version: 1, root: { all: [predicate], unexpected: true } },
		{ version: 1, root: { any: [predicate], unexpected: true } },
		{ version: 1, root: { not: predicate, unexpected: true } },
		{ version: 1, root: { all: [predicate], any: [predicate] } },
	])("rejects an envelope or node with an ambiguous/unknown field %#", (doc) => {
		expect(ruleDocumentSchema.safeParse(doc).success).toBe(false);
	});

	it("rejects a far-over-depth tree without overflowing the parser stack", () => {
		let root: unknown = predicate;
		for (let depth = 0; depth < 10_000; depth += 1) root = { not: root };

		let result: ReturnType<typeof ruleDocumentSchema.safeParse> | undefined;
		expect(() => {
			result = ruleDocumentSchema.safeParse({ version: 1, root });
		}).not.toThrow();
		expect(result?.success).toBe(false);
	});

	it("rejects a cyclic node graph without overflowing the parser stack", () => {
		const cyclicNode: { not?: unknown } = {};
		cyclicNode.not = cyclicNode;

		let result: ReturnType<typeof ruleDocumentSchema.safeParse> | undefined;
		expect(() => {
			result = ruleDocumentSchema.safeParse({ version: 1, root: cyclicNode });
		}).not.toThrow();
		expect(result?.success).toBe(false);
	});
});

describe("depth validation", () => {
	it("predicate root is depth 0; one group level is depth 1 — both legal in v1", () => {
		expect(nodeDepth(predicate)).toBe(0);
		expect(nodeDepth({ all: [predicate] })).toBe(1);
		expect(validateV1Depth({ version: 1, root: { all: [predicate] } })).toBeNull();
	});

	it("nested groups are legal within the recursive v1 limit", () => {
		const doc: RuleDocument = { version: 1, root: { all: [{ any: [predicate] }] } };
		expect(validateV1Depth(doc)).toBeNull();
	});

	it("an empty group is depth 1 (legal) — the disabled-orphan shape", () => {
		expect(validateV1Depth({ version: 1, root: { all: [] } })).toBeNull();
	});

	it("permits the maximum recursive depth and rejects one more level", () => {
		let atLimit: RuleDocument["root"] = predicate;
		for (let depth = 0; depth < RULE_DOCUMENT_V1_MAX_DEPTH; depth += 1) {
			atLimit = { not: atLimit };
		}
		const overLimit = { not: atLimit };

		expect(nodeDepth(atLimit)).toBe(RULE_DOCUMENT_V1_MAX_DEPTH);
		expect(validateV1Bounds({ version: 1, root: atLimit })).toBeNull();
		expect(ruleDocumentSchema.safeParse({ version: 1, root: atLimit }).success).toBe(true);
		expect(validateV1Bounds({ version: 1, root: overLimit })).toMatch(/depth limit/);
		expect(ruleDocumentSchema.safeParse({ version: 1, root: overLimit }).success).toBe(false);
	});

	it("permits the maximum node count and rejects one more node", () => {
		const atLimit = {
			version: 1 as const,
			root: {
				all: Array.from({ length: RULE_DOCUMENT_V1_MAX_NODES - 1 }, () => predicate),
			},
		};
		const overLimit = {
			version: 1 as const,
			root: {
				all: Array.from({ length: RULE_DOCUMENT_V1_MAX_NODES }, () => predicate),
			},
		};

		expect(nodeCount(atLimit.root)).toBe(RULE_DOCUMENT_V1_MAX_NODES);
		expect(validateV1Bounds(atLimit)).toBeNull();
		expect(ruleDocumentSchema.safeParse(atLimit).success).toBe(true);
		expect(validateV1Bounds(overLimit)).toMatch(/node limit/);
		expect(ruleDocumentSchema.safeParse(overLimit).success).toBe(false);
	});
});

describe("walkPredicates", () => {
	it("yields every predicate depth-first", () => {
		const root = { all: [predicate, { not: { any: [{ kind: "size", params: {} }] } }] };
		expect([...walkPredicates(root)].map((p) => p.kind)).toEqual(["age", "size"]);
	});
});

describe("composition helpers", () => {
	it("keeps NOT distinct from all/any groups without breaking generic traversal", () => {
		const notNode: RuleNot = { not: predicate };

		expect(isRuleGroup(notNode)).toBe(false);
		expect(groupChildren(notNode)).toEqual([predicate]);
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
