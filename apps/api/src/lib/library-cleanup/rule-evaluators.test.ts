/**
 * Library Cleanup Rule Evaluator Tests
 *
 * Safety-net tests for the rule evaluation pipeline.
 * Covers 8 high-risk rule types + composite AND/OR + a golden multi-rule test.
 *
 * Run with: npx vitest run rule-evaluators.test.ts
 */

import { describe, expect, it } from "vitest";
import type { LibraryCleanupRule } from "../prisma.js";
import {
	evaluateItemAgainstRules,
	evaluateItemPolicyState,
	evaluateRule,
	evaluateRuleState,
	evaluateSingleCondition,
	evaluateSingleConditionState,
	extractRating,
} from "./rule-evaluators.js";
import {
	listMembershipKey,
	type CacheItemForEval,
	type EvalContext,
	type PlexWatchInfo,
	type SeerrRequestInfo,
} from "./types.js";

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
	scanMediaServerAfterDelete: boolean;
	createdAt: Date;
	updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

const NOW = new Date("2026-03-01T12:00:00Z");

/** Rich default data blob used by rating, genre, seerr/plex/tautulli lookups. */
const DEFAULT_DATA = {
	service: "radarr",
	_arrDashboardEvidence: {
		monitored: true,
		hasFile: true,
		sizeOnDisk: true,
		rating: true,
		imdbRating: true,
	},
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
		scanMediaServerAfterDelete: false,
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

describe("monitoring evidence", () => {
	it.each(["RADARR", "SONARR"])(
		"matches explicit monitored and unmonitored states for %s",
		(service) => {
			for (const monitored of [true, false]) {
				const item = makeCacheItem({
					monitored,
					itemType: service === "RADARR" ? "movie" : "series",
					data: JSON.stringify({
						service: service.toLowerCase(),
						monitored,
						_arrDashboardEvidence: { monitored: true },
					}),
				});
				expect(
					evaluateSingleConditionState(item, monitored ? "monitored" : "unmonitored", {}, baseCtx())
						.state,
				).toBe("true");
			}
		},
	);

	it("keeps missing monitoring evidence UNKNOWN through nested NOT", () => {
		const item = makeCacheItem({
			monitored: true,
			data: JSON.stringify({
				service: "radarr",
				_arrDashboardEvidence: { monitored: false },
			}),
		});
		const rule = makeRule({
			ruleType: "composite",
			parameters: "{}",
			conditions: JSON.stringify({
				version: 1,
				root: {
					type: "not",
					child: { type: "condition", ruleType: "monitored", parameters: {} },
				},
			}),
		});
		expect(evaluateRuleState(item, rule as LibraryCleanupRule, "RADARR", baseCtx())).toMatchObject({
			state: "unknown",
			match: null,
		});
	});

	it("evaluates NOT(monitored) only with explicit evidence", () => {
		const item = makeCacheItem({
			monitored: false,
			data: JSON.stringify({
				service: "sonarr",
				monitored: false,
				_arrDashboardEvidence: { monitored: true },
			}),
		});
		const rule = makeRule({
			ruleType: "composite",
			parameters: "{}",
			conditions: JSON.stringify({
				version: 1,
				root: {
					type: "not",
					child: { type: "condition", ruleType: "monitored", parameters: {} },
				},
			}),
		});
		expect(evaluateRuleState(item, rule as LibraryCleanupRule, "SONARR", baseCtx()).state).toBe(
			"true",
		);
	});
});

// ---------------------------------------------------------------------------
// 3. Rating rule (available *arr rating from data blob)
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

	it("extractRating handles Sonarr's flat rating format", () => {
		const item = makeCacheItem({
			data: JSON.stringify({ service: "sonarr", ratings: { value: 7.4, votes: 142958 } }),
		});
		expect(extractRating(item)).toBe(7.4);
	});

	it("extractRating prefers Radarr's TMDB rating over a flat rating", () => {
		const item = makeCacheItem({
			data: JSON.stringify({
				service: "radarr",
				ratings: {
					value: 7.4,
					tmdb: { value: 8.2 },
				},
			}),
		});
		expect(extractRating(item)).toBe(8.2);
	});

	it("matches a Radarr item with a rating below the threshold", () => {
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

	it("matches a Sonarr item with a flat rating below the threshold", () => {
		const item = makeCacheItem({
			data: JSON.stringify({ service: "sonarr", ratings: { value: 4.5, votes: 10000 } }),
		});
		const result = evaluateSingleCondition(
			item,
			"rating",
			{ operator: "less_than", score: 5 },
			ctx,
		);
		expect(result).toContain("Sonarr rating: 4.5");
	});

	it("does not treat Sonarr's source-less flat rating as an IMDb rating", () => {
		const item = makeCacheItem({
			data: JSON.stringify({ service: "sonarr", ratings: { value: 6.8, votes: 50000 } }),
		});
		const result = evaluateSingleCondition(
			item,
			"imdb_rating",
			{ operator: "less_than", score: 7 },
			ctx,
		);
		expect(result).toBeNull();
	});

	it("matches unrated items", () => {
		const item = makeCacheItem({ data: JSON.stringify({ genres: ["Drama"] }) });
		const result = evaluateSingleCondition(item, "rating", { operator: "unrated" }, ctx);
		expect(result).toBe("No rating");
	});

	it("does not flag rated item as unrated", () => {
		const result = evaluateSingleCondition(makeCacheItem(), "rating", { operator: "unrated" }, ctx);
		expect(result).toBeNull();
	});

	it("uses only Radarr TMDb and Sonarr's flat rating", () => {
		const radarrOtherSources = makeCacheItem({
			data: JSON.stringify({
				service: "radarr",
				ratings: { imdb: { value: 8 }, metacritic: { value: 9 } },
				_arrDashboardEvidence: { rating: true },
			}),
		});
		expect(extractRating(radarrOtherSources)).toBeNull();
		expect(
			evaluateSingleConditionState(
				radarrOtherSources,
				"rating",
				{ source: "tmdb", operator: "unrated" },
				ctx,
			),
		).toMatchObject({ state: "true" });

		const sonarr = makeCacheItem({
			itemType: "series",
			data: JSON.stringify({
				service: "sonarr",
				ratings: { value: 6.8 },
				_arrDashboardEvidence: { rating: true, imdbRating: false },
			}),
		});
		expect(extractRating(sonarr)).toBe(6.8);
		expect(
			evaluateSingleConditionState(sonarr, "imdb_rating", { operator: "unrated" }, ctx).state,
		).toBe("unknown");
	});

	it("treats zero as unrated and malformed or out-of-range ratings as UNKNOWN", () => {
		const zero = makeCacheItem({
			data: JSON.stringify({
				service: "radarr",
				ratings: { tmdb: { value: 0 }, imdb: { value: 0 } },
				_arrDashboardEvidence: { rating: true, imdbRating: true },
			}),
		});
		expect(
			evaluateSingleConditionState(zero, "rating", { source: "tmdb", operator: "unrated" }, ctx)
				.state,
		).toBe("true");
		expect(
			evaluateSingleConditionState(zero, "imdb_rating", { operator: "unrated" }, ctx).state,
		).toBe("true");

		for (const ratings of [
			{ tmdb: { value: Number.NaN }, imdb: { value: 11 } },
			{ tmdb: { value: -1 }, imdb: { value: "bad" } },
		]) {
			const malformed = makeCacheItem({
				data: JSON.stringify({
					service: "radarr",
					ratings,
					_arrDashboardEvidence: { rating: false, imdbRating: false },
				}),
			});
			expect(
				evaluateSingleConditionState(
					malformed,
					"rating",
					{ source: "tmdb", operator: "unrated" },
					ctx,
				).state,
			).toBe("unknown");
			expect(
				evaluateSingleConditionState(malformed, "imdb_rating", { operator: "unrated" }, ctx).state,
			).toBe("unknown");
		}
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

describe("qualified provider negatives", () => {
	it("does not let an unresolved Plex section selector certify known zero", () => {
		const rule = makeRule({
			ruleType: "plex_on_deck",
			parameters: JSON.stringify({ isDeck: false }),
			plexLibraryFilter: JSON.stringify(["Missing 4K"]),
		});
		const ctx = baseCtx({
			plexMap: new Map([
				[
					"movie:12345",
					{
						lastWatchedAt: null,
						watchCount: 0,
						watchedByUsers: [],
						onDeck: false,
						userRating: null,
						collections: [],
						labels: [],
						addedAt: NOW,
						sections: [],
					},
				],
			]),
			plexSectionTitles: new Set(["Movies"]),
		});

		expect(
			evaluateRuleState(makeCacheItem(), rule as LibraryCleanupRule, "RADARR", ctx).state,
		).toBe("unknown");
		expect(
			evaluateItemPolicyState(
				makeCacheItem(),
				[{ ...rule, retentionMode: true } as LibraryCleanupRule],
				"RADARR",
				ctx,
			),
		).toMatchObject({ kind: "retained", evidence: "unknown" });
	});

	it("certifies zero only after every configured Plex selector resolves", () => {
		const rule = makeRule({
			ruleType: "plex_on_deck",
			parameters: JSON.stringify({ isDeck: false }),
			plexLibraryFilter: JSON.stringify(["Movies", "Movies 4K"]),
		});
		const ctx = baseCtx({
			plexMap: new Map(),
			plexSectionTitles: new Set(["Movies", "Movies 4K"]),
		});

		expect(
			evaluateRuleState(makeCacheItem(), rule as LibraryCleanupRule, "RADARR", ctx).state,
		).toBe("true");
	});

	it.each(["tmdb", "trakt"] as const)(
		"keeps same-number movie and series membership distinct for %s lists",
		(source) => {
			const memberships = new Map([["list", new Set([listMembershipKey("movie", 12345)])]]);
			const ruleType = source === "tmdb" ? "tmdb_list_member" : "trakt_list_member";
			const identifier = source === "tmdb" ? { listId: "list" } : { listSlug: "list" };
			const ctx = baseCtx(
				source === "tmdb"
					? { tmdbListMemberships: memberships }
					: { traktListMemberships: memberships },
			);

			expect(
				evaluateSingleCondition(
					makeCacheItem({ itemType: "movie" }),
					ruleType,
					{ ...identifier, operator: "is_in" },
					ctx,
				),
			).not.toBeNull();
			expect(
				evaluateSingleCondition(
					makeCacheItem({ itemType: "series" }),
					ruleType,
					{ ...identifier, operator: "is_in" },
					ctx,
				),
			).toBeNull();
		},
	);
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
		expect(result).toContain("Tautulli play count: 0");
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

	it("treats explicit empty collections as evidence for inverse predicates", () => {
		const emptyCollectionsItem = makeCacheItem({
			data: JSON.stringify({
				...DEFAULT_DATA,
				genres: [],
				originalLanguage: null,
				languages: [],
			}),
		});
		expect(
			evaluateSingleCondition(
				emptyCollectionsItem,
				"genre",
				{ operator: "excludes_all", genres: ["Drama"] },
				ctx,
			),
		).not.toBeNull();
		expect(
			evaluateSingleCondition(
				emptyCollectionsItem,
				"language",
				{ operator: "excludes_all", languages: ["English"] },
				ctx,
			),
		).not.toBeNull();
		expect(
			evaluateSingleCondition(
				emptyCollectionsItem,
				"tautulli_watched_by",
				{ operator: "excludes_all", userNames: ["alice"] },
				baseCtx({
					tautulliMap: new Map([
						["movie:12345", { lastWatchedAt: null, watchCount: 0, watchedByUsers: [] }],
					]),
				}),
			),
		).not.toBeNull();
	});

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
		const result = evaluateRule(makeCacheItem(), rule as LibraryCleanupRule, "RADARR", ctx);
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
		const result = evaluateRule(makeCacheItem(), rule as LibraryCleanupRule, "RADARR", ctx);
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
		const result = evaluateRule(makeCacheItem(), rule as LibraryCleanupRule, "RADARR", ctx);
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
		const result = evaluateRule(makeCacheItem(), rule as LibraryCleanupRule, "RADARR", ctx);
		expect(result).toBeNull();
	});

	it("evaluates nested AND/OR groups with explicit NOT", () => {
		const rule = makeRule({
			ruleType: "composite",
			operator: null,
			conditions: JSON.stringify({
				version: 1,
				root: {
					type: "group",
					operator: "OR",
					children: [
						{
							type: "group",
							operator: "AND",
							children: [
								{
									type: "condition",
									ruleType: "age",
									parameters: { operator: "older_than", days: 30 },
								},
								{
									type: "not",
									child: {
										type: "condition",
										ruleType: "rating",
										parameters: { operator: "less_than", score: 5 },
									},
								},
							],
						},
						{
							type: "condition",
							ruleType: "size",
							parameters: { operator: "greater_than", sizeGb: 10 },
						},
					],
				},
			}),
			parameters: "{}",
		});
		expect(evaluateRule(makeCacheItem(), rule as LibraryCleanupRule, "RADARR", ctx)).not.toBeNull();
	});

	it("preserves unknown provider evidence through NOT", () => {
		const rule = makeRule({
			ruleType: "composite",
			operator: null,
			conditions: JSON.stringify({
				version: 1,
				root: {
					type: "not",
					child: {
						type: "condition",
						ruleType: "plex_on_deck",
						parameters: { isDeck: true },
					},
				},
			}),
			parameters: "{}",
		});
		const result = evaluateRuleState(
			makeCacheItem(),
			rule as LibraryCleanupRule,
			"RADARR",
			baseCtx(),
		);
		expect(result.state).toBe("unknown");
		expect(result.match).toBeNull();
	});

	it.each([
		{ operator: "equals", count: 0 },
		{ operator: "less_than", count: 1 },
	] as const)(
		"treats an empty successful Seerr inventory as zero requests for $operator $count",
		({ operator, count }) => {
			const rule = makeRule({
				ruleType: "composite",
				operator: null,
				conditions: JSON.stringify({
					version: 1,
					root: {
						type: "condition",
						ruleType: "seerr_request_count",
						parameters: { operator, count },
					},
				}),
				parameters: "{}",
			});
			expect(
				evaluateRuleState(
					makeCacheItem(),
					rule as LibraryCleanupRule,
					"RADARR",
					baseCtx({ seerrMap: new Map() }),
				).state,
			).toBe("true");
		},
	);

	it("does not invert a true zero-request count into a destructive NOT match", () => {
		const rule = makeRule({
			ruleType: "composite",
			operator: null,
			conditions: JSON.stringify({
				version: 1,
				root: {
					type: "not",
					child: {
						type: "condition",
						ruleType: "seerr_request_count",
						parameters: { operator: "equals", count: 0 },
					},
				},
			}),
			parameters: "{}",
		});
		expect(
			evaluateRuleState(
				makeCacheItem(),
				rule as LibraryCleanupRule,
				"RADARR",
				baseCtx({ seerrMap: new Map() }),
			).state,
		).toBe("false");
	});

	it("treats positive Seerr predicates as known false for a complete empty inventory", () => {
		const rule = makeRule({
			ruleType: "composite",
			operator: null,
			conditions: JSON.stringify({
				version: 1,
				root: {
					type: "not",
					child: {
						type: "condition",
						ruleType: "seerr_requested_by",
						parameters: { userNames: ["alice"] },
					},
				},
			}),
			parameters: "{}",
		});
		expect(
			evaluateRuleState(
				makeCacheItem(),
				rule as LibraryCleanupRule,
				"RADARR",
				baseCtx({ seerrMap: new Map() }),
			).state,
		).toBe("true");
	});

	it.each([
		{ name: "unavailable inventory", item: makeCacheItem(), ctx: baseCtx() },
		{
			name: "missing item identity",
			item: makeCacheItem({ data: JSON.stringify({ ...DEFAULT_DATA, remoteIds: {} }) }),
			ctx: baseCtx({ seerrMap: new Map() }),
		},
	])("keeps Seerr request count UNKNOWN under NOT for $name", ({ item, ctx }) => {
		const rule = makeRule({
			ruleType: "composite",
			operator: null,
			conditions: JSON.stringify({
				version: 1,
				root: {
					type: "not",
					child: {
						type: "condition",
						ruleType: "seerr_request_count",
						parameters: { operator: "equals", count: 0 },
					},
				},
			}),
			parameters: "{}",
		});
		expect(evaluateRuleState(item, rule as LibraryCleanupRule, "RADARR", ctx).state).toBe(
			"unknown",
		);
	});

	it.each([
		{
			name: "missing ARR added date",
			expected: "unknown",
			ruleType: "age",
			parameters: { operator: "older_than", days: 30 },
			item: makeCacheItem({ arrAddedAt: null }),
			ctx: baseCtx(),
		},
		{
			name: "Plex condition without TMDb identity",
			expected: "unknown",
			ruleType: "plex_on_deck",
			parameters: { isDeck: true },
			item: makeCacheItem({ data: JSON.stringify({ ...DEFAULT_DATA, remoteIds: {} }) }),
			ctx: baseCtx({ plexMap: new Map() }),
		},
		{
			name: "Plex condition without a per-item row",
			expected: "true",
			ruleType: "plex_on_deck",
			parameters: { isDeck: true },
			item: makeCacheItem(),
			ctx: baseCtx({ plexMap: new Map() }),
		},
		{
			name: "Plex episode condition in the movie domain",
			expected: "unknown",
			ruleType: "plex_episode_completion",
			parameters: { operator: "greater_than", percentage: 50 },
			item: makeCacheItem({ itemType: "movie" }),
			ctx: baseCtx({
				plexEpisodeMap: new Map([[12345, { total: 10, watched: 8, seasons: new Map() }]]),
			}),
		},
		{
			name: "Jellyfin episode condition without a per-series row",
			expected: "unknown",
			ruleType: "jellyfin_episode_completion",
			parameters: { operator: "greater_than", percentage: 50 },
			item: makeCacheItem({ itemType: "series" }),
			ctx: baseCtx({ jellyfinEpisodeMap: new Map() }),
		},
		{
			name: "list condition without the requested list cache row",
			expected: "unknown",
			ruleType: "tmdb_list_member",
			parameters: { operator: "is_in", listId: "42" },
			item: makeCacheItem(),
			ctx: baseCtx({ tmdbListMemberships: new Map() }),
		},
	])(
		"applies complete-inventory absence semantics under NOT for $name",
		({ ruleType, parameters, item, ctx, expected }) => {
			const rule = makeRule({
				ruleType: "composite",
				operator: null,
				conditions: JSON.stringify({
					version: 1,
					root: {
						type: "not",
						child: { type: "condition", ruleType, parameters },
					},
				}),
				parameters: "{}",
			});
			expect(evaluateRuleState(item, rule as LibraryCleanupRule, "RADARR", ctx).state).toBe(
				expected,
			);
		},
	);

	it.each([
		{
			name: "a known-false local condition",
			ruleType: "age",
			parameters: { operator: "older_than", days: 365 },
			item: makeCacheItem(),
			ctx: baseCtx(),
		},
		{
			name: "a known-false provider condition",
			ruleType: "plex_on_deck",
			parameters: { isDeck: true },
			item: makeCacheItem(),
			ctx: baseCtx({
				plexMap: new Map([
					[
						"movie:12345",
						{
							lastWatchedAt: null,
							watchCount: 0,
							watchedByUsers: [],
							onDeck: false,
							userRating: null,
							collections: [],
							labels: [],
							addedAt: NOW,
							sections: [],
						},
					],
				]),
			}),
		},
	])("lets NOT invert $name", ({ ruleType, parameters, item, ctx }) => {
		const rule = makeRule({
			ruleType: "composite",
			operator: null,
			conditions: JSON.stringify({
				version: 1,
				root: {
					type: "not",
					child: { type: "condition", ruleType, parameters },
				},
			}),
			parameters: "{}",
		});
		expect(evaluateRuleState(item, rule as LibraryCleanupRule, "RADARR", ctx).state).toBe("true");
	});

	it.each([
		{
			ruleType: "plex_episode_completion",
			parameters: { operator: "greater_than", percent: 50 },
			ctx: baseCtx({ plexMap: new Map() }),
		},
		{
			ruleType: "jellyfin_episode_completion",
			parameters: { operator: "greater_than", percent: 50 },
			ctx: baseCtx({ jellyfinMap: new Map() }),
		},
	])("uses the episode evidence map for NOT $ruleType", ({ ruleType, parameters, ctx }) => {
		const rule = makeRule({
			ruleType: "composite",
			operator: null,
			conditions: JSON.stringify({
				version: 1,
				root: {
					type: "not",
					child: { type: "condition", ruleType, parameters },
				},
			}),
			parameters: "{}",
		});
		expect(
			evaluateRuleState(makeCacheItem(), rule as LibraryCleanupRule, "SONARR", ctx).state,
		).toBe("unknown");
	});

	it("preserves legacy boolean short-circuit behavior without provider health metadata", () => {
		const condition = {
			type: "condition",
			ruleType: "plex_on_deck",
			parameters: { isDeck: true },
		};
		const makeExpressionRule = (operator: "AND" | "OR", localMatches: boolean) =>
			makeRule({
				ruleType: "composite",
				operator: null,
				conditions: JSON.stringify({
					version: 1,
					root: {
						type: "group",
						operator,
						children: [
							{
								type: "condition",
								ruleType: "age",
								parameters: {
									operator: "older_than",
									days: localMatches ? 30 : 365,
								},
							},
							condition,
						],
					},
				}),
				parameters: "{}",
			});
		expect(
			evaluateRuleState(
				makeCacheItem(),
				makeExpressionRule("OR", true) as LibraryCleanupRule,
				"RADARR",
				baseCtx(),
			).state,
		).toBe("true");
		expect(
			evaluateRuleState(
				makeCacheItem(),
				makeExpressionRule("AND", false) as LibraryCleanupRule,
				"RADARR",
				baseCtx(),
			).state,
		).toBe("false");
	});

	it.each([
		{ operator: "OR" as const, monitored: false, expected: "true" },
		{ operator: "AND" as const, monitored: true, expected: "false" },
		{ operator: "OR" as const, monitored: true, expected: "unknown" },
		{ operator: "AND" as const, monitored: false, expected: "unknown" },
	])(
		"evaluates $operator with unmonitored=$monitored and unavailable provider evidence as $expected",
		({ operator, monitored, expected }) => {
			const rule = makeRule({
				ruleType: "composite",
				operator: null,
				conditions: JSON.stringify({
					version: 1,
					root: {
						type: "group",
						operator,
						children: [
							{
								type: "condition",
								ruleType: "unmonitored",
								parameters: {},
							},
							{
								type: "not",
								child: {
									type: "condition",
									ruleType: "plex_on_deck",
									parameters: { isDeck: true },
								},
							},
						],
					},
				}),
				parameters: "{}",
			});
			expect(
				evaluateRuleState(
					makeCacheItem({ monitored }),
					rule as LibraryCleanupRule,
					"RADARR",
					baseCtx(),
				).state,
			).toBe(expected);
		},
	);

	it("keeps legacy flat rules behaviorally equivalent to their normalized expression", () => {
		const legacyConditions = [
			{ ruleType: "age", parameters: { operator: "older_than", days: 30 } },
			{ ruleType: "rating", parameters: { operator: "less_than", score: 8 } },
		];
		const legacy = makeRule({
			ruleType: "composite",
			operator: "AND",
			conditions: JSON.stringify(legacyConditions),
			parameters: "{}",
		});
		const recursive = makeRule({
			ruleType: "composite",
			operator: null,
			conditions: JSON.stringify({
				version: 1,
				root: {
					type: "group",
					operator: "AND",
					children: legacyConditions.map((condition) => ({
						type: "condition",
						...condition,
					})),
				},
			}),
			parameters: "{}",
		});
		expect(evaluateRule(makeCacheItem(), legacy as LibraryCleanupRule, "RADARR", ctx)).toEqual(
			evaluateRule(makeCacheItem(), recursive as LibraryCleanupRule, "RADARR", ctx),
		);
	});

	it("fails closed when stored legacy and recursive semantics conflict", () => {
		const rule = makeRule({
			ruleType: "composite",
			operator: "AND",
			conditions: JSON.stringify({
				version: 1,
				root: {
					type: "condition",
					ruleType: "age",
					parameters: { operator: "older_than", days: 30 },
				},
			}),
			parameters: "{}",
		});
		expect(
			evaluateRuleState(makeCacheItem(), rule as LibraryCleanupRule, "RADARR", ctx).state,
		).toBe("unknown");
	});

	it("fails closed when a persisted legacy composite exceeds the total node limit", () => {
		const rule = makeRule({
			ruleType: "composite",
			operator: "AND",
			conditions: JSON.stringify(
				Array.from({ length: 100 }, () => ({
					ruleType: "age",
					parameters: { operator: "older_than", days: 30 },
				})),
			),
			parameters: "{}",
		});
		expect(
			evaluateRuleState(makeCacheItem(), rule as LibraryCleanupRule, "RADARR", ctx).state,
		).toBe("unknown");
	});
});

describe("unknown evidence safety", () => {
	const unavailableNotRule = (retentionMode: boolean) =>
		makeRule({
			id: retentionMode ? "retention" : "cleanup-unknown",
			ruleType: "composite",
			operator: null,
			retentionMode,
			conditions: JSON.stringify({
				version: 1,
				root: {
					type: "not",
					child: {
						type: "condition",
						ruleType: "plex_on_deck",
						parameters: { isDeck: true },
					},
				},
			}),
			parameters: "{}",
		}) as LibraryCleanupRule;
	const fallback = makeRule({ id: "fallback", priority: 2 }) as LibraryCleanupRule;

	it("skips an unknown cleanup expression and evaluates later rules", () => {
		const match = evaluateItemAgainstRules(
			makeCacheItem(),
			[unavailableNotRule(false), fallback],
			"RADARR",
			baseCtx(),
		);
		expect(match?.ruleId).toBe("fallback");
	});

	it("lets an unknown retention expression protect the item", () => {
		expect(
			evaluateItemAgainstRules(
				makeCacheItem(),
				[unavailableNotRule(true), fallback],
				"RADARR",
				baseCtx(),
			),
		).toBeNull();
	});

	it.each(["RADARR", "SONARR"])(
		"treats missing live ARR fields as unknown for %s cleanup and retention rules",
		(service) => {
			const item = makeCacheItem({
				monitored: false,
				hasFile: false,
				sizeOnDisk: BigInt(0),
				data: JSON.stringify({ remoteIds: { tmdbId: 12345 } }),
			});
			for (const ruleType of ["unmonitored", "no_file", "size"]) {
				const parameters = ruleType === "size" ? { operator: "less_than", gigabytes: 1 } : {};
				const cleanup = makeRule({ ruleType, parameters: JSON.stringify(parameters) });
				const retention = makeRule({
					id: `${ruleType}-retention`,
					ruleType,
					parameters: JSON.stringify(parameters),
					retentionMode: true,
				});

				expect(
					evaluateRuleState(item, cleanup as LibraryCleanupRule, service, baseCtx()).state,
				).toBe("unknown");
				expect(
					evaluateItemAgainstRules(
						item,
						[retention as LibraryCleanupRule, fallback],
						service,
						baseCtx(),
					),
				).toBeNull();
			}
		},
	);

	it("fails staleness scoring closed when the live ARR rating it weights is unavailable", () => {
		const item = makeCacheItem({
			data: JSON.stringify({
				service: "radarr",
				_arrDashboardEvidence: { rating: false },
				remoteIds: { tmdbId: 12345 },
			}),
		});
		const plexMap = new Map([
			[
				"movie:12345",
				{
					watchCount: 0,
					lastWatchedAt: null,
					addedAt: null,
					onDeck: false,
					userRating: null,
					collections: [],
					labels: [],
					watchedByUsers: [],
					sections: [],
				},
			],
		]);
		const ctx = baseCtx({ plexMap });
		const cleanup = makeRule({
			id: "stale-without-rating",
			ruleType: "staleness_score",
			parameters: JSON.stringify({ operator: "greater_than", threshold: 1 }),
		});

		expect(evaluateRuleState(item, cleanup as LibraryCleanupRule, "RADARR", ctx).state).toBe(
			"unknown",
		);
		expect(
			evaluateItemAgainstRules(item, [cleanup as LibraryCleanupRule, fallback], "RADARR", ctx)
				?.ruleId,
		).toBe("fallback");

		const withoutRatingWeight = makeRule({
			...cleanup,
			id: "stale-without-rating-weight",
			parameters: JSON.stringify({
				operator: "greater_than",
				threshold: 1,
				weights: {
					daysSinceLastWatch: 1,
					inverseWatchCount: 0,
					notOnDeck: 0,
					lowUserRating: 0,
					lowTmdbRating: 0,
					sizeOnDisk: 0,
				},
			}),
		});
		expect(
			evaluateRuleState(item, withoutRatingWeight as LibraryCleanupRule, "RADARR", ctx).state,
		).toBe("true");
	});
});

// ---------------------------------------------------------------------------
// evaluateRule: filter chain
// ---------------------------------------------------------------------------

describe("evaluateRule filter chain", () => {
	const ctx = baseCtx();

	it("respects disabled rule", () => {
		const rule = makeRule({ enabled: false });
		const result = evaluateRule(makeCacheItem(), rule as LibraryCleanupRule, "RADARR", ctx);
		expect(result).toBeNull();
	});

	it("respects service filter", () => {
		const rule = makeRule({ serviceFilter: JSON.stringify(["SONARR"]) });
		const result = evaluateRule(makeCacheItem(), rule as LibraryCleanupRule, "RADARR", ctx);
		expect(result).toBeNull();
	});

	it("respects instance filter", () => {
		const rule = makeRule({ instanceFilter: JSON.stringify(["other-instance"]) });
		const result = evaluateRule(makeCacheItem(), rule as LibraryCleanupRule, "RADARR", ctx);
		expect(result).toBeNull();
	});

	it("respects tag exclusion", () => {
		const rule = makeRule({ excludeTags: JSON.stringify([1]) }); // item has tag 1
		const result = evaluateRule(makeCacheItem(), rule as LibraryCleanupRule, "RADARR", ctx);
		expect(result).toBeNull();
	});

	it("respects title exclusion regex", () => {
		const rule = makeRule({ excludeTitles: JSON.stringify(["Test.*2020"]) });
		const result = evaluateRule(makeCacheItem(), rule as LibraryCleanupRule, "RADARR", ctx);
		expect(result).toBeNull();
	});

	it("returns RuleMatch with correct shape on hit", () => {
		const rule = makeRule({
			id: "rule-99",
			name: "Old Content",
			action: "unmonitor",
			scanMediaServerAfterDelete: false,
		});
		const result = evaluateRule(makeCacheItem(), rule as LibraryCleanupRule, "RADARR", ctx);
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
		const result = evaluateItemAgainstRules(
			declinedRequest,
			rules as LibraryCleanupRule[],
			"RADARR",
			ctx,
		);
		expect(result).not.toBeNull();
		expect(result!.ruleId).toBe("r-declined");
		expect(result!.action).toBe("delete");
	});

	it("composite AND rule matches old low-rated item", () => {
		const result = evaluateItemAgainstRules(
			oldLowRated,
			rules as LibraryCleanupRule[],
			"RADARR",
			ctx,
		);
		// oldLowRated has no seerr request (tmdbId 12345 has declined request, but this item
		// also has tmdbId 12345 in its data — it WILL match r-declined first)
		expect(result).not.toBeNull();
		expect(result!.ruleId).toBe("r-declined"); // declined rule still matches first
	});

	it("treats absence from a complete Plex inventory as never watched", () => {
		// No seerr data (tmdbId 99999), high rating (9.0), recently added (1 day)
		// - r-declined: no seerr data → skip
		// - r-low-rating: 9.0 not < 5 → skip
		// - r-never-watched: no per-item Plex row in a complete inventory → known never watched
		const result = evaluateItemAgainstRules(
			recentHighRated,
			rules as LibraryCleanupRule[],
			"RADARR",
			ctx,
		);
		expect(result).toMatchObject({ ruleId: "r-never-watched", action: "unmonitor" });
	});

	it("protected item is excluded by title pattern in composite rule", () => {
		// protectedByGenre has rating 2.0, is old (90 days) — matches r-low-rating conditions
		// BUT has excludeTitles pattern "Protected" which matches "Protected Film"
		// So r-low-rating skips. Check if r-never-watched catches it.
		const result = evaluateItemAgainstRules(
			protectedByGenre,
			rules as LibraryCleanupRule[],
			"RADARR",
			ctx,
		);
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

		const result = evaluateItemAgainstRules(
			noSeerrItem,
			rules as LibraryCleanupRule[],
			"RADARR",
			ctx,
		);
		// r-declined: no seerr data → skip
		// r-low-rating: rating 2.5 < 5 AND age ~90 days > 60 → MATCH
		expect(result).not.toBeNull();
		expect(result!.ruleId).toBe("r-low-rating");
		expect(result!.reason).toContain(" AND ");
	});
});
