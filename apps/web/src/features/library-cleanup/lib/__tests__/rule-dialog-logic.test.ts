import { describe, expect, it } from "vitest";
import type { CleanupRuleType } from "@arr/shared";
import { buildParams, splitCsv, type BuildParamsState } from "../rule-dialog-logic";

// ============================================================================
// Test helpers
// ============================================================================

/** Returns a full BuildParamsState with sensible defaults for all fields.
 *  Override specific fields per-test via the `overrides` parameter. */
function makeState(overrides: Partial<BuildParamsState> = {}): BuildParamsState {
	return {
		ruleType: "age",
		ageOp: "older_than",
		days: 180,
		sizeOp: "greater_than",
		sizeGb: 50,
		scoreOp: "less_than",
		score: 5,
		statuses: "ended,deleted",
		genreOp: "includes_any",
		genres: "Drama, Comedy",
		yearOp: "before",
		year: 2000,
		yearFrom: 1990,
		yearTo: 2010,
		profileNames: "HD-1080p, Ultra-HD",
		langOp: "includes_any",
		languages: "English, German",
		seerrUserNames: "alice, bob",
		seerrReqAgeOp: "older_than",
		seerrReqAgeDays: 90,
		seerrReqStatuses: "pending,declined",
		videoCodecOp: "is",
		selectedVideoCodecs: ["x265", "AV1"],
		audioCodecOp: "is",
		selectedAudioCodecs: ["DTS", "TrueHD"],
		resolutionOp: "is",
		selectedResolutions: ["1080p", "2160p"],
		hdrOp: "is",
		selectedHdrTypes: ["HDR10", "Dolby Vision"],
		cfScoreOp: "less_than",
		cfScore: 0,
		runtimeOp: "greater_than",
		runtimeMinutes: 180,
		releaseGroupOp: "is",
		selectedReleaseGroups: ["SPARKS", "FLUX"],
		seerrIs4k: true,
		seerrModifiedAgeOp: "older_than",
		seerrModifiedAgeDays: 90,
		seerrModifiedByUsers: "charlie",
		tautulliLastWatchedOp: "older_than",
		tautulliLastWatchedDays: 90,
		tautulliWatchCountOp: "less_than",
		tautulliWatchCount: 1,
		tautulliWatchedByOp: "includes_any",
		selectedTautulliUsers: ["user1"],
		plexLastWatchedOp: "older_than",
		plexLastWatchedDays: 90,
		plexWatchCountOp: "less_than",
		plexWatchCountVal: 1,
		plexOnDeckVal: false,
		plexUserRatingOp: "less_than",
		plexUserRatingVal: 5,
		plexWatchedByOp: "includes_any",
		selectedPlexUsers: ["plexUser1"],
		imdbRatingOp: "less_than",
		imdbRatingScore: 5,
		filePathOp: "matches",
		filePathPattern: ".*sample.*",
		filePathField: "path",
		seerrIsRequested: true,
		seerrRequestCountOp: "less_than",
		seerrRequestCountVal: 1,
		audioChannelsOp: "less_than",
		audioChannelsVal: 6,
		tagMatchOp: "includes_any",
		selectedTagIds: [1, 2],
		plexCollectionOp: "in",
		selectedPlexCollections: ["Marvel"],
		plexLabelOp: "has_any",
		selectedPlexLabels: ["keep"],
		plexAddedAtOp: "older_than",
		plexAddedAtDays: 90,
		behaviorParams: { operator: "less_than", percentage: 10 },
		...overrides,
	};
}

// ============================================================================
// splitCsv
// ============================================================================

describe("splitCsv", () => {
	it("splits comma-separated values and trims whitespace", () => {
		expect(splitCsv("Drama, Comedy, Horror")).toEqual(["Drama", "Comedy", "Horror"]);
	});

	it("returns empty array for empty string", () => {
		expect(splitCsv("")).toEqual([]);
	});

	it("returns empty array for whitespace-only string", () => {
		expect(splitCsv("   ")).toEqual([]);
	});

	it("handles trailing commas", () => {
		expect(splitCsv("Drama, Comedy,")).toEqual(["Drama", "Comedy"]);
	});

	it("handles leading commas", () => {
		expect(splitCsv(",Drama")).toEqual(["Drama"]);
	});

	it("handles multiple consecutive commas", () => {
		expect(splitCsv("Drama,,Comedy")).toEqual(["Drama", "Comedy"]);
	});

	it("handles single value with no commas", () => {
		expect(splitCsv("Drama")).toEqual(["Drama"]);
	});

	it("handles values with extra internal whitespace preserved", () => {
		expect(splitCsv("HD 1080p, Ultra HD")).toEqual(["HD 1080p", "Ultra HD"]);
	});
});

