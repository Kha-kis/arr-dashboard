/**
 * Phase 2 Behavior-Aware Rule Tests
 *
 * Covers:
 *  1. Episode completion (6 tests)
 *  2. User retention (5 tests)
 *  3. Staleness score (6 tests)
 *
 * Run with: npx vitest run phase2-behavior.test.ts
 */

import { describe, expect, it } from "vitest";
import type {
	CacheItemForEval,
	EvalContext,
	PlexEpisodeStats,
	PlexWatchInfo,
	TautulliWatchInfo,
} from "./types.js";
import {
	evaluateSingleCondition,
} from "./rule-evaluators.js";

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

const NOW = new Date("2026-03-01T12:00:00Z");

const DEFAULT_DATA = {
	genres: ["Drama"],
	ratings: { tmdb: { value: 7.5 }, imdb: { value: 7.2 } },
	remoteIds: { tmdbId: 12345 },
	movieFile: {
		mediaInfo: {
			videoCodec: "h265",
			audioCodec: "eac3",
			resolution: "1920x1080",
		},
	},
	tags: [],
};

const SERIES_DATA = {
	genres: ["Drama"],
	ratings: { tmdb: { value: 6.0 } },
	remoteIds: { tmdbId: 99999 },
	tags: [],
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
		arrAddedAt: new Date("2025-12-01T00:00:00Z"),
		data: JSON.stringify(DEFAULT_DATA),
		...overrides,
	};
}

function makeSeriesItem(overrides: Partial<CacheItemForEval> = {}): CacheItemForEval {
	return makeCacheItem({
		id: "cache-series-1",
		itemType: "series",
		title: "Test Series",
		data: JSON.stringify(SERIES_DATA),
		...overrides,
	});
}

function baseCtx(overrides: Partial<EvalContext> = {}): EvalContext {
	return { now: NOW, ...overrides };
}

// ===========================================================================
// 1. Episode Completion Rule
// ===========================================================================

describe("plex_episode_completion rule", () => {
	it("matches when completion is below threshold", () => {
		const episodeMap = new Map<number, PlexEpisodeStats>();
		episodeMap.set(99999, { total: 20, watched: 1, seasons: new Map() }); // 5% watched

		const ctx = baseCtx({ plexEpisodeMap: episodeMap });
		const result = evaluateSingleCondition(
			makeSeriesItem(),
			"plex_episode_completion",
			{ operator: "less_than", percentage: 10 },
			ctx,
		);
		expect(result).toContain("5%");
		expect(result).toContain("1/20");
		expect(result).toContain("< 10%");
	});

	it("does not match when completion is above threshold", () => {
		const episodeMap = new Map<number, PlexEpisodeStats>();
		episodeMap.set(99999, { total: 20, watched: 15, seasons: new Map() }); // 75% watched

		const ctx = baseCtx({ plexEpisodeMap: episodeMap });
		const result = evaluateSingleCondition(
			makeSeriesItem(),
			"plex_episode_completion",
			{ operator: "less_than", percentage: 10 },
			ctx,
		);
		expect(result).toBeNull();
	});

	it("greater_than operator matches high completion", () => {
		const episodeMap = new Map<number, PlexEpisodeStats>();
		episodeMap.set(99999, { total: 10, watched: 10, seasons: new Map() }); // 100% watched

		const ctx = baseCtx({ plexEpisodeMap: episodeMap });
		const result = evaluateSingleCondition(
			makeSeriesItem(),
			"plex_episode_completion",
			{ operator: "greater_than", percentage: 90 },
			ctx,
		);
		expect(result).toContain("100%");
		expect(result).toContain("> 90%");
	});

	it("returns null for movie items (series-only rule)", () => {
		const episodeMap = new Map<number, PlexEpisodeStats>();
		episodeMap.set(12345, { total: 10, watched: 0, seasons: new Map() });

		const ctx = baseCtx({ plexEpisodeMap: episodeMap });
		const result = evaluateSingleCondition(
			makeCacheItem(), // itemType = "movie"
			"plex_episode_completion",
			{ operator: "less_than", percentage: 10 },
			ctx,
		);
		expect(result).toBeNull();
	});

	it("returns null when no episode data exists for show", () => {
		const episodeMap = new Map<number, PlexEpisodeStats>();
		// No entry for tmdbId 99999

		const ctx = baseCtx({ plexEpisodeMap: episodeMap });
		const result = evaluateSingleCondition(
			makeSeriesItem(),
			"plex_episode_completion",
			{ operator: "less_than", percentage: 10 },
			ctx,
		);
		expect(result).toBeNull();
	});

	it("handles zero total episodes gracefully", () => {
		const episodeMap = new Map<number, PlexEpisodeStats>();
		episodeMap.set(99999, { total: 0, watched: 0, seasons: new Map() });

		const ctx = baseCtx({ plexEpisodeMap: episodeMap });
		const result = evaluateSingleCondition(
			makeSeriesItem(),
			"plex_episode_completion",
			{ operator: "less_than", percentage: 10 },
			ctx,
		);
		expect(result).toBeNull(); // Division by zero guard
	});
});

// ===========================================================================
// 2. User Retention Rule
// ===========================================================================

