/**
 * Extended Library Cleanup Rule Evaluator Tests
 *
 * Covers the 32 rule types that have zero coverage in rule-evaluators.test.ts.
 * Uses the same factory pattern (makeCacheItem, makeRule, baseCtx).
 *
 * Run with: npx vitest run rule-evaluators-extended.test.ts
 */

import { describe, expect, it } from "vitest";
import type {
	CacheItemForEval,
	EvalContext,
	PlexWatchInfo,
	SeerrRequestInfo,
	TautulliWatchInfo,
} from "./types.js";
import { evaluateSingleCondition } from "./rule-evaluators.js";

// ---------------------------------------------------------------------------
// Factories (same pattern as rule-evaluators.test.ts)
// ---------------------------------------------------------------------------

const NOW = new Date("2026-03-01T12:00:00Z");

/**
 * File metadata fields are FLAT on movieFile (NOT nested under mediaInfo).
 * extractFileMetadata() reads movieFile.videoCodec, movieFile.audioCodec, etc.
 */
const DEFAULT_DATA = {
	genres: ["Action", "Sci-Fi"],
	ratings: { tmdb: { value: 7.5 }, imdb: { value: 7.2 } },
	remoteIds: { tmdbId: 12345 },
	movieFile: {
		videoCodec: "h265",
		audioCodec: "EAC3 5.1",
		resolution: "R1080p",
		videoDynamicRange: "HDR",
		customFormatScore: 85,
		releaseGroup: "SPARKS",
		path: "/movies/Test Movie (2020)/Test.Movie.2020.1080p.BluRay.mkv",
	},
	runtime: 142,
	path: "/movies/Test Movie (2020)",
	rootFolderPath: "/movies",
	tags: [1, 3],
	originalLanguage: { name: "English" },
};

function makeCacheItem(overrides: Partial<CacheItemForEval> = {}): CacheItemForEval {
	return {
		id: "cache-1",
		instanceId: "instance-1",
		arrItemId: 100,
		itemType: "movie",
		title: "Test Movie 2020",
		year: 2020,
		monitored: true,
		hasFile: true,
		status: "released",
		qualityProfileId: 1,
		qualityProfileName: "HD-1080p",
		sizeOnDisk: BigInt(5 * 1024 * 1024 * 1024), // 5 GB
		arrAddedAt: new Date("2025-12-01T00:00:00Z"), // ~90 days before NOW
		data: JSON.stringify(DEFAULT_DATA),
		...overrides,
	};
}

function baseCtx(overrides: Partial<EvalContext> = {}): EvalContext {
	return { now: NOW, ...overrides };
}

// ---------------------------------------------------------------------------
// Seerr test data factory
// ---------------------------------------------------------------------------

function makeSeerrMap(
	entries?: Record<string, SeerrRequestInfo[]>,
): Map<string, SeerrRequestInfo[]> {
	const map = new Map<string, SeerrRequestInfo[]>();
	if (entries) {
		for (const [key, val] of Object.entries(entries)) {
			map.set(key, val);
		}
	} else {
		map.set("movie:12345", [
			{
				requestId: 1,
				status: 2, // approved
				requestedBy: "alice",
				requestedByUserId: 10,
				createdAt: "2025-06-01T00:00:00Z",
				updatedAt: "2025-06-15T00:00:00Z",
				modifiedBy: "admin",
				is4k: false,
			},
			{
				requestId: 2,
				status: 5, // completed
				requestedBy: "bob",
				requestedByUserId: 20,
				createdAt: "2026-01-15T00:00:00Z",
				updatedAt: "2026-01-20T00:00:00Z",
				modifiedBy: null,
				is4k: true,
			},
		]);
	}
	return map;
}

// ---------------------------------------------------------------------------
// Plex/Tautulli test data factories
// ---------------------------------------------------------------------------

function makePlexEntry(overrides: Partial<PlexWatchInfo> = {}): PlexWatchInfo {
	return {
		lastWatchedAt: new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000), // 10 days ago
		watchCount: 3,
		watchedByUsers: ["admin", "bob"],
		onDeck: true,
		userRating: 8.5,
		collections: ["Marvel", "Favorites"],
		labels: ["keep", "4k"],
		addedAt: new Date("2025-06-01T00:00:00Z"),
		sections: [],
		...overrides,
	};
}

