import { describe, expect, it } from "vitest";
import {
	createCleanupRuleSchema,
	getCleanupRuleScopeValidationError,
	updateCleanupRuleSchema,
} from "../library-cleanup.js";

const validEpisodeRule = {
	name: "Watched episodes",
	ruleType: "plex_watch_count" as const,
	parameters: { operator: "greater_than", count: 0 },
	serviceFilter: ["SONARR"],
	targetScope: "episode" as const,
};

const recursiveExpression = {
	version: 1 as const,
	root: {
		not: {
			all: [{ kind: "age", params: { operator: "older_than", days: 30 } }],
		},
	},
};

describe("library cleanup target scope", () => {
	it("defaults legacy rules to series scope", () => {
		const parsed = createCleanupRuleSchema.parse({
			name: "Legacy rule",
			ruleType: "age",
			parameters: { days: 30 },
		});

		expect(parsed.targetScope).toBe("series");
	});

	it("does not inject a scope into partial updates", () => {
		expect(updateCleanupRuleSchema.parse({}).targetScope).toBeUndefined();
	});

	it("accepts the positive-witness Sonarr episode rule shape", () => {
		expect(createCleanupRuleSchema.parse(validEpisodeRule).targetScope).toBe("episode");
	});

	it("accepts a recursive expression only for a composite cleanup rule", () => {
		const parsed = createCleanupRuleSchema.parse({
			name: "Keep recent items",
			ruleType: "composite",
			parameters: {},
			expression: recursiveExpression,
		});

		expect(parsed.expression).toEqual(recursiveExpression);
	});

	it("accepts an explicit null expression on create", () => {
		const parsed = createCleanupRuleSchema.parse({
			name: "Legacy rule",
			ruleType: "age",
			parameters: { days: 30 },
			expression: null,
		});

		expect(parsed.expression).toBeNull();
	});

	it.each([
		[
			{ ruleType: "age", parameters: {}, expression: recursiveExpression },
			"must use ruleType composite",
		],
		[
			{
				ruleType: "composite",
				parameters: {},
				expression: recursiveExpression,
				operator: "AND",
			},
			"cannot mix expression with operator",
		],
		[
			{
				ruleType: "composite",
				parameters: {},
				expression: recursiveExpression,
				conditions: [{ ruleType: "age", parameters: {} }],
			},
			"cannot mix expression with conditions",
		],
	])("rejects an ambiguous recursive expression payload %#", (rule, message) => {
		const result = createCleanupRuleSchema.safeParse({ name: "Ambiguous", ...rule });

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues.some((issue) => issue.message.includes(message))).toBe(true);
		}
	});

	it("accepts an expression update without repeating the composite discriminator", () => {
		expect(updateCleanupRuleSchema.parse({ expression: recursiveExpression }).expression).toEqual(
			recursiveExpression,
		);
	});

	it("accepts an explicit null expression update", () => {
		expect(updateCleanupRuleSchema.parse({ expression: null }).expression).toBeNull();
	});

	it("rejects an expression update with an explicitly non-composite discriminator", () => {
		expect(
			updateCleanupRuleSchema.safeParse({
				ruleType: "age",
				expression: recursiveExpression,
			}).success,
		).toBe(false);
	});

	it("rejects a recursive expression explicitly paired with episode scope", () => {
		expect(
			updateCleanupRuleSchema.safeParse({
				targetScope: "episode",
				expression: recursiveExpression,
			}).success,
		).toBe(false);
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
		[
			{
				...validEpisodeRule,
				ruleType: "composite",
				parameters: {},
				expression: recursiveExpression,
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

describe("library cleanup media-server rescans", () => {
	it("defaults new rules to no media-server rescan targets", () => {
		const parsed = createCleanupRuleSchema.parse({
			name: "Delete old media",
			ruleType: "age",
			parameters: { days: 30 },
		});

		expect(parsed.scanMediaServerAfterDelete).toBe(false);
		expect(parsed.scanMediaServerInstanceIds).toEqual([]);
	});

	it.each(["delete", "delete_files"] as const)(
		"accepts exact media-server targets for %s rules",
		(action) => {
			const parsed = createCleanupRuleSchema.parse({
				name: "Delete old media",
				ruleType: "age",
				parameters: { days: 30 },
				action,
				scanMediaServerAfterDelete: true,
				scanMediaServerInstanceIds: ["plex-primary", "jellyfin-primary"],
			});

			expect(parsed.scanMediaServerAfterDelete).toBe(true);
			expect(parsed.scanMediaServerInstanceIds).toEqual(["plex-primary", "jellyfin-primary"]);
		},
	);

	it.each([
		[
			{ action: "delete", scanMediaServerAfterDelete: true, scanMediaServerInstanceIds: [] },
			"at least one media-server instance",
		],
		[
			{
				action: "unmonitor",
				scanMediaServerAfterDelete: true,
				scanMediaServerInstanceIds: ["plex-primary"],
			},
			"delete or delete-files",
		],
		[
			{
				action: "delete",
				retentionMode: true,
				scanMediaServerAfterDelete: true,
				scanMediaServerInstanceIds: ["plex-primary"],
			},
			"retention",
		],
		[
			{
				action: "delete",
				scanMediaServerAfterDelete: false,
				scanMediaServerInstanceIds: ["plex-primary"],
			},
			"must be empty",
		],
	] as const)("rejects an invalid media-server rescan policy %#", (fields, message) => {
		const result = createCleanupRuleSchema.safeParse({
			name: "Delete old media",
			ruleType: "age",
			parameters: { days: 30 },
			...fields,
		});

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues.some((issue) => issue.message.includes(message))).toBe(true);
		}
	});

	it("does not inject media-server rescan fields into partial updates", () => {
		const parsed = updateCleanupRuleSchema.parse({ name: "Renamed" });

		expect(parsed.scanMediaServerAfterDelete).toBeUndefined();
		expect(parsed.scanMediaServerInstanceIds).toBeUndefined();
	});
});
