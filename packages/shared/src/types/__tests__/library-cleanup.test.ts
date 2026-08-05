import { describe, expect, it } from "vitest";
import {
	CLEANUP_RULE_EXPRESSION_MAX_DEPTH,
	CLEANUP_RULE_EXPRESSION_MAX_NODES,
	cleanupRuleExpressionSchema,
	cleanupRuleRequiresRadarrRatings,
	createCleanupRuleSchema,
	getCleanupRuleScopeValidationError,
	updateCleanupRuleSchema,
} from "../library-cleanup.js";
import { ruleParamSchemaMap, ruleTypeSchema } from "../rule-criteria.js";

const validEpisodeRule = {
	name: "Watched episodes",
	ruleType: "plex_watch_count" as const,
	parameters: { operator: "greater_than", count: 0 },
	serviceFilter: ["SONARR"],
	targetScope: "episode" as const,
};

describe("library cleanup target scope", () => {
	it("defaults legacy rules to series scope", () => {
		const parsed = createCleanupRuleSchema.parse({
			name: "Legacy rule",
			ruleType: "age",
			parameters: { days: 30 },
		});

		expect(parsed.targetScope).toBe("series");
		expect(parsed.scanMediaServerAfterDelete).toBe(false);
	});

	it("does not inject a scope into partial updates", () => {
		expect(updateCleanupRuleSchema.parse({}).targetScope).toBeUndefined();
	});

	it("accepts the positive-witness Sonarr episode rule shape", () => {
		expect(createCleanupRuleSchema.parse(validEpisodeRule).targetScope).toBe("episode");
	});

	it.each([
		[{ ...validEpisodeRule, serviceFilter: ["RADARR"] }, "Sonarr only"],
		[{ ...validEpisodeRule, serviceFilter: ["SONARR", "RADARR"] }, "Sonarr only"],
		[{ ...validEpisodeRule, retentionMode: true }, "retention mode"],
		[{ ...validEpisodeRule, plexLibraryFilter: ["TV"] }, "Plex library filter"],
		[
			{
				...validEpisodeRule,
				ruleType: "composite",
				operator: "AND",
				conditions: [{ ruleType: "plex_watch_count", parameters: validEpisodeRule.parameters }],
			},
			"cannot be composite",
		],
		[{ ...validEpisodeRule, ruleType: "age" }, "must use Plex watch count"],
		[
			{ ...validEpisodeRule, parameters: { operator: "less_than", count: 1 } },
			"must use greater than",
		],
	])("rejects unsupported episode rule %#", (rule, message) => {
		const result = createCleanupRuleSchema.safeParse(rule);

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues.some((issue) => issue.message.includes(message))).toBe(true);
		}
	});

	it("leaves series rules unrestricted by episode-only validation", () => {
		expect(
			getCleanupRuleScopeValidationError({
				targetScope: "series",
				serviceFilter: null,
				ruleType: "age",
				parameters: { days: 30 },
				retentionMode: true,
				plexLibraryFilter: ["TV"],
			}),
		).toBeNull();
	});
});