function makePlexMap(entry?: PlexWatchInfo): Map<string, PlexWatchInfo> {
	const map = new Map<string, PlexWatchInfo>();
	map.set("movie:12345", entry ?? makePlexEntry());
	return map;
}

function makeTautulliEntry(overrides: Partial<TautulliWatchInfo> = {}): TautulliWatchInfo {
	return {
		lastWatchedAt: new Date(NOW.getTime() - 15 * 24 * 60 * 60 * 1000), // 15 days ago
		watchCount: 2,
		watchedByUsers: ["admin", "alice"],
		...overrides,
	};
}

function makeTautulliMap(entry?: TautulliWatchInfo): Map<string, TautulliWatchInfo> {
	const map = new Map<string, TautulliWatchInfo>();
	map.set("movie:12345", entry ?? makeTautulliEntry());
	return map;
}

// ===========================================================================
// 1. Simple ARR Rules
// ===========================================================================

describe("status rule", () => {
	const ctx = baseCtx();

	it("matches when item status is in the list", () => {
		const result = evaluateSingleCondition(
			makeCacheItem({ status: "released" }),
			"status",
			{ statuses: ["released", "announced"] },
			ctx,
		);
		expect(result).toContain("released");
	});

	it("does not match when status is not in the list", () => {
		const result = evaluateSingleCondition(
			makeCacheItem({ status: "continuing" }),
			"status",
			{ statuses: ["released", "ended"] },
			ctx,
		);
		expect(result).toBeNull();
	});

	it("returns null when status is null", () => {
		const result = evaluateSingleCondition(
			makeCacheItem({ status: null }),
			"status",
			{ statuses: ["released"] },
			ctx,
		);
		expect(result).toBeNull();
	});
});

describe("unmonitored rule", () => {
	const ctx = baseCtx();

	it("matches when item is unmonitored", () => {
		const result = evaluateSingleCondition(
			makeCacheItem({ monitored: false }),
			"unmonitored",
			{},
			ctx,
		);
		expect(result).toContain("unmonitored");
	});

	it("does not match when item is monitored", () => {
		const result = evaluateSingleCondition(
			makeCacheItem({ monitored: true }),
			"unmonitored",
			{},
			ctx,
		);
		expect(result).toBeNull();
	});
});

describe("no_file rule", () => {
	const ctx = baseCtx();

	it("matches when item has no file", () => {
		const result = evaluateSingleCondition(makeCacheItem({ hasFile: false }), "no_file", {}, ctx);
		expect(result).toContain("no file");
	});

	it("does not match when item has a file", () => {
		const result = evaluateSingleCondition(makeCacheItem({ hasFile: true }), "no_file", {}, ctx);
		expect(result).toBeNull();
	});
});

describe("year_range rule", () => {
	const ctx = baseCtx();

	it("matches 'before' operator", () => {
		const result = evaluateSingleCondition(
			makeCacheItem({ year: 2015 }),
			"year_range",
			{ operator: "before", year: 2020 },
			ctx,
		);
		expect(result).toContain("before 2020");
	});

	it("matches 'after' operator", () => {
		const result = evaluateSingleCondition(
			makeCacheItem({ year: 2024 }),
			"year_range",
			{ operator: "after", year: 2020 },
			ctx,
		);
		expect(result).toContain("after 2020");
	});

	it("matches 'between' operator", () => {
		const result = evaluateSingleCondition(
			makeCacheItem({ year: 2020 }),
			"year_range",
			{ operator: "between", yearFrom: 2018, yearTo: 2022 },
			ctx,
		);
		expect(result).toContain("between 2018-2022");
	});

	it("does not match when year is outside range", () => {
		const result = evaluateSingleCondition(
			makeCacheItem({ year: 2025 }),
			"year_range",
			{ operator: "before", year: 2020 },
			ctx,
		);
		expect(result).toBeNull();
	});

	it("returns null when year is null", () => {
		const result = evaluateSingleCondition(
			makeCacheItem({ year: null }),
			"year_range",
			{ operator: "before", year: 2020 },
			ctx,
		);
		expect(result).toBeNull();
	});
});

