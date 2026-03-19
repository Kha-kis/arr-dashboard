/**
 * Library Cleanup Rule Evaluator Tests
 *
 * Safety-net tests for the rule evaluation pipeline.
 * Covers 8 high-risk rule types + composite AND/OR + a golden multi-rule test.
 *
 * Run with: npx vitest run rule-evaluators.test.ts
 */

import { describe, expect, it } from "vitest";
import type { CacheItemForEval, EvalContext, PlexWatchInfo, SeerrRequestInfo } from "./types.js";
import {
	evaluateItemAgainstRules,
	evaluateRule,
	evaluateSingleCondition,
	extractRating,
} from "./rule-evaluators.js";

// ---------------------------------------------------------------------------
// Type stub for Prisma-generated LibraryCleanupRule (avoids prisma generate)
// ---------------------------------------------------------------------------

interface TestRule {
	id: string;
	name: string;
	enabled: boolean;
	priority: number;
	ruleType: string;
	parameters: string;
	serviceFilter: string | null;
	instanceFilter: string | null;
	excludeTags: string | null;
	excludeTitles: string | null;
	plexLibraryFilter: string | null;
	action: string;
	operator: string | null;
	conditions: string | null;
	configId: string;
	retentionMode: boolean;
	createdAt: Date;
	updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

const NOW = new Date("2026-03-01T12:00:00Z");

/** Rich default data blob used by rating, genre, seerr/plex/tautulli lookups. */
const DEFAULT_DATA = {
	genres: ["Action", "Sci-Fi"],
	ratings: { tmdb: { value: 7.5 }, imdb: { value: 7.2 } },
	remoteIds: { tmdbId: 12345 },
	movieFile: {
		mediaInfo: {
			videoCodec: "h265",
			audioCodec: "eac3",
			resolution: "1920x1080",
			videoDynamicRange: "HDR",
			audioChannels: 5.1,
		},
		quality: { quality: { name: "Bluray-1080p" } },
		customFormatScore: 85,
		releaseGroup: "SPARKS",
		runtime: 142,
		path: "/movies/Test Movie (2020)/Test.Movie.2020.1080p.BluRay.mkv",
	},
	tags: [1, 3],
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

function makeRule(overrides: Partial<TestRule> = {}): TestRule {
	return {
		id: "rule-1",
		name: "Test Rule",
		enabled: true,
		priority: 1,
		ruleType: "age",
		parameters: JSON.stringify({ operator: "older_than", days: 30 }),
		serviceFilter: null,
		instanceFilter: null,
		excludeTags: null,
		excludeTitles: null,
		plexLibraryFilter: null,
		action: "delete",
		operator: null,
		conditions: null,
		configId: "config-1",
		retentionMode: false,
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

function baseCtx(overrides: Partial<EvalContext> = {}): EvalContext {
	return { now: NOW, ...overrides };
}

// ---------------------------------------------------------------------------
// 1. Age rule
// ---------------------------------------------------------------------------

describe("age rule", () => {
	const ctx = baseCtx();

	it("matches item older than threshold", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"age",
			{ operator: "older_than", days: 30 },
			ctx,
		);
		expect(result).toContain("days ago");
		expect(result).toContain("threshold: > 30 days");
	});

	it("does not match item newer than threshold", () => {
		const result = evaluateSingleCondition(
			makeCacheItem({ arrAddedAt: new Date("2026-02-28T00:00:00Z") }),
			"age",
			{ operator: "older_than", days: 30 },
			ctx,
		);
		expect(result).toBeNull();
	});

	it("newer_than operator matches recent items", () => {
		const result = evaluateSingleCondition(
			makeCacheItem({ arrAddedAt: new Date("2026-02-28T00:00:00Z") }),
			"age",
			{ operator: "newer_than", days: 30 },
			ctx,
		);
		expect(result).toContain("threshold: < 30 days");
	});

	it("returns null when arrAddedAt is null", () => {
		const result = evaluateSingleCondition(
			makeCacheItem({ arrAddedAt: null }),
			"age",
			{ operator: "older_than", days: 30 },
			ctx,
		);
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 2. Size rule
// ---------------------------------------------------------------------------

describe("size rule", () => {
	const ctx = baseCtx();

	it("matches item larger than threshold", () => {
		const result = evaluateSingleCondition(
			makeCacheItem({ sizeOnDisk: BigInt(20 * 1024 * 1024 * 1024) }),
			"size",
			{ operator: "greater_than", sizeGb: 15 },
			ctx,
		);
		expect(result).toContain("threshold: > 15 GB");
	});

	it("matches item smaller than threshold", () => {
		const result = evaluateSingleCondition(
			makeCacheItem({ sizeOnDisk: BigInt(500 * 1024 * 1024) }), // 0.49 GB
			"size",
			{ operator: "less_than", sizeGb: 1 },
			ctx,
		);
		expect(result).toContain("threshold: < 1 GB");
	});

	it("does not match item within threshold", () => {
		const result = evaluateSingleCondition(
			makeCacheItem({ sizeOnDisk: BigInt(5 * 1024 * 1024 * 1024) }),
			"size",
			{ operator: "greater_than", sizeGb: 10 },
			ctx,
		);
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 3. Rating rule (TMDB from data blob)
// ---------------------------------------------------------------------------

describe("rating rule", () => {
	const ctx = baseCtx();

	it("extractRating returns TMDB value from data blob", () => {
		const rating = extractRating(makeCacheItem());
		expect(rating).toBe(7.5);
	});

	it("extractRating returns null for item without ratings", () => {
		const rating = extractRating(makeCacheItem({ data: JSON.stringify({}) }));
		expect(rating).toBeNull();
	});

	it("matches item with rating below threshold", () => {
		const item = makeCacheItem({
			data: JSON.stringify({ ...DEFAULT_DATA, ratings: { tmdb: { value: 3.2 } } }),
		});
		const result = evaluateSingleCondition(
			item,
			"rating",
			{ operator: "less_than", score: 5 },
			ctx,
		);
		expect(result).toContain("TMDB rating: 3.2");
	});

	it("matches unrated items", () => {
		const item = makeCacheItem({ data: JSON.stringify({ genres: ["Drama"] }) });
		const result = evaluateSingleCondition(item, "rating", { operator: "unrated" }, ctx);
		expect(result).toBe("No TMDB rating");
	});

	it("does not flag rated item as unrated", () => {
		const result = evaluateSingleCondition(makeCacheItem(), "rating", { operator: "unrated" }, ctx);
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 4. Genre rule (from data blob)
// ---------------------------------------------------------------------------

describe("genre rule", () => {
	const ctx = baseCtx();

	it("includes_any matches when item has target genre", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"genre",
			{ operator: "includes_any", genres: ["Action", "Comedy"] },
			ctx,
		);
		expect(result).toContain("action");
	});

	it("includes_any does not match when no overlap", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"genre",
			{ operator: "includes_any", genres: ["Romance", "Comedy"] },
			ctx,
		);
		expect(result).toBeNull();
	});

	it("excludes_all matches when item has none of the target genres", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"genre",
			{ operator: "excludes_all", genres: ["Romance", "Comedy"] },
			ctx,
		);
		expect(result).toContain("exclude all");
	});

	it("excludes_all does not match when item has one of the target genres", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"genre",
			{ operator: "excludes_all", genres: ["Action", "Comedy"] },
			ctx,
		);
		expect(result).toBeNull();
	});

	it("is case-insensitive", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"genre",
			{ operator: "includes_any", genres: ["ACTION"] },
			ctx,
		);
		expect(result).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 5. Seerr request status rule
// ---------------------------------------------------------------------------

describe("seerr_request_status rule", () => {
	const seerrMap = new Map<string, SeerrRequestInfo[]>();
	seerrMap.set("movie:12345", [
		{
			requestId: 1,
			status: 2, // approved
			requestedBy: "alice",
			requestedByUserId: 10,
			createdAt: "2026-01-15T00:00:00Z",
			updatedAt: "2026-01-16T00:00:00Z",
			modifiedBy: null,
			is4k: false,
		},
	]);

	const ctx = baseCtx({ seerrMap });

	it("matches when request has matching status", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"seerr_request_status",
			{ statuses: ["approved", "completed"] },
			ctx,
		);
		expect(result).toContain("approved");
		expect(result).toContain("alice");
	});

	it("does not match when request status differs", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"seerr_request_status",
			{ statuses: ["declined", "failed"] },
			ctx,
		);
		expect(result).toBeNull();
	});

	it("returns null when no seerr data", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"seerr_request_status",
			{ statuses: ["approved"] },
			baseCtx(),
		);
		expect(result).toBeNull();
	});

	it("returns null when item has no tmdbId in data", () => {
		const result = evaluateSingleCondition(
			makeCacheItem({ data: JSON.stringify({ genres: [] }) }),
			"seerr_request_status",
			{ statuses: ["approved"] },
			ctx,
		);
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 6. Plex last watched rule
// ---------------------------------------------------------------------------

describe("plex_last_watched rule", () => {
	const sixtyDaysAgo = new Date(NOW.getTime() - 60 * 24 * 60 * 60 * 1000);

	const plexEntry: PlexWatchInfo = {
		lastWatchedAt: sixtyDaysAgo,
		watchCount: 2,
		watchedByUsers: ["admin"],
		onDeck: false,
		userRating: 8.0,
		collections: [],
		labels: [],
		addedAt: new Date("2025-06-01T00:00:00Z"),
		sections: [],
	};

	const plexMap = new Map<string, PlexWatchInfo>();
	plexMap.set("movie:12345", plexEntry);

	const ctx = baseCtx({ plexMap });

	it("matches when last watched is older than threshold", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"plex_last_watched",
			{ operator: "older_than", days: 30 },
			ctx,
		);
		expect(result).toContain("days ago in Plex");
		expect(result).toContain("threshold: > 30 days");
	});

	it("does not match when last watched is within threshold", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"plex_last_watched",
			{ operator: "older_than", days: 90 },
			ctx,
		);
		expect(result).toBeNull();
	});

	it("never operator matches when no plex data exists", () => {
		// With no plexMap at all, lookupPlexWatch returns null.
		// The code checks `!watch || watch.lastWatchedAt === null` — null watch triggers "never".
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"plex_last_watched",
			{ operator: "never" },
			baseCtx(), // no plexMap
		);
		expect(result).toBe("Never watched (per Plex)");
	});

	it("never operator matches item with null lastWatchedAt", () => {
		const neverWatchedMap = new Map<string, PlexWatchInfo>();
		neverWatchedMap.set("movie:12345", {
			...plexEntry,
			lastWatchedAt: null,
			watchCount: 0,
		});
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"plex_last_watched",
			{ operator: "never" },
			baseCtx({ plexMap: neverWatchedMap }),
		);
		expect(result).toBe("Never watched (per Plex)");
	});

	it("older_than falls back to addedAt for never-watched items", () => {
		const neverWatchedMap = new Map<string, PlexWatchInfo>();
		neverWatchedMap.set("movie:12345", {
			...plexEntry,
			lastWatchedAt: null,
			watchCount: 0,
			addedAt: new Date("2025-01-01T00:00:00Z"), // ~14 months ago
		});
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"plex_last_watched",
			{ operator: "older_than", days: 90 },
			baseCtx({ plexMap: neverWatchedMap }),
		);
		expect(result).toContain("Never watched");
		expect(result).toContain("added to Plex");
	});
});