// ============================================================================
// buildParams — representative rule types
// ============================================================================

describe("buildParams", () => {
	describe("basic rules", () => {
		it("age: includes field, operator, and days", () => {
			expect(buildParams(makeState({ ruleType: "age" }))).toEqual({
				field: "arrAddedAt",
				operator: "older_than",
				days: 180,
			});
		});

		it("size: includes operator and sizeGb", () => {
			expect(buildParams(makeState({ ruleType: "size" }))).toEqual({
				operator: "greater_than",
				sizeGb: 50,
			});
		});

		it("unmonitored: returns empty object", () => {
			expect(buildParams(makeState({ ruleType: "unmonitored" }))).toEqual({});
		});

		it("no_file: returns empty object", () => {
			expect(buildParams(makeState({ ruleType: "no_file" }))).toEqual({});
		});
	});

	describe("csv-parsed fields", () => {
		it("status: splits comma-separated statuses", () => {
			expect(buildParams(makeState({ ruleType: "status" }))).toEqual({
				statuses: ["ended", "deleted"],
			});
		});

		it("genre: splits csv genres with operator", () => {
			expect(buildParams(makeState({ ruleType: "genre" }))).toEqual({
				operator: "includes_any",
				genres: ["Drama", "Comedy"],
			});
		});

		it("quality_profile: splits csv profile names", () => {
			expect(buildParams(makeState({ ruleType: "quality_profile" }))).toEqual({
				profileNames: ["HD-1080p", "Ultra-HD"],
			});
		});

		it("language: splits csv languages with operator", () => {
			expect(buildParams(makeState({ ruleType: "language" }))).toEqual({
				operator: "includes_any",
				languages: ["English", "German"],
			});
		});

		it("seerr_requested_by: splits csv usernames", () => {
			expect(buildParams(makeState({ ruleType: "seerr_requested_by" }))).toEqual({
				userNames: ["alice", "bob"],
			});
		});

		it("seerr_request_status: splits csv statuses", () => {
			expect(buildParams(makeState({ ruleType: "seerr_request_status" }))).toEqual({
				statuses: ["pending", "declined"],
			});
		});

		it("seerr_modified_by: splits csv usernames", () => {
			expect(buildParams(makeState({ ruleType: "seerr_modified_by" }))).toEqual({
				userNames: ["charlie"],
			});
		});
	});

	describe("array-based fields (passed through directly)", () => {
		it("video_codec: passes codecs array directly", () => {
			expect(buildParams(makeState({ ruleType: "video_codec" }))).toEqual({
				operator: "is",
				codecs: ["x265", "AV1"],
			});
		});

		it("audio_codec: passes codecs array directly", () => {
			expect(buildParams(makeState({ ruleType: "audio_codec" }))).toEqual({
				operator: "is",
				codecs: ["DTS", "TrueHD"],
			});
		});

		it("resolution: passes resolutions array directly", () => {
			expect(buildParams(makeState({ ruleType: "resolution" }))).toEqual({
				operator: "is",
				resolutions: ["1080p", "2160p"],
			});
		});

		it("release_group: passes groups array directly", () => {
			expect(buildParams(makeState({ ruleType: "release_group" }))).toEqual({
				operator: "is",
				groups: ["SPARKS", "FLUX"],
			});
		});

		it("tag_match: passes tagIds array directly", () => {
			expect(buildParams(makeState({ ruleType: "tag_match" }))).toEqual({
				operator: "includes_any",
				tagIds: [1, 2],
			});
		});

		it("plex_collection: passes collections array directly", () => {
			expect(buildParams(makeState({ ruleType: "plex_collection" }))).toEqual({
				operator: "in",
				collections: ["Marvel"],
			});
		});

		it("plex_label: passes labels array directly", () => {
			expect(buildParams(makeState({ ruleType: "plex_label" }))).toEqual({
				operator: "has_any",
				labels: ["keep"],
			});
		});

		it("tautulli_watched_by: passes userNames array directly", () => {
			expect(buildParams(makeState({ ruleType: "tautulli_watched_by" }))).toEqual({
				operator: "includes_any",
				userNames: ["user1"],
			});
		});

		it("plex_watched_by: passes userNames array directly", () => {
			expect(buildParams(makeState({ ruleType: "plex_watched_by" }))).toEqual({
				operator: "includes_any",
				userNames: ["plexUser1"],
			});
		});
	});

	// ── Operator branch variants ───────────────────────────────────
	// These tests verify that special operator values correctly omit
	// numeric fields that would otherwise be present.

	describe("operator branch: 'unrated' omits score/rating", () => {
		it("rating: unrated omits score, includes source", () => {
			const result = buildParams(makeState({ ruleType: "rating", scoreOp: "unrated" }));
			expect(result).toEqual({ source: "tmdb", operator: "unrated" });
			expect(result).not.toHaveProperty("score");
		});

		it("rating: non-unrated includes score", () => {
			const result = buildParams(
				makeState({ ruleType: "rating", scoreOp: "less_than", score: 7 }),
			);
			expect(result).toEqual({ source: "tmdb", operator: "less_than", score: 7 });
		});

		it("plex_user_rating: unrated omits rating", () => {
			const result = buildParams(
				makeState({ ruleType: "plex_user_rating", plexUserRatingOp: "unrated" }),
			);
			expect(result).toEqual({ operator: "unrated" });
			expect(result).not.toHaveProperty("rating");
		});

		it("plex_user_rating: non-unrated includes rating", () => {
			const result = buildParams(
				makeState({
					ruleType: "plex_user_rating",
					plexUserRatingOp: "less_than",
					plexUserRatingVal: 3,
				}),
			);
			expect(result).toEqual({ operator: "less_than", rating: 3 });
		});

		it("imdb_rating: unrated omits score", () => {
			const result = buildParams(
				makeState({ ruleType: "imdb_rating", imdbRatingOp: "unrated" }),
			);
			expect(result).toEqual({ operator: "unrated" });
			expect(result).not.toHaveProperty("score");
		});

		it("imdb_rating: non-unrated includes score", () => {
			const result = buildParams(
				makeState({ ruleType: "imdb_rating", imdbRatingOp: "greater_than", imdbRatingScore: 8 }),
			);
			expect(result).toEqual({ operator: "greater_than", score: 8 });
		});
	});

	describe("operator branch: 'never' omits days", () => {
		it("tautulli_last_watched: never omits days", () => {
			const result = buildParams(
				makeState({ ruleType: "tautulli_last_watched", tautulliLastWatchedOp: "never" }),
			);
			expect(result).toEqual({ operator: "never" });
			expect(result).not.toHaveProperty("days");
		});

		it("tautulli_last_watched: non-never includes days", () => {
			const result = buildParams(
				makeState({
					ruleType: "tautulli_last_watched",
					tautulliLastWatchedOp: "older_than",
					tautulliLastWatchedDays: 60,
				}),
			);
			expect(result).toEqual({ operator: "older_than", days: 60 });
		});

		it("plex_last_watched: never omits days", () => {
			const result = buildParams(
				makeState({ ruleType: "plex_last_watched", plexLastWatchedOp: "never" }),
			);
			expect(result).toEqual({ operator: "never" });
			expect(result).not.toHaveProperty("days");
		});

		it("plex_last_watched: non-never includes days", () => {
			const result = buildParams(
				makeState({
					ruleType: "plex_last_watched",
					plexLastWatchedOp: "older_than",
					plexLastWatchedDays: 120,
				}),
			);
			expect(result).toEqual({ operator: "older_than", days: 120 });
		});
	});

	describe("operator branch: hdr_type 'none' omits types array", () => {
		it("hdr_type: none omits types", () => {
			const result = buildParams(makeState({ ruleType: "hdr_type", hdrOp: "none" }));
			expect(result).toEqual({ operator: "none" });
			expect(result).not.toHaveProperty("types");
		});

		it("hdr_type: non-none includes types", () => {
			const result = buildParams(
				makeState({
					ruleType: "hdr_type",
					hdrOp: "is",
					selectedHdrTypes: ["HDR10"],
				}),
			);
			expect(result).toEqual({ operator: "is", types: ["HDR10"] });
		});
	});

	describe("year_range operator branches", () => {
		it("between: includes yearFrom and yearTo, not year", () => {
			const result = buildParams(
				makeState({ ruleType: "year_range", yearOp: "between", yearFrom: 1990, yearTo: 2010 }),
			);
			expect(result).toEqual({ operator: "between", yearFrom: 1990, yearTo: 2010 });
			expect(result).not.toHaveProperty("year");
		});

		it("before: includes year, not yearFrom/yearTo", () => {
			const result = buildParams(
				makeState({ ruleType: "year_range", yearOp: "before", year: 2000 }),
			);
			expect(result).toEqual({ operator: "before", year: 2000 });
			expect(result).not.toHaveProperty("yearFrom");
			expect(result).not.toHaveProperty("yearTo");
		});

		it("after: includes year, not yearFrom/yearTo", () => {
			const result = buildParams(
				makeState({ ruleType: "year_range", yearOp: "after", year: 2015 }),
			);
			expect(result).toEqual({ operator: "after", year: 2015 });
		});
	});

	describe("boolean rules", () => {
		it("seerr_is_4k: includes is4k boolean", () => {
			expect(buildParams(makeState({ ruleType: "seerr_is_4k", seerrIs4k: false }))).toEqual({
				is4k: false,
			});
		});

		it("plex_on_deck: includes isDeck boolean", () => {
			expect(buildParams(makeState({ ruleType: "plex_on_deck", plexOnDeckVal: true }))).toEqual({
				isDeck: true,
			});
		});

		it("seerr_is_requested: includes isRequested boolean", () => {
			expect(
				buildParams(makeState({ ruleType: "seerr_is_requested", seerrIsRequested: false })),
			).toEqual({ isRequested: false });
		});
	});

	describe("remaining single-value rules", () => {
		it("custom_format_score", () => {
			expect(
				buildParams(
					makeState({ ruleType: "custom_format_score", cfScoreOp: "greater_than", cfScore: 10 }),
				),
			).toEqual({ operator: "greater_than", score: 10 });
		});

		it("runtime", () => {
			expect(
				buildParams(
					makeState({ ruleType: "runtime", runtimeOp: "less_than", runtimeMinutes: 90 }),
				),
			).toEqual({ operator: "less_than", minutes: 90 });
		});

		it("seerr_request_age", () => {
			expect(buildParams(makeState({ ruleType: "seerr_request_age" }))).toEqual({
				operator: "older_than",
				days: 90,
			});
		});

		it("seerr_request_modified_age", () => {
			expect(buildParams(makeState({ ruleType: "seerr_request_modified_age" }))).toEqual({
				operator: "older_than",
				days: 90,
			});
		});

		it("tautulli_watch_count", () => {
			expect(buildParams(makeState({ ruleType: "tautulli_watch_count" }))).toEqual({
				operator: "less_than",
				count: 1,
			});
		});

		it("plex_watch_count", () => {
			expect(buildParams(makeState({ ruleType: "plex_watch_count" }))).toEqual({
				operator: "less_than",
				count: 1,
			});
		});

		it("audio_channels", () => {
			expect(buildParams(makeState({ ruleType: "audio_channels" }))).toEqual({
				operator: "less_than",
				channels: 6,
			});
		});

		it("seerr_request_count", () => {
			expect(buildParams(makeState({ ruleType: "seerr_request_count" }))).toEqual({
				operator: "less_than",
				count: 1,
			});
		});

		it("plex_added_at", () => {
			expect(buildParams(makeState({ ruleType: "plex_added_at" }))).toEqual({
				operator: "older_than",
				days: 90,
			});
		});

		it("file_path: includes operator, pattern, and field", () => {
			expect(buildParams(makeState({ ruleType: "file_path" }))).toEqual({
				operator: "matches",
				pattern: ".*sample.*",
				field: "path",
			});
		});
	});

	describe("behavior analysis rules (delegate to behaviorParams)", () => {
		it("plex_episode_completion: returns behaviorParams as-is", () => {
			const bp = { operator: "less_than", percentage: 10 };
			expect(
				buildParams(makeState({ ruleType: "plex_episode_completion", behaviorParams: bp })),
			).toEqual(bp);
		});

		it("user_retention: returns behaviorParams as-is", () => {
			const bp = { operator: "watched_by_none", source: "plex" };
			expect(
				buildParams(makeState({ ruleType: "user_retention", behaviorParams: bp })),
			).toEqual(bp);
		});

		it("staleness_score: returns behaviorParams as-is", () => {
			const bp = { operator: "greater_than", threshold: 70 };
			expect(
				buildParams(makeState({ ruleType: "staleness_score", behaviorParams: bp })),
			).toEqual(bp);
		});

		it("recently_active: returns behaviorParams as-is", () => {
			const bp = { protectionDays: 30, requireActivity: true };
			expect(
				buildParams(makeState({ ruleType: "recently_active", behaviorParams: bp })),
			).toEqual(bp);
		});
	});

	describe("default/fallback", () => {
		it("unknown rule type falls through to empty object", () => {
			// composite and other unhandled types hit default
			expect(buildParams(makeState({ ruleType: "composite" }))).toEqual({});
		});

		it("seerr_requester_watched falls through to empty object", () => {
			expect(
				buildParams(makeState({ ruleType: "seerr_requester_watched" as CleanupRuleType })),
			).toEqual({});
		});

		it("seerr_requester_not_watched falls through to empty object", () => {
			expect(
				buildParams(makeState({ ruleType: "seerr_requester_not_watched" as CleanupRuleType })),
			).toEqual({});
		});
	});
});