describe("quality_profile rule", () => {
	const ctx = baseCtx();

	it("matches when profile name is in the list", () => {
		const result = evaluateSingleCondition(
			makeCacheItem({ qualityProfileName: "HD-1080p" }),
			"quality_profile",
			{ profileNames: ["HD-1080p", "Ultra-HD"] },
			ctx,
		);
		expect(result).toContain("HD-1080p");
	});

	it("does not match when profile name is not in the list", () => {
		const result = evaluateSingleCondition(
			makeCacheItem({ qualityProfileName: "SD" }),
			"quality_profile",
			{ profileNames: ["HD-1080p", "Ultra-HD"] },
			ctx,
		);
		expect(result).toBeNull();
	});

	it("is case-insensitive", () => {
		const result = evaluateSingleCondition(
			makeCacheItem({ qualityProfileName: "hd-1080p" }),
			"quality_profile",
			{ profileNames: ["HD-1080p"] },
			ctx,
		);
		expect(result).not.toBeNull();
	});
});

describe("language rule", () => {
	const ctx = baseCtx();

	it("includes_any matches when language is present", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"language",
			{ operator: "includes_any", languages: ["English", "French"] },
			ctx,
		);
		expect(result).toContain("english");
	});

	it("excludes_all matches when item has none of the target languages", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"language",
			{ operator: "excludes_all", languages: ["Japanese", "Korean"] },
			ctx,
		);
		expect(result).toContain("exclude");
	});

	it("does not match when language is missing", () => {
		const result = evaluateSingleCondition(
			makeCacheItem({ data: JSON.stringify({ genres: [] }) }),
			"language",
			{ operator: "includes_any", languages: ["English"] },
			ctx,
		);
		expect(result).toBeNull();
	});
});

// ===========================================================================
// 2. File Metadata Rules
// ===========================================================================

describe("video_codec rule", () => {
	const ctx = baseCtx();

	it("'is' matches when codec is in the list", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"video_codec",
			{ operator: "is", codecs: ["h265", "av1"] },
			ctx,
		);
		expect(result).toContain("h265");
	});

	it("'is_not' matches when codec is NOT in the list", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"video_codec",
			{ operator: "is_not", codecs: ["h264"] },
			ctx,
		);
		expect(result).toContain("not in");
	});

	it("does not match when codec matches is_not list", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"video_codec",
			{ operator: "is_not", codecs: ["h265"] },
			ctx,
		);
		expect(result).toBeNull();
	});

	it("returns null when no file metadata", () => {
		const result = evaluateSingleCondition(
			makeCacheItem({ data: JSON.stringify({ genres: [] }) }),
			"video_codec",
			{ operator: "is", codecs: ["h265"] },
			ctx,
		);
		expect(result).toBeNull();
	});
});

describe("audio_codec rule", () => {
	const ctx = baseCtx();

	it("'is' matches when codec is in the list", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"audio_codec",
			{ operator: "is", codecs: ["eac3 5.1"] },
			ctx,
		);
		expect(result).toContain("EAC3 5.1");
	});

	it("'is_not' matches when codec is NOT in the list", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"audio_codec",
			{ operator: "is_not", codecs: ["aac"] },
			ctx,
		);
		expect(result).toContain("not in");
	});
});

describe("resolution rule", () => {
	const ctx = baseCtx();

	it("'is' matches when resolution is in the list", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"resolution",
			{ operator: "is", resolutions: ["R1080p", "R2160p"] },
			ctx,
		);
		expect(result).toContain("R1080p");
	});

	it("'is_not' matches when resolution is NOT in the list", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"resolution",
			{ operator: "is_not", resolutions: ["R720p"] },
			ctx,
		);
		expect(result).toContain("not in");
	});

	it("does not match when resolution is in the is_not list", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"resolution",
			{ operator: "is_not", resolutions: ["R1080p"] },
			ctx,
		);
		expect(result).toBeNull();
	});
});