describe("monitored and IMDb rule capabilities", () => {
	it("accepts monitored as a parameterless standalone and nested rule", () => {
		expect(ruleTypeSchema.options).toContain("monitored");
		expect(ruleParamSchemaMap.monitored?.parse({})).toEqual({});
		expect(
			createCleanupRuleSchema.safeParse({
				name: "Currently monitored",
				ruleType: "monitored",
				parameters: {},
			}),
		).toMatchObject({ success: true });
		expect(
			createCleanupRuleSchema.safeParse({
				name: "Nested monitoring",
				ruleType: "composite",
				parameters: {},
				expression: {
					version: 1,
					root: {
						type: "not",
						child: { type: "condition", ruleType: "monitored", parameters: {} },
					},
				},
			}),
		).toMatchObject({ success: true });
	});

	it("detects IMDb in standalone, legacy, nested group, and NOT representations", () => {
		expect(cleanupRuleRequiresRadarrRatings({ ruleType: "imdb_rating" })).toBe(true);
		expect(
			cleanupRuleRequiresRadarrRatings({
				ruleType: "composite",
				conditions: [{ ruleType: "imdb_rating", parameters: { operator: "unrated" } }],
			}),
		).toBe(true);
		expect(
			cleanupRuleRequiresRadarrRatings({
				ruleType: "composite",
				expression: {
					version: 1,
					root: {
						type: "group",
						operator: "AND",
						children: [
							{
								type: "not",
								child: {
									type: "condition",
									ruleType: "imdb_rating",
									parameters: { operator: "unrated" },
								},
							},
						],
					},
				},
			}),
		).toBe(true);
	});

	it("rejects Sonarr or mixed service scope for nested IMDb expressions", () => {
		const expression = {
			version: 1 as const,
			root: {
				type: "not" as const,
				child: {
					type: "condition" as const,
					ruleType: "imdb_rating" as const,
					parameters: { operator: "unrated" },
				},
			},
		};
		for (const serviceFilter of [["SONARR"], ["SONARR", "RADARR"]]) {
			const result = createCleanupRuleSchema.safeParse({
				name: "Nested IMDb",
				ruleType: "composite",
				parameters: {},
				expression,
				serviceFilter,
			});
			expect(result.success).toBe(false);
		}
		expect(
			createCleanupRuleSchema.safeParse({
				name: "Nested IMDb",
				ruleType: "composite",
				parameters: {},
				expression,
				serviceFilter: ["RADARR"],
			}),
		).toMatchObject({ success: true });
	});
});

describe("library cleanup partial updates", () => {
	it("does not inject any create defaults into an empty update", () => {
		expect(updateCleanupRuleSchema.parse({})).toEqual({});
	});

	it.each([
		["sparse name", { name: "Renamed" }],
		[
			"recursive expression",
			{
				expression: {
					version: 1,
					root: {
						type: "condition",
						ruleType: "age",
						parameters: { operator: "older_than", days: 30 },
					},
				},
			},
		],
		[
			"legacy conditions",
			{
				operator: "AND",
				conditions: [
					{
						ruleType: "age",
						parameters: { operator: "older_than", days: 30 },
					},
				],
			},
		],
		["explicit null representation", { expression: null, operator: null, conditions: null }],
	])("preserves only supplied fields for %s", (_name, input) => {
		expect(updateCleanupRuleSchema.parse(input)).toEqual(input);
	});

	it("treats explicitly undefined fields as omitted", () => {
		expect(
			updateCleanupRuleSchema.parse({
				enabled: undefined,
				priority: undefined,
				targetScope: undefined,
				action: undefined,
				retentionMode: undefined,
				scanMediaServerAfterDelete: undefined,
				useGlobalRejectionMemory: undefined,
				expression: undefined,
				operator: undefined,
				conditions: undefined,
			}),
		).toEqual({});
	});

	it("preserves explicit values for every create-default field", () => {
		const input = {
			enabled: false,
			priority: 9,
			targetScope: "episode" as const,
			action: "unmonitor" as const,
			retentionMode: true,
			useGlobalRejectionMemory: false,
			scanMediaServerAfterDelete: false,
		};
		expect(updateCleanupRuleSchema.parse(input)).toEqual(input);
	});

	it("preserves explicit media-server scan updates without injecting a default", () => {
		expect(updateCleanupRuleSchema.parse({})).not.toHaveProperty("scanMediaServerAfterDelete");
		expect(updateCleanupRuleSchema.parse({ scanMediaServerAfterDelete: true })).toEqual({
			scanMediaServerAfterDelete: true,
		});
		expect(updateCleanupRuleSchema.parse({ scanMediaServerAfterDelete: false })).toEqual({
			scanMediaServerAfterDelete: false,
		});
	});

	it.each([
		{ action: "unmonitor" as const, scanMediaServerAfterDelete: true },
		{ action: "delete" as const, retentionMode: true, scanMediaServerAfterDelete: true },
	])("rejects media-server scans for non-deleting rule shapes", (overrides) => {
		const result = createCleanupRuleSchema.safeParse({
			name: "Invalid scan rule",
			ruleType: "age",
			parameters: { days: 30 },
			...overrides,
		});
		expect(result.success).toBe(false);
	});
});

