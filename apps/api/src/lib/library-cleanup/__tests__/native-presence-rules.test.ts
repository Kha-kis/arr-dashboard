import { getCleanupRuleScopeValidationError } from "@arr/shared";
import { describe, expect, it } from "vitest";
import { createNativePresenceEvidence } from "../../provider-observation/native-presence-evidence.js";
import { evaluateRuleState, evaluateSingleConditionState } from "../rule-evaluators.js";
import type { CacheItemForEval, EvalContext } from "../types.js";

const item: CacheItemForEval = {
	id: "cache",
	instanceId: "radarr",
	arrItemId: 10,
	itemType: "movie",
	title: "Fixture",
	year: 2020,
	monitored: true,
	hasFile: true,
	status: "released",
	qualityProfileId: 1,
	qualityProfileName: "HD",
	sizeOnDisk: 1n,
	arrAddedAt: new Date(),
	data: JSON.stringify({ remoteIds: { tmdbId: 42 } }),
};
const ctx: EvalContext = {
	now: new Date(),
	nativePresence: new Map([
		[
			"plex",
			createNativePresenceEvidence("owner", "plex", "generation", [
				{
					nativeId: "movie",
					mediaType: "movie",
					libraryIds: ["movies"],
					parentNativeId: null,
					seasonNumber: null,
					episodeNumber: null,
					title: "Fixture",
					externalIds: { tmdb: [42] },
				},
			]),
		],
	]),
};

describe("native presence is available for tagging and excluded from cleanup", () => {
	it("evaluates positive presence with no watch data", () => {
		expect(
			evaluateSingleConditionState(item, "media_server_presence", { instanceId: "plex" }, ctx, null)
				.state,
		).toBe("true");
	});
	it("leaves missing or changed identities unknown", () => {
		expect(
			evaluateSingleConditionState(
				item,
				"media_server_presence",
				{ instanceId: "other" },
				ctx,
				null,
			).state,
		).toBe("unknown");
		expect(
			evaluateSingleConditionState(
				{ ...item, data: JSON.stringify({ remoteIds: { tmdbId: 99 } }) },
				"media_server_presence",
				{ instanceId: "plex" },
				ctx,
				null,
			).state,
		).toBe("unknown");
	});
	it("rejects presence in cleanup write validation", () => {
		expect(getCleanupRuleScopeValidationError({ ruleType: "media_server_presence" })).toContain(
			"auto-tag",
		);
		expect(
			getCleanupRuleScopeValidationError({
				ruleType: "composite",
				conditions: [{ ruleType: "media_server_presence", parameters: { instanceId: "plex" } }],
			}),
		).toContain("auto-tag");
	});
	it("rejects presence under a negation in cleanup write validation", () => {
		expect(
			getCleanupRuleScopeValidationError({
				ruleType: "composite",
				expression: {
					version: 1,
					root: {
						type: "not",
						child: {
							type: "condition",
							ruleType: "media_server_presence",
							parameters: { instanceId: "plex" },
						},
					},
				},
			}),
		).toContain("auto-tag");
	});
	it("does not execute a persisted cleanup rule even if tagging evidence is present", () => {
		const rule = {
			id: "cleanup",
			name: "Unsafe imported rule",
			enabled: true,
			ruleType: "media_server_presence",
			parameters: JSON.stringify({ instanceId: "plex" }),
			operator: null,
			conditions: null,
			serviceFilter: null,
			instanceFilter: null,
			excludeTags: null,
			excludeTitles: null,
			plexLibraryFilter: null,
			action: "delete",
		};
		expect(evaluateRuleState(item, rule as never, "RADARR", ctx)).toMatchObject({
			state: "unknown",
			match: null,
		});
	});
});