describe("hdr_type rule", () => {
	const ctx = baseCtx();

	it("'is' matches when HDR type is in the list", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"hdr_type",
			{ operator: "is", types: ["HDR", "Dolby Vision"] },
			ctx,
		);
		expect(result).toContain("HDR");
	});

	it("'is_not' matches when HDR type is NOT in the list", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"hdr_type",
			{ operator: "is_not", types: ["Dolby Vision"] },
			ctx,
		);
		expect(result).toContain("not in");
	});

	it("'none' matches when no HDR is present", () => {
		const data = {
			...DEFAULT_DATA,
			movieFile: { ...DEFAULT_DATA.movieFile, videoDynamicRange: "" },
		};
		const result = evaluateSingleCondition(
			makeCacheItem({ data: JSON.stringify(data) }),
			"hdr_type",
			{ operator: "none" },
			ctx,
		);
		expect(result).toContain("No HDR");
	});

	it("'none' does not match when HDR is present", () => {
		const result = evaluateSingleCondition(makeCacheItem(), "hdr_type", { operator: "none" }, ctx);
		expect(result).toBeNull();
	});
});

describe("custom_format_score rule", () => {
	const ctx = baseCtx();

	it("matches when score is greater than threshold", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"custom_format_score",
			{ operator: "greater_than", score: 50 },
			ctx,
		);
		expect(result).toContain("85");
		expect(result).toContain("> 50");
	});

	it("matches when score is less than threshold", () => {
		const data = {
			...DEFAULT_DATA,
			movieFile: { ...DEFAULT_DATA.movieFile, customFormatScore: 10 },
		};
		const result = evaluateSingleCondition(
			makeCacheItem({ data: JSON.stringify(data) }),
			"custom_format_score",
			{ operator: "less_than", score: 50 },
			ctx,
		);
		expect(result).toContain("10");
		expect(result).toContain("< 50");
	});

	it("does not match when score is within threshold", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"custom_format_score",
			{ operator: "less_than", score: 50 },
			ctx,
		);
		expect(result).toBeNull();
	});
});

describe("runtime rule", () => {
	const ctx = baseCtx();

	it("matches when runtime is greater than threshold", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"runtime",
			{ operator: "greater_than", minutes: 120 },
			ctx,
		);
		expect(result).toContain("142 min");
		expect(result).toContain("> 120");
	});

	it("matches when runtime is less than threshold", () => {
		const data = { ...DEFAULT_DATA, runtime: 45 };
		const result = evaluateSingleCondition(
			makeCacheItem({ data: JSON.stringify(data) }),
			"runtime",
			{ operator: "less_than", minutes: 60 },
			ctx,
		);
		expect(result).toContain("45 min");
	});

	it("does not match when runtime is within threshold", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"runtime",
			{ operator: "less_than", minutes: 120 },
			ctx,
		);
		expect(result).toBeNull();
	});
});

describe("release_group rule", () => {
	const ctx = baseCtx();

	it("'is' matches when group is in the list", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"release_group",
			{ operator: "is", groups: ["SPARKS", "FGT"] },
			ctx,
		);
		expect(result).toContain("SPARKS");
	});

	it("'is_not' matches when group is NOT in the list", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"release_group",
			{ operator: "is_not", groups: ["YTS"] },
			ctx,
		);
		expect(result).toContain("not in");
	});

	it("does not match when group is in is_not list", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"release_group",
			{ operator: "is_not", groups: ["SPARKS"] },
			ctx,
		);
		expect(result).toBeNull();
	});
});

// ===========================================================================
// 3. Extended File Metadata Rules
// ===========================================================================

