import { cleanupRuleTypeSchema } from "@arr/shared";
import type { CleanupRuleType } from "@arr/shared";
import { getDefaultConditionParams } from "../../components/condition-params-fields";

// All rule types defined in the Zod schema
const ALL_RULE_TYPES = cleanupRuleTypeSchema.options;

// Rule types that use an `operator` field in their defaults
const OPERATOR_RULE_TYPES: CleanupRuleType[] = [
	"age",
	"size",
	"rating",
	"genre",
	"year_range",
	"language",
	"seerr_request_age",
	"video_codec",
	"audio_codec",
	"resolution",
	"hdr_type",
	"custom_format_score",
	"runtime",
	"release_group",
	"seerr_request_modified_age",
	"tautulli_last_watched",
	"tautulli_watch_count",
	"tautulli_watched_by",
	"plex_last_watched",
	"plex_watch_count",
	"plex_user_rating",
	"plex_watched_by",
	"imdb_rating",
	"file_path",
	"seerr_request_count",
	"audio_channels",
	"tag_match",
	"plex_collection",
	"plex_label",
	"plex_added_at",
	"plex_episode_completion",
	"user_retention",
	"staleness_score",
];

// Rule types that intentionally return empty objects
const EMPTY_PARAMS_TYPES: CleanupRuleType[] = [
	"unmonitored",
	"no_file",
	"composite",
	"seerr_requester_watched",
	"seerr_requester_not_watched",
];

describe("getDefaultConditionParams", () => {
	it("returns a non-null object for every rule type in the schema", () => {
		for (const ruleType of ALL_RULE_TYPES) {
			const result = getDefaultConditionParams(ruleType);
			expect(result).toBeDefined();
			expect(typeof result).toBe("object");
		}
	});

	it("returns expected operator for rule types that use one", () => {
		for (const ruleType of OPERATOR_RULE_TYPES) {
			const result = getDefaultConditionParams(ruleType);
			expect(result).toHaveProperty("operator");
			expect(typeof result.operator).toBe("string");
		}
	});

	it("returns empty objects for parameterless rule types", () => {
		for (const ruleType of EMPTY_PARAMS_TYPES) {
			const result = getDefaultConditionParams(ruleType);
			expect(result).toEqual({});
		}
	});

	// Spot-check specific defaults to catch regressions in key values
	describe("specific defaults", () => {
		it.each([
			["age", { operator: "older_than", days: 30 }],
			["size", { operator: "greater_than", sizeGb: 50 }],
			["rating", { source: "tmdb", operator: "less_than", score: 5 }],
			["status", { statuses: [] }],
			["genre", { operator: "includes_any", genres: [] }],
			["year_range", { operator: "before", year: 2020 }],
			["quality_profile", { profileNames: [] }],
			["language", { operator: "includes_any", languages: [] }],
			["seerr_requested_by", { userNames: [] }],
			["seerr_request_age", { operator: "older_than", days: 90 }],
			["seerr_request_status", { statuses: [] }],
			["video_codec", { operator: "is", codecs: [] }],
			["audio_codec", { operator: "is", codecs: [] }],
			["resolution", { operator: "is", resolutions: [] }],
			["hdr_type", { operator: "is", types: [] }],
			["custom_format_score", { operator: "less_than", score: 0 }],
			["runtime", { operator: "greater_than", minutes: 60 }],
			["release_group", { operator: "is", groups: [] }],
			["seerr_is_4k", { is4k: true }],
			["seerr_request_modified_age", { operator: "older_than", days: 90 }],
			["seerr_modified_by", { userNames: [] }],
			["tautulli_last_watched", { operator: "older_than", days: 90 }],
			["tautulli_watch_count", { operator: "less_than", count: 1 }],
			["tautulli_watched_by", { operator: "includes_any", userNames: [] }],
			["plex_last_watched", { operator: "older_than", days: 90 }],
			["plex_watch_count", { operator: "less_than", count: 1 }],
			["plex_on_deck", { isDeck: false }],
			["plex_user_rating", { operator: "less_than", rating: 5 }],
			["plex_watched_by", { operator: "includes_any", userNames: [] }],
			["imdb_rating", { operator: "less_than", score: 5 }],
			["file_path", { operator: "matches", field: "path", pattern: "" }],
			["seerr_is_requested", { isRequested: true }],
			["seerr_request_count", { operator: "less_than", count: 1 }],
			["audio_channels", { operator: "less_than", channels: 6 }],
			["tag_match", { operator: "includes_any", tagIds: [] }],
			["plex_collection", { operator: "in", collections: [] }],
			["plex_label", { operator: "has_any", labels: [] }],
			["plex_added_at", { operator: "older_than", days: 90 }],
			["plex_episode_completion", { operator: "less_than", percentage: 10 }],
			["user_retention", { operator: "watched_by_none", source: "plex" }],
			["staleness_score", { operator: "greater_than", threshold: 70 }],
			["recently_active", { protectionDays: 30, requireActivity: true }],
		] as [CleanupRuleType, Record<string, unknown>][])(
			"%s → returns correct defaults",
			(ruleType, expected) => {
				expect(getDefaultConditionParams(ruleType)).toEqual(expected);
			},
		);
	});

	// Document the intentional default divergence between getDefaultConditionParams
	// (used for composite conditions) and the dialog's useState defaults (used for
	// single-rule mode). These are NOT bugs — composite defaults are conservative
	// while the dialog's defaults are opinionated starting points.
	describe("documents known divergences from dialog useState defaults", () => {
		it("age: composite defaults to 30 days, dialog to 180 days", () => {
			const params = getDefaultConditionParams("age");
			expect(params.days).toBe(30);
			// Dialog useState default is 180 — intentionally different
		});

		it("runtime: composite defaults to 60 minutes, dialog to 180 minutes", () => {
			const params = getDefaultConditionParams("runtime");
			expect(params.minutes).toBe(60);
			// Dialog useState default is 180 — intentionally different
		});

		it("year_range: composite defaults to 2020, dialog to 2000", () => {
			const params = getDefaultConditionParams("year_range");
			expect(params.year).toBe(2020);
			// Dialog useState default is 2000 — intentionally different
		});
	});
});
