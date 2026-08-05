import { describe, expect, it } from "vitest";
import {
	getRecursiveRuleUpdateError,
	serializeRule,
	validateRuleParameters,
} from "../library-cleanup.js";

function makeRule(overrides: Record<string, unknown> = {}) {
	const timestamp = new Date("2026-07-30T00:00:00.000Z");
	return {
		id: "rule-1",
		name: "Cleanup",
		enabled: true,
		priority: 0,
		ruleType: "plex_watch_count",
		parameters: JSON.stringify({ operator: "greater_than", count: 0 }),
		serviceFilter: JSON.stringify(["SONARR"]),
		instanceFilter: null,
		excludeTags: null,
		excludeTitles: null,
		plexLibraryFilter: null,
		action: "delete_files",
		scanMediaServerAfterDelete: false,
		operator: null,
		conditions: null,
		retentionMode: false,
		useGlobalRejectionMemory: true,
		rejectionMemoryDays: 0,
		createdAt: timestamp,
		updatedAt: timestamp,
		...overrides,
	};
}

describe("library cleanup rule serialization", () => {
	it("falls back to series for rows created before target scope existed", () => {
		expect(serializeRule(makeRule()).targetScope).toBe("series");
	});

	it("preserves explicit episode scope", () => {
		expect(serializeRule(makeRule({ targetScope: "episode" })).targetScope).toBe("episode");
	});

	it("fails closed to series for an unknown persisted value", () => {
		expect(serializeRule(makeRule({ targetScope: "unexpected" })).targetScope).toBe("series");
	});

	it("defaults legacy scan settings off and preserves an enabled setting", () => {
		const { scanMediaServerAfterDelete: _scanSetting, ...legacy } = makeRule();
		expect(serializeRule(legacy).scanMediaServerAfterDelete).toBe(false);
		expect(
			serializeRule(makeRule({ scanMediaServerAfterDelete: true })).scanMediaServerAfterDelete,
		).toBe(true);
	});

	it("preserves legacy flat fields without inventing an expression", () => {
		const conditions = [{ ruleType: "age", parameters: { operator: "older_than", days: 30 } }];
		const serialized = serializeRule(
			makeRule({ ruleType: "composite", operator: "AND", conditions: JSON.stringify(conditions) }),
		);
		expect(serialized.operator).toBe("AND");
		expect(serialized.conditions).toEqual(conditions);
		expect(serialized.expression).toBeNull();
	});

	it("exposes recursive storage through expression and null legacy fields", () => {
		const expression = {
			version: 1,
			root: {
				type: "not",
				child: {
					type: "condition",
					ruleType: "age",
					parameters: { operator: "older_than", days: 30 },
				},
			},
		};
		const serialized = serializeRule(
			makeRule({
				ruleType: "composite",
				operator: null,
				conditions: JSON.stringify(expression),
			}),
		);
		expect(serialized.expression).toEqual(expression);
		expect(serialized.operator).toBeNull();
		expect(serialized.conditions).toBeNull();
	});

	it.each([
		{ version: 2, root: { type: "condition", ruleType: "age", parameters: {} } },
		{ version: 1, root: { type: "condition", ruleType: "age" } },
	])("fails closed when recursive storage is malformed: %#", (stored) => {
		const serialized = serializeRule(
			makeRule({
				ruleType: "composite",
				operator: "AND",
				conditions: JSON.stringify(stored),
			}),
		);
		expect(serialized.expression).toBeNull();
		expect(serialized.operator).toBeNull();
		expect(serialized.conditions).toBeNull();
	});

	it.each([
		{ ruleType: "age", operator: null },
		{ ruleType: "composite", operator: "AND" },
	])("does not present conflicted recursive storage as executable: %#", (conflict) => {
		const serialized = serializeRule(
			makeRule({
				...conflict,
				conditions: JSON.stringify({
					version: 1,
					root: {
						type: "condition",
						ruleType: "age",
						parameters: { operator: "older_than", days: 30 },
					},
				}),
			}),
		);
		expect(serialized.expression).toBeNull();
		expect(serialized.operator).toBeNull();
		expect(serialized.conditions).toBeNull();
	});

	it("does not serialize an oversized persisted legacy composite as executable", () => {
		const serialized = serializeRule(
			makeRule({
				ruleType: "composite",
				operator: "AND",
				conditions: JSON.stringify(
					Array.from({ length: 100 }, () => ({
						ruleType: "age",
						parameters: { operator: "older_than", days: 30 },
					})),
				),
			}),
		);
		expect(serialized.expression).toBeNull();
		expect(serialized.operator).toBeNull();
		expect(serialized.conditions).toBeNull();
	});

	it("validates parameters in deeply nested condition nodes", () => {
		const error = validateRuleParameters("composite", {}, null, {
			version: 1,
			root: {
				type: "group",
				operator: "OR",
				children: [
					{
						type: "not",
						child: {
							type: "condition",
							ruleType: "age",
							parameters: { operator: "older_than", days: 0 },
						},
					},
				],
			},
		});
		expect(error).toContain("expression.root.children[0].child");
		expect(error).toContain("age");
	});

	it("rejects partial updates that conflict with recursive storage", () => {
		const expression = {
			version: 1 as const,
			root: {
				type: "condition" as const,
				ruleType: "age" as const,
				parameters: { operator: "older_than", days: 30 },
			},
		};
		expect(
			getRecursiveRuleUpdateError({ ruleType: "age" }, "age", null, null, expression, expression),
		).toBe("Recursive expressions require the composite rule type");
		expect(getRecursiveRuleUpdateError({ expression }, "age", null, null, expression, null)).toBe(
			"Recursive expressions require the composite rule type",
		);
		expect(
			getRecursiveRuleUpdateError({ operator: "AND" }, "composite", "AND", null, null, expression),
		).toContain("requires both an operator and conditions");
		expect(
			getRecursiveRuleUpdateError(
				{
					operator: "AND",
					conditions: [{ ruleType: "age", parameters: { operator: "older_than", days: 30 } }],
				},
				"composite",
				"AND",
				[{ ruleType: "age" }],
				null,
				expression,
			),
		).toBeNull();
		expect(
			getRecursiveRuleUpdateError({ ruleType: "composite" }, "composite", null, null, null, null),
		).toContain("require an expression");
	});
});