describe("audio_channels rule", () => {
	const ctx = baseCtx();

	it("parses 5.1 from audioCodec and matches 'is' 6", () => {
		// "EAC3 5.1" → 5+1 = 6 channels
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"audio_channels",
			{ operator: "is", channels: 6 },
			ctx,
		);
		expect(result).toContain("6");
	});

	it("'greater_than' matches when channels exceed threshold", () => {
		const data = {
			...DEFAULT_DATA,
			movieFile: { ...DEFAULT_DATA.movieFile, audioCodec: "TrueHD 7.1" },
		};
		const result = evaluateSingleCondition(
			makeCacheItem({ data: JSON.stringify(data) }),
			"audio_channels",
			{ operator: "greater_than", channels: 6 },
			ctx,
		);
		expect(result).toContain("8");
		expect(result).toContain("> 6");
	});

	it("'less_than' matches when channels are below threshold", () => {
		const data = {
			...DEFAULT_DATA,
			movieFile: { ...DEFAULT_DATA.movieFile, audioCodec: "AAC Stereo" },
		};
		const result = evaluateSingleCondition(
			makeCacheItem({ data: JSON.stringify(data) }),
			"audio_channels",
			{ operator: "less_than", channels: 6 },
			ctx,
		);
		expect(result).toContain("2");
	});

	it("parses Atmos as 8 channels", () => {
		const data = {
			...DEFAULT_DATA,
			movieFile: { ...DEFAULT_DATA.movieFile, audioCodec: "TrueHD Atmos" },
		};
		const result = evaluateSingleCondition(
			makeCacheItem({ data: JSON.stringify(data) }),
			"audio_channels",
			{ operator: "is", channels: 8 },
			ctx,
		);
		expect(result).toContain("8");
	});

	it("does not match when channels differ for 'is'", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"audio_channels",
			{ operator: "is", channels: 8 },
			ctx,
		);
		expect(result).toBeNull();
	});
});

describe("file_path rule", () => {
	const ctx = baseCtx();

	it("'matches' matches when path matches regex", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"file_path",
			{ operator: "matches", pattern: "Test.*2020", field: "path" },
			ctx,
		);
		expect(result).toContain("matches pattern");
	});

	it("'not_matches' matches when path does not match regex", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"file_path",
			{ operator: "not_matches", pattern: "NonExistent", field: "path" },
			ctx,
		);
		expect(result).toContain("does not match");
	});

	it("uses rootFolderPath when field is 'rootFolderPath'", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"file_path",
			{ operator: "matches", pattern: "^/movies$", field: "rootFolderPath" },
			ctx,
		);
		expect(result).toContain("/movies");
	});

	it("does not match when path matches a 'not_matches' pattern", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"file_path",
			{ operator: "not_matches", pattern: "Test.*Movie", field: "path" },
			ctx,
		);
		expect(result).toBeNull();
	});
});

describe("tag_match rule", () => {
	const ctx = baseCtx();

	it("'includes_any' matches when item has any target tag", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"tag_match",
			{ operator: "includes_any", tagIds: [1, 5] },
			ctx,
		);
		expect(result).toContain("1");
	});

	it("'excludes_all' matches when item has none of the target tags", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"tag_match",
			{ operator: "excludes_all", tagIds: [5, 10] },
			ctx,
		);
		expect(result).toContain("Does not have");
	});

	it("does not match 'includes_any' when no tags overlap", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"tag_match",
			{ operator: "includes_any", tagIds: [99] },
			ctx,
		);
		expect(result).toBeNull();
	});

	it("does not match 'excludes_all' when item has a target tag", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"tag_match",
			{ operator: "excludes_all", tagIds: [1] },
			ctx,
		);
		expect(result).toBeNull();
	});
});

// ===========================================================================
// 4. IMDb Rating Rule
// ===========================================================================

describe("imdb_rating rule", () => {
	const ctx = baseCtx();

	it("matches when IMDb rating is below threshold", () => {
		const data = { ...DEFAULT_DATA, ratings: { ...DEFAULT_DATA.ratings, imdb: { value: 4.5 } } };
		const result = evaluateSingleCondition(
			makeCacheItem({ data: JSON.stringify(data) }),
			"imdb_rating",
			{ operator: "less_than", score: 5 },
			ctx,
		);
		expect(result).toContain("4.5");
		expect(result).toContain("< 5");
	});

	it("matches when IMDb rating is above threshold", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"imdb_rating",
			{ operator: "greater_than", score: 6 },
			ctx,
		);
		expect(result).toContain("7.2");
		expect(result).toContain("> 6");
	});

	it("'unrated' matches when no IMDb rating exists", () => {
		const data = { ...DEFAULT_DATA, ratings: { tmdb: { value: 7.0 } } };
		const result = evaluateSingleCondition(
			makeCacheItem({ data: JSON.stringify(data) }),
			"imdb_rating",
			{ operator: "unrated" },
			ctx,
		);
		expect(result).toBe("No IMDb rating");
	});

	it("'unrated' does not match when rating exists", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"imdb_rating",
			{ operator: "unrated" },
			ctx,
		);
		expect(result).toBeNull();
	});
});