describe("recursive library cleanup expressions", () => {
	const condition = {
		type: "condition" as const,
		ruleType: "age" as const,
		parameters: { operator: "older_than", days: 30 },
	};

	it("accepts nested AND/OR and explicit NOT", () => {
		const result = createCleanupRuleSchema.safeParse({
			name: "Nested",
			ruleType: "composite",
			parameters: {},
			expression: {
				version: 1,
				root: {
					type: "group",
					operator: "OR",
					children: [
						condition,
						{
							type: "group",
							operator: "AND",
							children: [condition, { type: "not", child: condition }],
						},
					],
				},
			},
		});
		expect(result.success).toBe(true);
	});

	it("rejects conflicting recursive and legacy representations", () => {
		const result = createCleanupRuleSchema.safeParse({
			name: "Ambiguous",
			ruleType: "composite",
			parameters: {},
			operator: "AND",
			conditions: [{ ruleType: "age", parameters: condition.parameters }],
			expression: { version: 1, root: condition },
		});
		expect(result.success).toBe(false);
	});

	it("rejects a composite rule without executable criteria", () => {
		const result = createCleanupRuleSchema.safeParse({
			name: "Empty composite",
			ruleType: "composite",
			parameters: {},
		});
		expect(result.success).toBe(false);
	});

	it("rejects composite fields on a single-condition rule", () => {
		const result = createCleanupRuleSchema.safeParse({
			name: "Ambiguous single",
			ruleType: "age",
			parameters: condition.parameters,
			operator: "AND",
			conditions: [{ ruleType: "age", parameters: condition.parameters }],
		});
		expect(result.success).toBe(false);
	});

	it("rejects unsupported expression versions", () => {
		const result = cleanupRuleExpressionSchema.safeParse({
			version: 2,
			root: condition,
		});
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.issues[0]?.message).toContain("version");
	});

	it("rejects unexpected expression fields", () => {
		const result = cleanupRuleExpressionSchema.safeParse({
			version: 1,
			root: { ...condition, negated: true },
		});
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.issues[0]?.message).toContain("Unexpected");
	});

	it("rejects over-deep expressions deterministically", () => {
		let root: unknown = condition;
		for (let depth = 0; depth < CLEANUP_RULE_EXPRESSION_MAX_DEPTH; depth++) {
			root = { type: "not", child: root };
		}
		const result = cleanupRuleExpressionSchema.safeParse({ version: 1, root });
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.issues[0]?.message).toContain("maximum depth");
	});

	it("rejects oversized expressions", () => {
		const result = cleanupRuleExpressionSchema.safeParse({
			version: 1,
			root: {
				type: "group",
				operator: "AND",
				children: Array.from({ length: CLEANUP_RULE_EXPRESSION_MAX_NODES }, () => ({
					...condition,
					parameters: { ...condition.parameters },
				})),
			},
		});
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.issues[0]?.message).toContain("node count");
	});

	it("accepts 99 legacy conditions at the total 100-node boundary", () => {
		const result = createCleanupRuleSchema.safeParse({
			name: "Largest legacy composite",
			ruleType: "composite",
			parameters: {},
			operator: "AND",
			conditions: Array.from({ length: CLEANUP_RULE_EXPRESSION_MAX_NODES - 1 }, () => ({
				ruleType: condition.ruleType,
				parameters: { ...condition.parameters },
			})),
		});
		expect(result.success).toBe(true);
	});

	it("rejects 100 legacy conditions because their implicit root exceeds the node limit", () => {
		const input = {
			name: "Oversized legacy composite",
			ruleType: "composite" as const,
			parameters: {},
			operator: "AND" as const,
			conditions: Array.from({ length: CLEANUP_RULE_EXPRESSION_MAX_NODES }, () => ({
				ruleType: condition.ruleType,
				parameters: { ...condition.parameters },
			})),
		};
		const createResult = createCleanupRuleSchema.safeParse(input);
		const updateResult = updateCleanupRuleSchema.safeParse(input);
		expect(createResult.success).toBe(false);
		expect(updateResult.success).toBe(false);
		if (!createResult.success) {
			expect(createResult.error.issues[0]?.message).toContain("at most 99");
		}
	});

	it("rejects cyclic programmatic expressions without overflowing", () => {
		const cyclic: Record<string, unknown> = { type: "not" };
		cyclic.child = cyclic;
		const result = cleanupRuleExpressionSchema.safeParse({ version: 1, root: cyclic });
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.issues[0]?.message).toContain("cycle");
	});
});
