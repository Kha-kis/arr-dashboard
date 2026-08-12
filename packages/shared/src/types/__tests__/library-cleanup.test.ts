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