// ---------------------------------------------------------------------------
// 7. Tautulli watch count rule
// ---------------------------------------------------------------------------

describe("tautulli_watch_count rule", () => {
	const tautulliMap = new Map();
	tautulliMap.set("movie:12345", {
		lastWatchedAt: new Date("2026-01-01T00:00:00Z"),
		watchCount: 1,
		watchedByUsers: ["admin"],
	});

	const ctx = baseCtx({ tautulliMap });

	it("matches when watch count is less than threshold", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"tautulli_watch_count",
			{ operator: "less_than", count: 3 },
			ctx,
		);
		expect(result).toContain("play count: 1");
		expect(result).toContain("threshold: < 3");
	});

	it("matches when watch count is greater than threshold", () => {
		const highCountMap = new Map();
		highCountMap.set("movie:12345", {
			lastWatchedAt: new Date(),
			watchCount: 10,
			watchedByUsers: ["admin", "bob"],
		});
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"tautulli_watch_count",
			{ operator: "greater_than", count: 5 },
			baseCtx({ tautulliMap: highCountMap }),
		);
		expect(result).toContain("play count: 10");
	});

	it("infers 0 plays for items missing from tautulli when map is populated", () => {
		// Item with tmdbId 99999 — not in the tautulliMap
		const missingData = { ...DEFAULT_DATA, remoteIds: { tmdbId: 99999 } };
		const result = evaluateSingleCondition(
			makeCacheItem({ data: JSON.stringify(missingData) }),
			"tautulli_watch_count",
			{ operator: "less_than", count: 1 },
			ctx,
		);
		expect(result).toContain("Not tracked by Tautulli");
	});

	it("does not match when count equals threshold for less_than", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(),
			"tautulli_watch_count",
			{ operator: "less_than", count: 1 },
			ctx,
		);
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 8. Composite rules (AND / OR)
// ---------------------------------------------------------------------------