describe("user_retention rule", () => {
	const plexMap = new Map<string, PlexWatchInfo>();
	plexMap.set("movie:12345", {
		watchCount: 3,
		lastWatchedAt: new Date("2026-02-15T00:00:00Z"),
		addedAt: new Date("2025-06-01T00:00:00Z"),
		onDeck: false,
		userRating: null,
		collections: [],
		labels: [],
		watchedByUsers: ["alice", "bob"],
		sections: [],
	});

	const tautulliMap = new Map<string, TautulliWatchInfo>();
	tautulliMap.set("movie:12345", {
		lastWatchedAt: new Date("2026-02-10T00:00:00Z"),
		watchCount: 5,
		watchedByUsers: ["alice", "charlie"],
	});

	it("watched_by_none matches when no one has watched", () => {
		// Empty plexMap — no watch data for this item
		const ctx = baseCtx({ plexMap: new Map() });
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"user_retention",
			{ operator: "watched_by_none", source: "plex" },
			ctx,
		);
		expect(result).toContain("Not watched by any user");
	});

	it("watched_by_none does NOT match when users have watched", () => {
		const ctx = baseCtx({ plexMap });
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"user_retention",
			{ operator: "watched_by_none", source: "plex" },
			ctx,
		);
		expect(result).toBeNull(); // alice and bob watched it
	});

	it("watched_by_all matches when all specified users watched", () => {
		const ctx = baseCtx({ plexMap });
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"user_retention",
			{ operator: "watched_by_all", userNames: ["alice", "bob"], source: "plex" },
			ctx,
		);
		expect(result).toContain("Watched by all specified users");
	});

	it("watched_by_count matches when enough users watched", () => {
		const ctx = baseCtx({ plexMap });
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"user_retention",
			{ operator: "watched_by_count", minUsers: 2, source: "plex" },
			ctx,
		);
		expect(result).toContain("2 user(s) >= 2");
	});

	it("either source combines Plex and Tautulli users", () => {
		const ctx = baseCtx({ plexMap, tautulliMap });
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"user_retention",
			{ operator: "watched_by_count", minUsers: 3, source: "either" },
			ctx,
		);
		// alice (both), bob (plex), charlie (tautulli) = 3 unique users
		expect(result).toContain("3 user(s) >= 3");
	});
});

// ===========================================================================
// 3. Staleness Score Rule
// ===========================================================================

describe("staleness_score rule", () => {
	it("matches when score exceeds threshold", () => {
		// No plex data → all plex-derived scores are max (100)
		const ctx = baseCtx();
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"staleness_score",
			{ operator: "greater_than", threshold: 50 },
			ctx,
		);
		expect(result).not.toBeNull();
		expect(result).toContain("Staleness score");
		expect(result).toContain("> 50");
	});

	it("does not match when item has strong signals", () => {
		const plexMap = new Map<string, PlexWatchInfo>();
		plexMap.set("movie:12345", {
			watchCount: 15, // High watch count
			lastWatchedAt: new Date("2026-02-28T00:00:00Z"), // Very recent
			addedAt: new Date("2025-06-01T00:00:00Z"),
			onDeck: true,
			userRating: 9.0, // High rating
			collections: [],
			labels: [],
			watchedByUsers: ["alice"],
			sections: [],
		});

		const ctx = baseCtx({ plexMap });
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"staleness_score",
			{ operator: "greater_than", threshold: 50 },
			ctx,
		);
		// Recent watch, high count, on deck, high user rating, high tmdb rating → low score
		expect(result).toBeNull();
	});

	it("custom weights affect the score", () => {
		// Only weight size — item is 5GB, which is 10/100 → score ≈ 10
		const ctx = baseCtx();
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"staleness_score",
			{
				operator: "greater_than",
				threshold: 50,
				weights: {
					daysSinceLastWatch: 0,
					inverseWatchCount: 0,
					notOnDeck: 0,
					lowUserRating: 0,
					lowTmdbRating: 0,
					sizeOnDisk: 1,
				},
			},
			ctx,
		);
		// 5GB item → sizeScore = (5/50)*100 = 10 → score = 10
		expect(result).toBeNull(); // 10 < 50 threshold
	});

	it("high size items score higher on sizeOnDisk weight", () => {
		const ctx = baseCtx();
		const result = evaluateSingleCondition(
			makeCacheItem({ sizeOnDisk: BigInt(60 * 1024 * 1024 * 1024) }), // 60GB
			"staleness_score",
			{
				operator: "greater_than",
				threshold: 50,
				weights: {
					daysSinceLastWatch: 0,
					inverseWatchCount: 0,
					notOnDeck: 0,
					lowUserRating: 0,
					lowTmdbRating: 0,
					sizeOnDisk: 1,
				},
			},
			ctx,
		);
		// 60GB → sizeScore = min(100, (60/50)*100) = 100 → score = 100 > 50
		expect(result).not.toBeNull();
	});

	it("returns null when item has no data", () => {
		const ctx = baseCtx();
		const result = evaluateSingleCondition(
			makeCacheItem({ data: "" }), // No parseable data
			"staleness_score",
			{ operator: "greater_than", threshold: 50 },
			ctx,
		);
		expect(result).toBeNull();
	});

	it("normalizes weights correctly", () => {
		// Use weights that sum to 0.5 instead of 1.0
		// Score should still be properly normalized
		const plexMap = new Map<string, PlexWatchInfo>();
		plexMap.set("movie:12345", {
			watchCount: 0,
			lastWatchedAt: null,
			addedAt: null,
			onDeck: false,
			userRating: null,
			collections: [],
			labels: [],
			watchedByUsers: [],
			sections: [],
		});

		const ctx = baseCtx({ plexMap });
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"staleness_score",
			{
				operator: "greater_than",
				threshold: 80,
				weights: {
					daysSinceLastWatch: 0.25,
					inverseWatchCount: 0.25,
					notOnDeck: 0,
					lowUserRating: 0,
					lowTmdbRating: 0,
					sizeOnDisk: 0,
				},
			},
			ctx,
		);
		// daysSinceLastWatch: no watch → 100, inverseWatchCount: 0 plays → 100
		// weighted: (100*0.25 + 100*0.25) / 0.5 = 100 > 80
		expect(result).not.toBeNull();
	});
});