// ===========================================================================
// 5. Seerr Rules
// ===========================================================================

describe("seerr_requested_by rule", () => {
	const ctx = baseCtx({ seerrMap: makeSeerrMap() });

	it("matches when requested by target user", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"seerr_requested_by",
			{ userNames: ["alice"] },
			ctx,
		);
		expect(result).toContain("alice");
	});

	it("does not match when not requested by target user", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"seerr_requested_by",
			{ userNames: ["charlie"] },
			ctx,
		);
		expect(result).toBeNull();
	});
});

describe("seerr_request_age rule", () => {
	const ctx = baseCtx({ seerrMap: makeSeerrMap() });

	it("matches when oldest request is older than threshold", () => {
		// Oldest request: 2025-06-01 → ~274 days before NOW
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"seerr_request_age",
			{ operator: "older_than", days: 200 },
			ctx,
		);
		expect(result).toContain("days old");
		expect(result).toContain("> 200 days");
	});

	it("matches 'newer_than' when request is recent", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"seerr_request_age",
			{ operator: "newer_than", days: 365 },
			ctx,
		);
		expect(result).toContain("days old");
		expect(result).toContain("< 365 days");
	});

	it("does not match when request is too recent for older_than", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"seerr_request_age",
			{ operator: "older_than", days: 365 },
			ctx,
		);
		expect(result).toBeNull();
	});
});

describe("seerr_is_4k rule", () => {
	const ctx = baseCtx({ seerrMap: makeSeerrMap() });

	it("matches when a 4K request exists and is4k=true", () => {
		const result = evaluateSingleCondition(makeCacheItem(), "seerr_is_4k", { is4k: true }, ctx);
		expect(result).toContain("4K");
	});

	it("matches when a non-4K request exists and is4k=false", () => {
		const result = evaluateSingleCondition(makeCacheItem(), "seerr_is_4k", { is4k: false }, ctx);
		expect(result).toContain("not 4K");
	});
});

describe("seerr_request_modified_age rule", () => {
	const ctx = baseCtx({ seerrMap: makeSeerrMap() });

	it("matches when most recent modification is older than threshold", () => {
		// Most recent updatedAt: 2026-01-20 → ~40 days before NOW
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"seerr_request_modified_age",
			{ operator: "older_than", days: 30 },
			ctx,
		);
		expect(result).toContain("days ago");
		expect(result).toContain("> 30 days");
	});

	it("does not match when modification is too recent", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"seerr_request_modified_age",
			{ operator: "older_than", days: 90 },
			ctx,
		);
		expect(result).toBeNull();
	});
});

describe("seerr_modified_by rule", () => {
	const ctx = baseCtx({ seerrMap: makeSeerrMap() });

	it("matches when request was modified by target user", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"seerr_modified_by",
			{ userNames: ["admin"] },
			ctx,
		);
		expect(result).toContain("admin");
	});

	it("does not match when modified by someone else", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"seerr_modified_by",
			{ userNames: ["charlie"] },
			ctx,
		);
		expect(result).toBeNull();
	});
});

describe("seerr_is_requested rule", () => {
	const ctx = baseCtx({ seerrMap: makeSeerrMap() });

	it("matches when item has a request and isRequested=true", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"seerr_is_requested",
			{ isRequested: true },
			ctx,
		);
		expect(result).toContain("Seerr request");
	});

	it("matches when item has no request and isRequested=false", () => {
		const data = { ...DEFAULT_DATA, remoteIds: { tmdbId: 99999 } };
		const result = evaluateSingleCondition(
			makeCacheItem({ data: JSON.stringify(data) }),
			"seerr_is_requested",
			{ isRequested: false },
			ctx,
		);
		expect(result).toContain("No Seerr request");
	});

	it("does not match when request exists and isRequested=false", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"seerr_is_requested",
			{ isRequested: false },
			ctx,
		);
		expect(result).toBeNull();
	});
});

