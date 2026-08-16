import { describe, expect, it } from "vitest";
import {
	RULE_DOCUMENT_V1_MAX_DEPTH,
	RULE_DOCUMENT_V1_MAX_NODES,
	type RuleDocument,
	type RuleNode,
} from "@arr/shared";
import {
	appendRuleChild,
	removeRuleNode,
	stripCleanupRuleAnnotations,
	updateRuleNode,
	validateCleanupRuleDocument,
} from "../recursive-rule-editor";

const age = (days = 30): RuleNode => ({
	kind: "age",
	params: { operator: "older_than", days },
});

const document = (root: RuleNode): RuleDocument => ({ version: 1, root });

describe("recursive cleanup rule editor", () => {
	it("updates a nested ALL/ANY/NOT child without mutating the original tree", () => {
		const root: RuleNode = {
			all: [age(30), { any: [{ not: age(60) }, age(90)] }],
		};

		const updated = updateRuleNode(root, [1, 0, 0], () => age(120));

		expect(updated).toEqual({
			all: [age(30), { any: [{ not: age(120) }, age(90)] }],
		});
		expect(root).toEqual({
			all: [age(30), { any: [{ not: age(60) }, age(90)] }],
		});
		expect(updated).not.toBe(root);
		expect((updated as { all: RuleNode[] }).all[0]).toBe((root as { all: RuleNode[] }).all[0]);
	});

	it("appends to groups in order and rejects appending to NOT or a predicate", () => {
		const root: RuleNode = { all: [age(30)] };

		expect(appendRuleChild(root, [], age(60))).toEqual({ all: [age(30), age(60)] });
		expect(root).toEqual({ all: [age(30)] });
		expect(() => appendRuleChild({ not: age() }, [], age())).toThrow(/NOT/i);
		expect(() => appendRuleChild(age(), [], age())).toThrow(/group/i);
	});

	it("removes nested group children immutably and returns null only when removing the root", () => {
		const root: RuleNode = { any: [age(30), { not: age(60) }, age(90)] };

		expect(removeRuleNode(root, [1])).toEqual({ any: [age(30), age(90)] });
		expect(removeRuleNode(root, [])).toBeNull();
		expect(() => removeRuleNode(root, [1, 0])).toThrow(/NOT/i);
		expect(root).toEqual({ any: [age(30), { not: age(60) }, age(90)] });
		expect(() => removeRuleNode(root, [9])).toThrow(/path/i);
	});

	it("rejects paths that do not address a child or use non-index segments", () => {
		expect(() => updateRuleNode(age(), [0], () => age())).toThrow(/path/i);
		expect(() => updateRuleNode(age(), [-1], () => age())).toThrow(/index/i);
		expect(() => updateRuleNode(age(), [1.5], () => age())).toThrow(/index/i);
	});

	it("deep-clones documents while removing unavailable-kind annotations", () => {
		const input = document({
			all: [
				{ kind: "age", params: { operator: "older_than", days: 1 }, unavailableKind: true },
				{
					not: {
						kind: "size",
						params: { operator: "greater_than", sizeGb: 1 },
						unavailableKind: false,
					},
				},
			],
		});

		const stripped = stripCleanupRuleAnnotations(input);

		expect(stripped).toEqual(
			document({
				all: [age(1), { not: { kind: "size", params: { operator: "greater_than", sizeGb: 1 } } }],
			}),
		);
		expect(stripped).not.toBe(input);
		expect(stripped.root).not.toBe(input.root);
		expect(input.root).toEqual({
			all: [
				{ kind: "age", params: { operator: "older_than", days: 1 }, unavailableKind: true },
				{
					not: {
						kind: "size",
						params: { operator: "greater_than", sizeGb: 1 },
						unavailableKind: false,
					},
				},
			],
		});
	});

	it.each(["all", "any"] as const)("rejects an empty %s group", (key) => {
		const root: RuleNode = key === "all" ? { all: [] } : { any: [] };
		expect(validateCleanupRuleDocument(document(root))).toMatch(/at least one/i);
	});

	it("rejects unavailable and retired predicates before parameter validation", () => {
		expect(
			validateCleanupRuleDocument(
				document({
					kind: "age",
					params: { operator: "older_than", days: 1 },
					unavailableKind: true,
				}),
			),
		).toMatch(/unavailable/i);
		expect(
			validateCleanupRuleDocument(document({ kind: "tautulli_last_watched", params: {} })),
		).toMatch(/not available/i);
	});

	it("rejects invalid predicate parameters without throwing", () => {
		expect(() =>
			validateCleanupRuleDocument(document({ kind: "age", params: { days: 0 } })),
		).not.toThrow();
		expect(validateCleanupRuleDocument(document({ kind: "age", params: { days: 0 } }))).toMatch(
			/age/i,
		);
	});

	it("uses the shared depth and node bounds", () => {
		let deep: RuleNode = age();
		for (let index = 0; index <= RULE_DOCUMENT_V1_MAX_DEPTH; index += 1) deep = { not: deep };
		expect(validateCleanupRuleDocument(document(deep))).toMatch(/depth limit/i);

		const tooMany: RuleNode = {
			all: Array.from({ length: RULE_DOCUMENT_V1_MAX_NODES }, () => age()),
		};
		expect(validateCleanupRuleDocument(document(tooMany))).toMatch(/node limit/i);
	});

	it("rejects list membership beneath any NOT ancestor, including double NOT", () => {
		const listMember: RuleNode = {
			kind: "tmdb_list_member",
			params: { listId: "8068", operator: "is_in" },
		};

		expect(validateCleanupRuleDocument(document({ not: listMember }))).toMatch(
			/list membership.*NOT/i,
		);
		expect(
			validateCleanupRuleDocument(document({ all: [{ not: { any: [{ not: listMember }] } }] })),
		).toMatch(/list membership.*NOT/i);
		expect(validateCleanupRuleDocument(document(listMember))).toBeNull();
	});
});