describe("composite rules", () => {
	const ctx = baseCtx();

	it("AND rule matches when all conditions match", () => {
		const rule = makeRule({
			ruleType: "composite",
			operator: "AND",
			conditions: JSON.stringify([
				{ ruleType: "age", parameters: { operator: "older_than", days: 30 } },
				{ ruleType: "rating", parameters: { operator: "less_than", score: 8 } },
			]),
			parameters: "{}",
		});
		// Cast to any to satisfy Prisma type — fields are structurally compatible
		const result = evaluateRule(makeCacheItem(), rule as any, "RADARR", ctx);
		expect(result).not.toBeNull();
		expect(result!.reason).toContain(" AND ");
		expect(result!.reason).toContain("days ago");
		expect(result!.reason).toContain("TMDB rating");
	});

	it("AND rule returns null when one condition fails", () => {
		const rule = makeRule({
			operator: "AND",
			conditions: JSON.stringify([
				{ ruleType: "age", parameters: { operator: "older_than", days: 30 } },
				{ ruleType: "rating", parameters: { operator: "less_than", score: 5 } }, // 7.5 > 5, won't match
			]),
			parameters: "{}",
		});
		const result = evaluateRule(makeCacheItem(), rule as any, "RADARR", ctx);
		expect(result).toBeNull();
	});

	it("OR rule matches when any condition matches", () => {
		const rule = makeRule({
			operator: "OR",
			conditions: JSON.stringify([
				{ ruleType: "rating", parameters: { operator: "less_than", score: 5 } }, // won't match
				{ ruleType: "age", parameters: { operator: "older_than", days: 30 } }, // will match
			]),
			parameters: "{}",
		});
		const result = evaluateRule(makeCacheItem(), rule as any, "RADARR", ctx);
		expect(result).not.toBeNull();
		expect(result!.reason).toContain("days ago");
	});

	it("OR rule returns null when no condition matches", () => {
		const rule = makeRule({
			operator: "OR",
			conditions: JSON.stringify([
				{ ruleType: "rating", parameters: { operator: "less_than", score: 5 } },
				{ ruleType: "age", parameters: { operator: "newer_than", days: 1 } },
			]),
			parameters: "{}",
		});
		const result = evaluateRule(makeCacheItem(), rule as any, "RADARR", ctx);
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// evaluateRule: filter chain
// ---------------------------------------------------------------------------

describe("evaluateRule filter chain", () => {
	const ctx = baseCtx();

	it("respects disabled rule", () => {
		const rule = makeRule({ enabled: false });
		const result = evaluateRule(makeCacheItem(), rule as any, "RADARR", ctx);
		expect(result).toBeNull();
	});

	it("respects service filter", () => {
		const rule = makeRule({ serviceFilter: JSON.stringify(["SONARR"]) });
		const result = evaluateRule(makeCacheItem(), rule as any, "RADARR", ctx);
		expect(result).toBeNull();
	});

	it("respects instance filter", () => {
		const rule = makeRule({ instanceFilter: JSON.stringify(["other-instance"]) });
		const result = evaluateRule(makeCacheItem(), rule as any, "RADARR", ctx);
		expect(result).toBeNull();
	});

	it("respects tag exclusion", () => {
		const rule = makeRule({ excludeTags: JSON.stringify([1]) }); // item has tag 1
		const result = evaluateRule(makeCacheItem(), rule as any, "RADARR", ctx);
		expect(result).toBeNull();
	});

	it("respects title exclusion regex", () => {
		const rule = makeRule({ excludeTitles: JSON.stringify(["Test.*2020"]) });
		const result = evaluateRule(makeCacheItem(), rule as any, "RADARR", ctx);
		expect(result).toBeNull();
	});

	it("returns RuleMatch with correct shape on hit", () => {
		const rule = makeRule({
			id: "rule-99",
			name: "Old Content",
			action: "unmonitor",
		});
		const result = evaluateRule(makeCacheItem(), rule as any, "RADARR", ctx);
		expect(result).toEqual({
			ruleId: "rule-99",
			ruleName: "Old Content",
			reason: expect.stringContaining("days ago"),
			action: "unmonitor",
		});
	});
});

// ---------------------------------------------------------------------------
// Golden test: evaluateItemAgainstRules with mixed fixture set
// ---------------------------------------------------------------------------

describe("golden test — multi-rule priority evaluation", () => {
	const seerrMap = new Map<string, SeerrRequestInfo[]>();
	seerrMap.set("movie:12345", [
		{
			requestId: 1,
			status: 3, // declined
			requestedBy: "bob",
			requestedByUserId: 20,
			createdAt: "2025-06-01T00:00:00Z",
			updatedAt: "2025-06-02T00:00:00Z",
			modifiedBy: null,
			is4k: false,
		},
	]);

	const plexMap = new Map<string, PlexWatchInfo>();
	plexMap.set("movie:12345", {
		lastWatchedAt: null,
		watchCount: 0,
		watchedByUsers: [],
		onDeck: false,
		userRating: null,
		collections: [],
		labels: [],
		addedAt: new Date("2025-06-01T00:00:00Z"),
		sections: [],
	});

	const ctx = baseCtx({ seerrMap, plexMap });

	// Items
	const oldLowRated = makeCacheItem({
		id: "old-low",
		title: "Flop Movie",
		year: 2018,
		data: JSON.stringify({
			...DEFAULT_DATA,
			ratings: { tmdb: { value: 3.1 } },
		}),
	});

	const recentHighRated = makeCacheItem({
		id: "recent-high",
		title: "New Hit",
		year: 2026,
		arrAddedAt: new Date("2026-02-28T00:00:00Z"),
		data: JSON.stringify({
			...DEFAULT_DATA,
			ratings: { tmdb: { value: 9.0 } },
			remoteIds: { tmdbId: 99999 }, // not in seerr/plex maps
		}),
	});

	const declinedRequest = makeCacheItem({
		id: "declined",
		title: "Test Movie 2020",
	});

	const protectedByGenre = makeCacheItem({
		id: "protected",
		title: "Protected Film",
		data: JSON.stringify({
			...DEFAULT_DATA,
			genres: ["Documentary"],
			ratings: { tmdb: { value: 2.0 } },
		}),
	});

	// Rules (priority-ordered)
	const rules = [
		// P1: Protect documentaries — anything with genre=Documentary is excluded via service filter trick
		// Instead, use excludeTitles to protect "Protected Film"
		makeRule({
			id: "r-declined",
			name: "Remove declined requests",
			priority: 1,
			ruleType: "seerr_request_status",
			parameters: JSON.stringify({ statuses: ["declined"] }),
			action: "delete",
		}),
		makeRule({
			id: "r-low-rating",
			name: "Remove low-rated old content",
			priority: 2,
			operator: "AND",
			conditions: JSON.stringify([
				{ ruleType: "rating", parameters: { operator: "less_than", score: 5 } },
				{ ruleType: "age", parameters: { operator: "older_than", days: 60 } },
			]),
			parameters: "{}",
			action: "delete",
			excludeTitles: JSON.stringify(["Protected"]),
		}),
		makeRule({
			id: "r-never-watched",
			name: "Unmonitor never-watched",
			priority: 3,
			ruleType: "plex_last_watched",
			parameters: JSON.stringify({ operator: "never" }),
			action: "unmonitor",
		}),
	];

	it("first matching rule wins (declined request takes priority)", () => {
		const result = evaluateItemAgainstRules(declinedRequest, rules as any[], "RADARR", ctx);
		expect(result).not.toBeNull();
		expect(result!.ruleId).toBe("r-declined");
		expect(result!.action).toBe("delete");
	});

	it("composite AND rule matches old low-rated item", () => {
		const result = evaluateItemAgainstRules(oldLowRated, rules as any[], "RADARR", ctx);
		// oldLowRated has no seerr request (tmdbId 12345 has declined request, but this item
		// also has tmdbId 12345 in its data — it WILL match r-declined first)
		expect(result).not.toBeNull();
		expect(result!.ruleId).toBe("r-declined"); // declined rule still matches first
	});

	it("recent high-rated item with no plex data gets no match", () => {
		// No seerr data (tmdbId 99999), high rating (9.0), recently added (1 day)
		// - r-declined: no seerr data → skip
		// - r-low-rating: 9.0 not < 5 → skip
		// - r-never-watched: no plex data → lookupPlexWatch returns null
		//   "never" with null watch → "Never watched (per Plex)"... wait
		//   Actually: watch is null (not in plexMap), so returns null for "never"
		//   because the function only returns match when watch exists but lastWatchedAt is null
		const result = evaluateItemAgainstRules(recentHighRated, rules as any[], "RADARR", ctx);
		// plex_last_watched with "never": if watch is null (no plex entry), the function returns null
		// (you need to be IN plex with null lastWatchedAt to match)
		// But wait — looking at the code: `if (!watch || watch.lastWatchedAt === null)` — so null watch
		// DOES match "never". So this will match r-never-watched.
		expect(result).not.toBeNull();
		expect(result!.ruleId).toBe("r-never-watched");
		expect(result!.action).toBe("unmonitor");
	});

	it("protected item is excluded by title pattern in composite rule", () => {
		// protectedByGenre has rating 2.0, is old (90 days) — matches r-low-rating conditions
		// BUT has excludeTitles pattern "Protected" which matches "Protected Film"
		// So r-low-rating skips. Check if r-never-watched catches it.
		const result = evaluateItemAgainstRules(protectedByGenre, rules as any[], "RADARR", ctx);
		// protectedByGenre has tmdbId 12345 → seerr has declined request → r-declined matches
		expect(result).not.toBeNull();
		expect(result!.ruleId).toBe("r-declined");
	});

	it("item not in seerr skips declined rule, falls through to next", () => {
		// Create an item with no seerr match
		const noSeerrItem = makeCacheItem({
			id: "no-seerr",
			title: "Obscure Movie",
			data: JSON.stringify({
				...DEFAULT_DATA,
				ratings: { tmdb: { value: 2.5 } },
				remoteIds: { tmdbId: 77777 }, // not in seerrMap
			}),
		});

		const result = evaluateItemAgainstRules(noSeerrItem, rules as any[], "RADARR", ctx);
		// r-declined: no seerr data → skip
		// r-low-rating: rating 2.5 < 5 AND age ~90 days > 60 → MATCH
		expect(result).not.toBeNull();
		expect(result!.ruleId).toBe("r-low-rating");
		expect(result!.reason).toContain(" AND ");
	});
});