describe("seerr_request_count rule", () => {
	const ctx = baseCtx({ seerrMap: makeSeerrMap() });

	it("matches 'greater_than' when count exceeds threshold", () => {
		// Item has 2 requests
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"seerr_request_count",
			{ operator: "greater_than", count: 1 },
			ctx,
		);
		expect(result).toContain("2");
		expect(result).toContain("> 1");
	});

	it("matches 'equals' when count matches exactly", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"seerr_request_count",
			{ operator: "equals", count: 2 },
			ctx,
		);
		expect(result).toContain("2");
	});

	it("returns null for items not found in seerr (avoids false zero-count matches)", () => {
		const data = { ...DEFAULT_DATA, remoteIds: { tmdbId: 99999 } };
		const result = evaluateSingleCondition(
			makeCacheItem({ data: JSON.stringify(data) }),
			"seerr_request_count",
			{ operator: "less_than", count: 1 },
			ctx,
		);
		expect(result).toBeNull();
	});

	it("does not match when count is equal for less_than", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"seerr_request_count",
			{ operator: "less_than", count: 2 },
			ctx,
		);
		expect(result).toBeNull();
	});
});

// ===========================================================================
// 6. Tautulli Rules
// ===========================================================================

describe("tautulli_last_watched rule", () => {
	const ctx = baseCtx({ tautulliMap: makeTautulliMap() });

	it("matches 'older_than' when last watched exceeds threshold", () => {
		// lastWatchedAt is 15 days ago
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"tautulli_last_watched",
			{ operator: "older_than", days: 10 },
			ctx,
		);
		expect(result).toContain("days ago per Tautulli");
	});

	it("does not match 'older_than' when within threshold", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"tautulli_last_watched",
			{ operator: "older_than", days: 30 },
			ctx,
		);
		expect(result).toBeNull();
	});

	it("'never' matches when item is not in tautulli", () => {
		const data = { ...DEFAULT_DATA, remoteIds: { tmdbId: 99999 } };
		const result = evaluateSingleCondition(
			makeCacheItem({ data: JSON.stringify(data) }),
			"tautulli_last_watched",
			{ operator: "never" },
			ctx,
		);
		expect(result).toBe("Never watched (per Tautulli)");
	});

	it("'never' matches when lastWatchedAt is null", () => {
		const tautulliMap = makeTautulliMap({ lastWatchedAt: null, watchCount: 0, watchedByUsers: [] });
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"tautulli_last_watched",
			{ operator: "never" },
			baseCtx({ tautulliMap }),
		);
		expect(result).toBe("Never watched (per Tautulli)");
	});
});

describe("tautulli_watched_by rule", () => {
	const ctx = baseCtx({ tautulliMap: makeTautulliMap() });

	it("'includes_any' matches when a target user watched", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"tautulli_watched_by",
			{ operator: "includes_any", userNames: ["admin", "charlie"] },
			ctx,
		);
		expect(result).toContain("admin");
	});

	it("'excludes_all' matches when none of the target users watched", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"tautulli_watched_by",
			{ operator: "excludes_all", userNames: ["charlie", "dave"] },
			ctx,
		);
		expect(result).toContain("Not watched by");
	});

	it("does not match 'includes_any' when no overlap", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"tautulli_watched_by",
			{ operator: "includes_any", userNames: ["charlie"] },
			ctx,
		);
		expect(result).toBeNull();
	});
});

// ===========================================================================
// 7. Plex Rules
// ===========================================================================

describe("plex_on_deck rule", () => {
	const ctx = baseCtx({ plexMap: makePlexMap() });

	it("matches when item IS on deck and isDeck=true", () => {
		const result = evaluateSingleCondition(makeCacheItem(), "plex_on_deck", { isDeck: true }, ctx);
		expect(result).toContain("on Plex Continue Watching");
	});

	it("matches when item is NOT on deck and isDeck=false", () => {
		const plexMap = makePlexMap(makePlexEntry({ onDeck: false }));
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"plex_on_deck",
			{ isDeck: false },
			baseCtx({ plexMap }),
		);
		expect(result).toContain("not on Plex Continue Watching");
	});

	it("does not match when on-deck status doesn't match", () => {
		const result = evaluateSingleCondition(makeCacheItem(), "plex_on_deck", { isDeck: false }, ctx);
		expect(result).toBeNull();
	});
});

describe("plex_user_rating rule", () => {
	const ctx = baseCtx({ plexMap: makePlexMap() });

	it("matches when user rating is below threshold", () => {
		const plexMap = makePlexMap(makePlexEntry({ userRating: 3.0 }));
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"plex_user_rating",
			{ operator: "less_than", rating: 5 },
			baseCtx({ plexMap }),
		);
		expect(result).toContain("3.0");
		expect(result).toContain("< 5");
	});

	it("matches when user rating is above threshold", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"plex_user_rating",
			{ operator: "greater_than", rating: 7 },
			ctx,
		);
		expect(result).toContain("8.5");
		expect(result).toContain("> 7");
	});

	it("'unrated' matches when no user rating", () => {
		const plexMap = makePlexMap(makePlexEntry({ userRating: null }));
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"plex_user_rating",
			{ operator: "unrated" },
			baseCtx({ plexMap }),
		);
		expect(result).toContain("Unrated");
	});

	it("'unrated' does not match when rating exists", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"plex_user_rating",
			{ operator: "unrated" },
			ctx,
		);
		expect(result).toBeNull();
	});
});

describe("plex_watched_by rule", () => {
	const ctx = baseCtx({ plexMap: makePlexMap() });

	it("'includes_any' matches when a target user watched", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"plex_watched_by",
			{ operator: "includes_any", userNames: ["bob"] },
			ctx,
		);
		expect(result).toContain("bob");
	});

	it("'excludes_all' matches when none of the target users watched", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"plex_watched_by",
			{ operator: "excludes_all", userNames: ["charlie", "dave"] },
			ctx,
		);
		expect(result).toContain("Not watched by");
	});

	it("does not match 'includes_any' when no overlap", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"plex_watched_by",
			{ operator: "includes_any", userNames: ["charlie"] },
			ctx,
		);
		expect(result).toBeNull();
	});
});

describe("plex_collection rule", () => {
	const ctx = baseCtx({ plexMap: makePlexMap() });

	it("'in' matches when item is in a target collection", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"plex_collection",
			{ operator: "in", collections: ["Marvel", "DC"] },
			ctx,
		);
		expect(result).toContain("marvel");
	});

	it("'not_in' matches when item is not in any target collection", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"plex_collection",
			{ operator: "not_in", collections: ["DC", "Star Wars"] },
			ctx,
		);
		expect(result).toContain("Not in Plex collection");
	});

	it("does not match 'in' when no collection overlap", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"plex_collection",
			{ operator: "in", collections: ["DC"] },
			ctx,
		);
		expect(result).toBeNull();
	});
});

describe("plex_label rule", () => {
	const ctx = baseCtx({ plexMap: makePlexMap() });

	it("'has_any' matches when item has a target label", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"plex_label",
			{ operator: "has_any", labels: ["keep", "delete"] },
			ctx,
		);
		expect(result).toContain("keep");
	});

	it("'has_none' matches when item has none of the target labels", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"plex_label",
			{ operator: "has_none", labels: ["delete", "archive"] },
			ctx,
		);
		expect(result).toContain("Does not have Plex label");
	});

	it("does not match 'has_any' when no label overlap", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"plex_label",
			{ operator: "has_any", labels: ["delete"] },
			ctx,
		);
		expect(result).toBeNull();
	});
});

describe("plex_added_at rule", () => {
	const ctx = baseCtx({ plexMap: makePlexMap() });

	it("matches 'older_than' when added to Plex long ago", () => {
		// addedAt: 2025-06-01 → ~274 days before NOW
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"plex_added_at",
			{ operator: "older_than", days: 200 },
			ctx,
		);
		expect(result).toContain("days ago");
		expect(result).toContain("> 200 days");
	});

	it("matches 'newer_than' when added to Plex recently", () => {
		const plexMap = makePlexMap(
			makePlexEntry({ addedAt: new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000) }),
		);
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"plex_added_at",
			{ operator: "newer_than", days: 10 },
			baseCtx({ plexMap }),
		);
		expect(result).toContain("days ago");
		expect(result).toContain("< 10 days");
	});

	it("does not match when age is within threshold", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"plex_added_at",
			{ operator: "older_than", days: 365 },
			ctx,
		);
		expect(result).toBeNull();
	});
});
