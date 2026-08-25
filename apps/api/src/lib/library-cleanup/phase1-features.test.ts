/**
 * Phase 1 Feature Tests — Library Cleanup Engine Maturity
 *
 * Covers:
 *  1. Prefetch failure handling (6 tests)
 *  2. Retention rules (5 tests)
 *  3. Explain logic (5 tests)
 *  4. Write-time parameter validation (6 tests)
 *  5. shouldSkipForFailedSource (4 tests)
 *  6. Circuit-breaker tested as unit logic (4 tests)
 *
 * Run with: npx vitest run phase1-features.test.ts
 */

import { ruleParamSchemaMap } from "@arr/shared";
import { describe, expect, it, vi } from "vitest";
import type { LibraryCleanupRule } from "../prisma.js";
import {
	buildEvalContextWithHealth,
	buildUnavailableRuleWarning,
	episodeSeriesPolicyMutationVerifiability,
	liveSonarrRetentionRuleTypes,
	seriesRetentionProtectsEpisode,
} from "./cleanup-executor.js";
import {
	evaluateItemAgainstRules,
	explainItemAgainstRules,
	ruleUsesUnavailableData,
} from "./rule-evaluators.js";
import type { CacheItemForEval, EvalContext, PlexWatchInfo, SeerrRequestInfo } from "./types.js";

// ---------------------------------------------------------------------------
// Type stub — same shape as Prisma's LibraryCleanupRule
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
	targetScope: "series" | "episode";
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

function exactEpisodeWatchEvidence(watchCount: number) {
	return [
		{
			plexInstanceId: "plex-1",
			sourceFingerprint: "source-1",
			ratingKey: "episode-202",
			watchCount,
			lastWatchedAt: null,
			watchedByUsers: [],
			refreshedAt: new Date("2026-01-01T00:00:00.000Z"),
		},
	];
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
		targetScope: "series",
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

// ===========================================================================
// 1. Retention Rules
// ===========================================================================

describe("retention rules", () => {
	const seerrMap = new Map<string, SeerrRequestInfo[]>();
	seerrMap.set("movie:12345", [
		{
			requestId: 1,
			status: 5, // completed
			requestedBy: "alice",
			requestedByUserId: 10,
			createdAt: "2025-06-01T00:00:00Z",
			updatedAt: "2025-06-15T00:00:00Z",
			modifiedBy: null,
			is4k: false,
		},
	]);

	const plexMap = new Map<string, PlexWatchInfo>();
	plexMap.set("movie:12345", {
		watchCount: 5,
		lastWatchedAt: new Date("2026-02-15T00:00:00Z"),
		addedAt: new Date("2025-06-01T00:00:00Z"),
		onDeck: true,
		userRating: null,
		collections: [],
		labels: [],
		watchedByUsers: ["alice", "bob"],
		sections: [],
	});

	const ctx = baseCtx({ seerrMap, plexMap });

	const retentionRule = makeRule({
		id: "retention-1",
		name: "Protect watched content",
		retentionMode: true,
		priority: 1,
		ruleType: "plex_watch_count",
		parameters: JSON.stringify({ operator: "greater_than", count: 0 }),
		action: "delete", // action is irrelevant for retention
	});

	const cleanupRule = makeRule({
		id: "cleanup-1",
		name: "Remove old content",
		retentionMode: false,
		priority: 2,
		ruleType: "age",
		parameters: JSON.stringify({ operator: "older_than", days: 30 }),
		action: "delete",
	});

	it("retention rule match protects item from cleanup rules", () => {
		const rules = [retentionRule, cleanupRule] as LibraryCleanupRule[];
		// Item has 5 plex watches → retention matches → returns null (protected)
		const result = evaluateItemAgainstRules(makeCacheItem(), rules, "RADARR", ctx);
		expect(result).toBeNull();
	});

	it("retention rules checked before cleanup regardless of priority order", () => {
		// Swap priority — cleanup P1, retention P2 — retention still checked first
		const rules = [
			makeRule({ ...cleanupRule, priority: 1 }),
			makeRule({ ...retentionRule, priority: 2 }),
		] as LibraryCleanupRule[];
		const result = evaluateItemAgainstRules(makeCacheItem(), rules, "RADARR", ctx);
		expect(result).toBeNull(); // Still protected
	});

	it("non-matching retention rule does not protect item", () => {
		// Retention: plex_watch_count > 10 — item only has 5, won't match
		const strictRetention = makeRule({
			...retentionRule,
			id: "retention-strict",
			parameters: JSON.stringify({ operator: "greater_than", count: 10 }),
		});
		const rules = [strictRetention, cleanupRule] as LibraryCleanupRule[];
		const result = evaluateItemAgainstRules(makeCacheItem(), rules, "RADARR", ctx);
		expect(result).not.toBeNull();
		expect(result!.ruleId).toBe("cleanup-1");
	});

	it("multiple retention rules — any match protects", () => {
		// Retention 1: watch count > 10 (won't match — item has 5)
		// Retention 2: rating > 5 (will match — item has 7.5)
		const ret1 = makeRule({
			id: "ret-1",
			name: "Protect highly watched",
			retentionMode: true,
			ruleType: "plex_watch_count",
			parameters: JSON.stringify({ operator: "greater_than", count: 10 }),
		});
		const ret2 = makeRule({
			id: "ret-2",
			name: "Protect high rated",
			retentionMode: true,
			ruleType: "rating",
			parameters: JSON.stringify({ operator: "greater_than", score: 5 }),
		});
		const rules = [ret1, ret2, cleanupRule] as LibraryCleanupRule[];
		const result = evaluateItemAgainstRules(makeCacheItem(), rules, "RADARR", ctx);
		expect(result).toBeNull(); // ret-2 matches → protected
	});

	it("disabled retention rule is skipped", () => {
		const disabledRet = makeRule({
			...retentionRule,
			enabled: false,
		});
		const rules = [disabledRet, cleanupRule] as LibraryCleanupRule[];
		const result = evaluateItemAgainstRules(makeCacheItem(), rules, "RADARR", ctx);
		// Disabled retention won't protect, cleanup matches
		expect(result).not.toBeNull();
		expect(result!.ruleId).toBe("cleanup-1");
	});
});

// ===========================================================================
// 2. Prefetch Failure Handling (evaluateItemAgainstRules with failedSources)
// ===========================================================================

describe("prefetch failure handling", () => {
	const ctx = baseCtx();

	it("skips rule when its data source has failed", () => {
		const plexRule = makeRule({
			id: "plex-rule",
			ruleType: "plex_watch_count",
			parameters: JSON.stringify({ operator: "less_than", count: 1 }),
		});
		const failedSources = new Set<"seerr" | "tautulli" | "plex" | null>(["plex"]);
		const result = evaluateItemAgainstRules(
			makeCacheItem(),
			[plexRule] as LibraryCleanupRule[],
			"RADARR",
			ctx,
			failedSources,
		);
		expect(result).toBeNull(); // Rule skipped, no match
	});

	it("does not skip rule when a different data source has failed", () => {
		const ageRule = makeRule({
			id: "age-rule",
			ruleType: "age",
			parameters: JSON.stringify({ operator: "older_than", days: 30 }),
		});
		const failedSources = new Set<"seerr" | "tautulli" | "plex" | null>(["plex"]);
		const result = evaluateItemAgainstRules(
			makeCacheItem(),
			[ageRule] as LibraryCleanupRule[],
			"RADARR",
			ctx,
			failedSources,
		);
		expect(result).not.toBeNull(); // age has no data source dependency
	});

	it("skips composite rule when any sub-condition depends on failed source", () => {
		const compositeRule = makeRule({
			id: "composite-1",
			ruleType: "composite",
			operator: "OR",
			conditions: JSON.stringify([
				{ ruleType: "plex_watch_count", parameters: { operator: "less_than", count: 1 } },
				{ ruleType: "rating", parameters: { operator: "less_than", score: 3 } },
			]),
			parameters: "{}",
		});
		const failedSources = new Set<"seerr" | "tautulli" | "plex" | null>(["plex"]);
		const result = evaluateItemAgainstRules(
			makeCacheItem(),
			[compositeRule] as LibraryCleanupRule[],
			"RADARR",
			ctx,
			failedSources,
		);
		// Even though rating < 3 might not match (item has 7.5), the entire
		// composite is skipped because one sub-condition depends on failed plex
		expect(result).toBeNull();
	});

	it("runs composite rule when sub-conditions use only healthy sources", () => {
		const compositeRule = makeRule({
			id: "composite-2",
			ruleType: "composite",
			operator: "AND",
			conditions: JSON.stringify([
				{ ruleType: "age", parameters: { operator: "older_than", days: 30 } },
				{ ruleType: "rating", parameters: { operator: "less_than", score: 8 } },
			]),
			parameters: "{}",
		});
		const failedSources = new Set<"seerr" | "tautulli" | "plex" | null>(["seerr"]);
		const result = evaluateItemAgainstRules(
			makeCacheItem(), // 90 days old, rating 7.5 < 8
			[compositeRule] as LibraryCleanupRule[],
			"RADARR",
			ctx,
			failedSources,
		);
		expect(result).not.toBeNull(); // Both conditions match, no source dependency on seerr
		expect(result!.ruleId).toBe("composite-2");
	});

	it("fails closed when an applicable retention rule's data source has failed", () => {
		const retRule = makeRule({
			id: "ret-plex",
			name: "Protect watched",
			retentionMode: true,
			ruleType: "plex_watch_count",
			parameters: JSON.stringify({ operator: "greater_than", count: 0 }),
		});
		const cleanupRule = makeRule({
			id: "cleanup-age",
			retentionMode: false,
			ruleType: "age",
			parameters: JSON.stringify({ operator: "older_than", days: 30 }),
		});
		const failedSources = new Set<"seerr" | "tautulli" | "plex" | null>(["plex"]);
		const result = evaluateItemAgainstRules(
			makeCacheItem(),
			[retRule, cleanupRule] as LibraryCleanupRule[],
			"RADARR",
			ctx,
			failedSources,
		);
		// Plex evidence cannot disprove retention, so cleanup is blocked.
		expect(result).toBeNull();
	});

	it("does not let an inapplicable unavailable retention rule protect the item", () => {
		const retRule = makeRule({
			id: "ret-other-instance",
			retentionMode: true,
			ruleType: "plex_watch_count",
			parameters: JSON.stringify({ operator: "greater_than", count: 0 }),
			instanceFilter: JSON.stringify(["another-instance"]),
		});
		const cleanupRule = makeRule({
			id: "cleanup-age",
			retentionMode: false,
			ruleType: "age",
			parameters: JSON.stringify({ operator: "older_than", days: 30 }),
		});

		const result = evaluateItemAgainstRules(
			makeCacheItem(),
			[retRule, cleanupRule] as LibraryCleanupRule[],
			"RADARR",
			ctx,
			new Set(["plex"]),
		);

		expect(result?.ruleId).toBe("cleanup-age");
	});

	it("treats a missing provider map as unknown even without health metadata", () => {
		const plexRule = makeRule({
			id: "plex-rule",
			ruleType: "plex_last_watched",
			parameters: JSON.stringify({ operator: "never" }),
		});
		// The absence of a health failure does not manufacture item-level Plex evidence.
		const result = evaluateItemAgainstRules(
			makeCacheItem(),
			[plexRule] as LibraryCleanupRule[],
			"RADARR",
			ctx,
			undefined,
		);
		expect(result).toBeNull();
	});
});

// ===========================================================================
// 3. Explain Logic
// ===========================================================================

describe("explainItemAgainstRules", () => {
	const plexMap = new Map<string, PlexWatchInfo>();
	plexMap.set("movie:12345", {
		watchCount: 5,
		lastWatchedAt: new Date("2026-02-15T00:00:00Z"),
		addedAt: new Date("2025-06-01T00:00:00Z"),
		onDeck: true,
		userRating: null,
		collections: [],
		labels: [],
		watchedByUsers: ["alice"],
		sections: [],
	});

	const ctx = baseCtx({ plexMap });

	it("returns per-rule breakdown showing matched and unmatched", () => {
		const rules = [
			makeRule({
				id: "r1",
				name: "Remove old",
				ruleType: "age",
				parameters: JSON.stringify({ operator: "older_than", days: 30 }),
			}),
			makeRule({
				id: "r2",
				name: "Remove recent",
				ruleType: "age",
				parameters: JSON.stringify({ operator: "newer_than", days: 7 }),
			}),
		] as LibraryCleanupRule[];

		const results = explainItemAgainstRules(makeCacheItem(), rules, "RADARR", ctx);
		expect(results).toHaveLength(2);
		expect(results[0]!.ruleId).toBe("r1");
		expect(results[0]!.matched).toBe(true);
		expect(results[0]!.reason).toContain("days ago");
		expect(results[1]!.ruleId).toBe("r2");
		expect(results[1]!.matched).toBe(false);
		expect(results[1]!.reason).toBeNull();
	});

	it("reports disabled rules with filteredBy=disabled", () => {
		const rules = [
			makeRule({ id: "r-disabled", name: "Disabled Rule", enabled: false }),
		] as LibraryCleanupRule[];
		const results = explainItemAgainstRules(makeCacheItem(), rules, "RADARR", ctx);
		expect(results[0]!.filteredBy).toBe("disabled");
		expect(results[0]!.matched).toBe(false);
	});

	it("reports service filter exclusion", () => {
		const rules = [
			makeRule({
				id: "r-sonarr",
				name: "Sonarr only",
				serviceFilter: JSON.stringify(["SONARR"]),
			}),
		] as LibraryCleanupRule[];
		const results = explainItemAgainstRules(makeCacheItem(), rules, "RADARR", ctx);
		expect(results[0]!.filteredBy).toBe("service_filter");
	});

	it("reports tag exclusion", () => {
		// Item has tags [1, 3], rule excludes tag 1
		const rules = [
			makeRule({
				id: "r-tag",
				name: "Exclude tag",
				excludeTags: JSON.stringify([1]),
			}),
		] as LibraryCleanupRule[];
		const results = explainItemAgainstRules(makeCacheItem(), rules, "RADARR", ctx);
		expect(results[0]!.filteredBy).toBe("tag_exclusion");
	});

	it("shows retentionMode in results", () => {
		const rules = [
			makeRule({
				id: "r-ret",
				name: "Protect watched",
				retentionMode: true,
				ruleType: "plex_watch_count",
				parameters: JSON.stringify({ operator: "greater_than", count: 0 }),
			}),
		] as LibraryCleanupRule[];
		const results = explainItemAgainstRules(makeCacheItem(), rules, "RADARR", ctx);
		expect(results[0]!.retentionMode).toBe(true);
		expect(results[0]!.matched).toBe(true); // item has 5 plex watches
	});

	it("uses episode watch evidence instead of the parent series aggregate", () => {
		const rules = [
			makeRule({
				id: "episode-watch-count",
				name: "Remove watched episodes",
				ruleType: "plex_watch_count",
				parameters: JSON.stringify({ operator: "greater_than", count: 2 }),
				targetScope: "episode",
			}),
		] as LibraryCleanupRule[];

		const results = explainItemAgainstRules(makeCacheItem(), rules, "SONARR", ctx, {
			arrEpisodeId: 202,
			watchEvidence: exactEpisodeWatchEvidence(1),
		});

		expect(results[0]).toMatchObject({
			ruleId: "episode-watch-count",
			matched: false,
			reason: null,
			filteredBy: null,
		});
	});

	it("matches an episode rule from the selected episode's watch evidence", () => {
		const rules = [
			makeRule({
				id: "episode-watch-count",
				name: "Remove watched episodes",
				ruleType: "plex_watch_count",
				parameters: JSON.stringify({ operator: "greater_than", count: 0 }),
				targetScope: "episode",
			}),
		] as LibraryCleanupRule[];

		const results = explainItemAgainstRules(makeCacheItem(), rules, "SONARR", ctx, {
			arrEpisodeId: 202,
			watchEvidence: exactEpisodeWatchEvidence(1),
		});

		expect(results[0]).toMatchObject({
			matched: true,
			reason: "Plex watch count 1 > 0",
			filteredBy: null,
		});
	});

	it("does not evaluate episode rules against a series-only explanation", () => {
		const rules = [
			makeRule({
				id: "episode-watch-count",
				name: "Remove watched episodes",
				ruleType: "plex_watch_count",
				parameters: JSON.stringify({ operator: "greater_than", count: 0 }),
				targetScope: "episode",
			}),
		] as LibraryCleanupRule[];

		const results = explainItemAgainstRules(makeCacheItem(), rules, "SONARR", ctx);

		expect(results[0]).toMatchObject({
			matched: false,
			reason: null,
			filteredBy: "scope_filter",
		});
	});

	it("reports unavailable episode evidence instead of a proven no-match", () => {
		const rules = [
			makeRule({
				id: "episode-watch-count",
				name: "Remove watched episodes",
				ruleType: "plex_watch_count",
				parameters: JSON.stringify({ operator: "greater_than", count: 0 }),
				targetScope: "episode",
			}),
		] as LibraryCleanupRule[];

		const results = explainItemAgainstRules(makeCacheItem(), rules, "SONARR", ctx, {
			arrEpisodeId: 202,
			watchEvidence: [],
		});

		expect(results[0]).toMatchObject({
			matched: false,
			reason: null,
			filteredBy: "evidence_unavailable",
		});
	});

	it("does not explain an unsupported episode retention rule as executable", () => {
		const rules = [
			makeRule({
				id: "episode-retention",
				name: "Unsupported episode retention",
				ruleType: "plex_watch_count",
				parameters: JSON.stringify({ operator: "greater_than", count: 0 }),
				targetScope: "episode",
				retentionMode: true,
			}),
		] as LibraryCleanupRule[];

		const results = explainItemAgainstRules(makeCacheItem(), rules, "SONARR", ctx, {
			arrEpisodeId: 202,
			watchEvidence: exactEpisodeWatchEvidence(1),
		});

		expect(results[0]).toMatchObject({
			matched: false,
			reason: null,
			filteredBy: "unsupported_rule",
		});
	});

	it("reports an unavailable series-retention dependency for an episode", () => {
		const rules = [
			makeRule({
				id: "series-retention",
				name: "Protect watched series",
				ruleType: "plex_watch_count",
				parameters: JSON.stringify({ operator: "greater_than", count: 0 }),
				targetScope: "series",
				retentionMode: true,
			}),
		] as LibraryCleanupRule[];

		const results = explainItemAgainstRules(
			makeCacheItem(),
			rules,
			"SONARR",
			baseCtx(),
			{ arrEpisodeId: 202, watchEvidence: exactEpisodeWatchEvidence(1) },
			new Set(["plex"]),
		);

		expect(results[0]).toMatchObject({
			matched: false,
			reason: null,
			filteredBy: "evidence_unavailable",
			retentionMode: true,
		});
	});
});

describe("buildEvalContextWithHealth", () => {
	it("loads user-scoped TMDb and Trakt evidence for flat and nested cleanup/retention evaluation", async () => {
		const tmdbItems = [{ tmdbId: 12345, mediaType: "movie" as const }];
		const traktItems = [{ tmdbId: 12345, mediaType: "movie" as const }];
		const flatCleanup = makeRule({
			id: "flat-tmdb-cleanup",
			ruleType: "tmdb_list_member",
			parameters: JSON.stringify({ listId: "8068", operator: "is_in" }),
		});
		const flatRetention = makeRule({
			id: "flat-tmdb-retention",
			ruleType: "tmdb_list_member",
			parameters: JSON.stringify({ listId: "8068", operator: "is_in" }),
			retentionMode: true,
		});
		const nestedConditions = JSON.stringify({
			version: 1,
			root: {
				type: "not",
				child: {
					type: "condition",
					ruleType: "trakt_list_member",
					parameters: { listSlug: "owner/list", operator: "not_in" },
				},
			},
		});
		const nestedCleanup = makeRule({
			id: "nested-trakt-cleanup",
			ruleType: "composite",
			parameters: "{}",
			operator: null,
			conditions: nestedConditions,
		});
		const nestedRetention = makeRule({
			...nestedCleanup,
			id: "nested-trakt-retention",
			retentionMode: true,
		});
		const rules = [flatCleanup, flatRetention, nestedCleanup, nestedRetention];
		const userFindUnique = vi.fn().mockResolvedValue({
			encryptedTmdbApiKey: "encrypted-tmdb",
			tmdbEncryptionIv: "tmdb-iv",
			encryptedTraktAccessToken: "encrypted-trakt",
			traktTokenIv: "trakt-iv",
		});
		const { ctx, failedSources } = await buildEvalContextWithHealth(
			{
				prisma: { user: { findUnique: userFindUnique } },
				encryptor: { decrypt: vi.fn().mockReturnValue("decrypted") },
				tmdbListClientFactory: vi.fn().mockReturnValue({
					getListItems: vi.fn().mockResolvedValue(tmdbItems),
				}),
				traktClientId: "trakt-client-id",
				traktListClientFactory: vi.fn().mockReturnValue({
					getListItems: vi.fn().mockResolvedValue(traktItems),
				}),
				arrClientFactory: {},
				log: { warn: vi.fn() },
			} as never,
			"user-1",
			rules,
		);

		expect(userFindUnique).toHaveBeenCalledWith({
			where: { id: "user-1" },
			select: {
				encryptedTmdbApiKey: true,
				tmdbEncryptionIv: true,
				encryptedTraktAccessToken: true,
				traktTokenIv: true,
			},
		});
		expect(failedSources).toEqual(new Set());
		expect(
			evaluateItemAgainstRules(makeCacheItem(), [flatCleanup as LibraryCleanupRule], "RADARR", ctx),
		).toMatchObject({ ruleId: "flat-tmdb-cleanup" });
		expect(
			evaluateItemAgainstRules(
				makeCacheItem(),
				[flatRetention as LibraryCleanupRule, makeRule({ id: "fallback" }) as LibraryCleanupRule],
				"RADARR",
				ctx,
			),
		).toBeNull();
		expect(
			evaluateItemAgainstRules(
				makeCacheItem(),
				[nestedCleanup as LibraryCleanupRule],
				"RADARR",
				ctx,
			),
		).toMatchObject({ ruleId: "nested-trakt-cleanup" });
		expect(
			explainItemAgainstRules(
				makeCacheItem(),
				[nestedRetention as LibraryCleanupRule],
				"RADARR",
				ctx,
			),
		).toEqual([expect.objectContaining({ matched: true, retentionMode: true })]);
	});

	it("marks changing list evidence unavailable instead of certifying membership", async () => {
		const rule = makeRule({
			ruleType: "tmdb_list_member",
			parameters: JSON.stringify({ listId: "8068", operator: "not_in" }),
		});
		const getListItems = vi
			.fn()
			.mockResolvedValueOnce([{ tmdbId: 1, mediaType: "movie" }])
			.mockResolvedValueOnce([{ tmdbId: 2, mediaType: "movie" }]);
		const { ctx, failedSources } = await buildEvalContextWithHealth(
			{
				prisma: {
					user: {
						findUnique: vi.fn().mockResolvedValue({
							encryptedTmdbApiKey: "encrypted",
							tmdbEncryptionIv: "iv",
							encryptedTraktAccessToken: null,
							traktTokenIv: null,
						}),
					},
				},
				encryptor: { decrypt: vi.fn().mockReturnValue("decrypted") },
				tmdbListClientFactory: vi.fn().mockReturnValue({ getListItems }),
				arrClientFactory: {},
				log: { warn: vi.fn() },
			} as never,
			"user-1",
			[rule],
		);

		expect(ctx.tmdbListMemberships).toBeUndefined();
		expect(failedSources).toEqual(new Set(["tmdb"]));
		expect(
			explainItemAgainstRules(
				makeCacheItem(),
				[rule as LibraryCleanupRule],
				"RADARR",
				ctx,
				undefined,
				failedSources,
			),
		).toEqual([expect.objectContaining({ matched: false, filteredBy: "evidence_unavailable" })]);
	});

	it("tracks an unavailable Jellyfin or Emby dependency", async () => {
		const serviceInstanceFindMany = vi.fn().mockResolvedValue([]);
		const { ctx, failedSources } = await buildEvalContextWithHealth(
			{
				prisma: {
					serviceInstance: { findMany: serviceInstanceFindMany },
				},
				arrClientFactory: {},
				log: {},
			} as never,
			"user-1",
			[{ enabled: true, ruleType: "jellyfin_watch_count", conditions: null }],
		);

		expect(serviceInstanceFindMany).toHaveBeenCalledWith({
			where: { userId: "user-1", service: { in: ["JELLYFIN", "EMBY"] }, enabled: true },
			orderBy: { id: "asc" },
		});
		expect(ctx.jellyfinMap).toBeUndefined();
		expect(failedSources).toEqual(new Set(["jellyfin"]));
	});

	it("fails Plex-filtered evidence when a configured section selector is unresolved", async () => {
		const plexInstance = {
			id: "plex-1",
			userId: "user-1",
			service: "PLEX",
			label: "Plex",
			baseUrl: "http://plex.test",
			encryptedApiKey: "encrypted",
			encryptionIv: "iv",
			encryptedHttpAuthCredentials: null,
			httpAuthEncryptionIv: null,
			enabled: true,
			updatedAt: new Date("2026-08-03T12:00:00.000Z"),
		};
		const { ctx, failedSources } = await buildEvalContextWithHealth(
			{
				prisma: {
					serviceInstance: { findMany: vi.fn().mockResolvedValue([plexInstance]) },
				},
				plexCacheClientFactory: vi.fn().mockReturnValue({
					getLibrarySections: vi
						.fn()
						.mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
				}),
				arrClientFactory: {},
				log: { warn: vi.fn() },
			} as never,
			"user-1",
			[
				{
					enabled: true,
					ruleType: "plex_on_deck",
					parameters: JSON.stringify({ isDeck: false }),
					operator: null,
					conditions: null,
					plexLibraryFilter: JSON.stringify(["Movies 4K"]),
				},
			],
		);

		expect(ctx.plexSectionTitles).toBeUndefined();
		expect(failedSources).toContain("plex");
	});

	it("tracks an unavailable Jellyfin or Emby episode-completion dependency", async () => {
		const serviceInstanceFindMany = vi.fn().mockResolvedValue([]);
		const { ctx, failedSources } = await buildEvalContextWithHealth(
			{
				prisma: {
					serviceInstance: { findMany: serviceInstanceFindMany },
				},
				arrClientFactory: {},
				log: {},
			} as never,
			"user-1",
			[{ enabled: true, ruleType: "jellyfin_episode_completion", conditions: null }],
		);

		expect(ctx.jellyfinEpisodeMap).toBeUndefined();
		expect(failedSources).toEqual(new Set(["jellyfin"]));
	});

	it("prefetches provider evidence referenced beneath nested groups and NOT", async () => {
		const serviceInstanceFindMany = vi.fn().mockResolvedValue([]);
		const { failedSources } = await buildEvalContextWithHealth(
			{
				prisma: {
					serviceInstance: { findMany: serviceInstanceFindMany },
				},
				arrClientFactory: {},
				log: {},
			} as never,
			"user-1",
			[
				{
					enabled: true,
					ruleType: "composite",
					parameters: "{}",
					operator: null,
					conditions: JSON.stringify({
						version: 1,
						root: {
							type: "not",
							child: {
								type: "group",
								operator: "OR",
								children: [
									{
										type: "condition",
										ruleType: "jellyfin_episode_completion",
										parameters: { operator: "greater_than", percent: 50 },
									},
								],
							},
						},
					}),
				},
			],
		);

		expect(serviceInstanceFindMany).toHaveBeenCalledWith({
			where: { userId: "user-1", service: { in: ["JELLYFIN", "EMBY"] }, enabled: true },
			orderBy: { id: "asc" },
		});
		expect(failedSources).toEqual(new Set(["jellyfin"]));
	});
});

describe("live mutation expression parity", () => {
	it("collects every condition through the canonical nested expression boundary", () => {
		const rule = makeRule({
			ruleType: "composite",
			parameters: "{}",
			operator: null,
			conditions: JSON.stringify({
				version: 1,
				root: {
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
								ruleType: "plex_episode_completion",
								parameters: { operator: "greater_than", percent: 50 },
							},
						},
					],
				},
			}),
		}) as unknown as LibraryCleanupRule;

		expect(liveSonarrRetentionRuleTypes(rule)).toEqual(
			expect.arrayContaining(["age", "plex_episode_completion"]),
		);
	});
});

describe("episode proposal and mutation policy parity", () => {
	const providerCondition = {
		type: "condition",
		ruleType: "plex_collection",
		parameters: { operator: "includes_any", collections: ["Keep"] },
	};
	const ageCondition = {
		type: "condition",
		ruleType: "age",
		parameters: { operator: "older_than", days: 30 },
	};
	const expressionRule = (
		id: string,
		root: Record<string, unknown>,
		overrides: Partial<TestRule> = {},
	) =>
		makeRule({
			id,
			ruleType: "composite",
			parameters: "{}",
			operator: null,
			conditions: JSON.stringify({ version: 1, root }),
			...overrides,
		}) as unknown as LibraryCleanupRule;
	const seriesItem = (added: string) =>
		makeCacheItem({
			itemType: "series",
			title: "Test Series",
			arrAddedAt: new Date(added),
			data: JSON.stringify({ ...DEFAULT_DATA, added }),
		});

	it("blocks an applicable provider-backed cleanup rule that is UNKNOWN at mutation scope", () => {
		const rule = makeRule({
			id: "provider-cleanup",
			ruleType: "plex_collection",
			parameters: JSON.stringify({
				operator: "includes_any",
				collections: ["Keep"],
			}),
		}) as unknown as LibraryCleanupRule;

		expect(episodeSeriesPolicyMutationVerifiability(seriesItem("2026-02-25"), [rule], NOW)).toEqual(
			{
				verifiable: false,
				blockingRuleIds: ["provider-cleanup"],
			},
		);
	});

	it("allows FALSE AND UNKNOWN because the series rule is provably false", () => {
		const rule = expressionRule("false-and-unknown", {
			type: "group",
			operator: "AND",
			children: [ageCondition, providerCondition],
		});

		expect(episodeSeriesPolicyMutationVerifiability(seriesItem("2026-02-25"), [rule], NOW)).toEqual(
			{
				verifiable: true,
				blockingRuleIds: [],
			},
		);
	});

	it.each([
		[
			"FALSE OR UNKNOWN",
			{
				type: "group",
				operator: "OR",
				children: [ageCondition, providerCondition],
			},
		],
		["NOT UNKNOWN", { type: "not", child: providerCondition }],
	])("blocks %s because UNKNOWN can affect series precedence", (_name, root) => {
		const rule = expressionRule("unknown-series-rule", root);

		expect(episodeSeriesPolicyMutationVerifiability(seriesItem("2026-02-25"), [rule], NOW)).toEqual(
			{
				verifiable: false,
				blockingRuleIds: ["unknown-series-rule"],
			},
		);
	});

	it("blocks TRUE OR UNKNOWN as a proven series match", () => {
		const rule = expressionRule("true-or-unknown", {
			type: "group",
			operator: "OR",
			children: [ageCondition, providerCondition],
		});

		expect(episodeSeriesPolicyMutationVerifiability(seriesItem("2020-01-01"), [rule], NOW)).toEqual(
			{
				verifiable: false,
				blockingRuleIds: ["true-or-unknown"],
			},
		);
	});

	it("applies service filters before UNKNOWN evidence can block", () => {
		const rule = expressionRule(
			"radarr-only",
			{ type: "not", child: providerCondition },
			{ serviceFilter: JSON.stringify(["RADARR"]) },
		);

		expect(episodeSeriesPolicyMutationVerifiability(seriesItem("2026-02-25"), [rule], NOW)).toEqual(
			{
				verifiable: true,
				blockingRuleIds: [],
			},
		);
	});
});

describe("episode series-retention dependency safety", () => {
	const liveAgeOnly = (ruleType: string) => ruleType === "age";
	const providerCondition = {
		type: "condition",
		ruleType: "plex_collection",
		parameters: { operator: "includes_any", collections: ["Keep"] },
	};
	const ageCondition = {
		type: "condition",
		ruleType: "age",
		parameters: { operator: "older_than", days: 30 },
	};
	const nestedRetentionRule = (root: Record<string, unknown>, overrides: Partial<TestRule> = {}) =>
		makeRule({
			id: "nested-retention",
			ruleType: "composite",
			parameters: "{}",
			operator: null,
			conditions: JSON.stringify({ version: 1, root }),
			retentionMode: true,
			...overrides,
		}) as unknown as LibraryCleanupRule;

	it("does not report episode-scoped rules as skipped by a series prefetch failure", () => {
		const episodeRule = makeRule({
			id: "episode-watch-count",
			ruleType: "plex_watch_count",
			parameters: JSON.stringify({ operator: "less_than", count: 1 }),
			targetScope: "episode",
		}) as unknown as LibraryCleanupRule;

		expect(buildUnavailableRuleWarning([episodeRule], new Set(["plex"]))).toBeNull();
	});

	it("fails closed when a Tautulli-backed user-retention source is unavailable", () => {
		const retentionRule = makeRule({
			id: "tautulli-user-retention",
			ruleType: "user_retention",
			parameters: JSON.stringify({
				source: "tautulli",
				mode: "watched_by_all",
				users: ["alice"],
			}),
			retentionMode: true,
		}) as unknown as LibraryCleanupRule;

		expect(ruleUsesUnavailableData(retentionRule, new Set(["tautulli"]))).toBe(true);
		expect(buildUnavailableRuleWarning([retentionRule], new Set(["tautulli"]))).toContain(
			"1 retention rule may default to protection for safety",
		);
		expect(
			seriesRetentionProtectsEpisode(
				makeCacheItem({ itemType: "series" }),
				[retentionRule],
				baseCtx(),
				new Set(["tautulli"]),
			),
		).toBe(true);
	});

	it("fails closed when either source of a combined user-retention rule is unavailable", () => {
		const retentionRule = makeRule({
			id: "combined-user-retention",
			ruleType: "user_retention",
			parameters: JSON.stringify({
				source: "either",
				mode: "watched_by_all",
				users: ["alice"],
			}),
			retentionMode: true,
		}) as unknown as LibraryCleanupRule;

		expect(ruleUsesUnavailableData(retentionRule, new Set(["plex"]))).toBe(true);
		expect(buildUnavailableRuleWarning([retentionRule], new Set(["plex"]))).toContain(
			"1 retention rule may default to protection for safety",
		);
		expect(
			seriesRetentionProtectsEpisode(
				makeCacheItem({ itemType: "series" }),
				[retentionRule],
				baseCtx(),
				new Set(["plex"]),
			),
		).toBe(true);
	});

	it("fails closed when Plex is unavailable to a requester-aware retention rule", () => {
		const retentionRule = makeRule({
			id: "requester-watched-retention",
			ruleType: "seerr_requester_watched",
			parameters: JSON.stringify({}),
			retentionMode: true,
		}) as unknown as LibraryCleanupRule;

		expect(ruleUsesUnavailableData(retentionRule, new Set(["plex"]))).toBe(true);
		expect(
			seriesRetentionProtectsEpisode(
				makeCacheItem({ itemType: "series" }),
				[retentionRule],
				baseCtx(),
				new Set(["plex"]),
			),
		).toBe(true);
	});

	it("suppresses preview when live TRUE AND provider UNKNOWN cannot be proven false", () => {
		const rule = nestedRetentionRule({
			type: "group",
			operator: "AND",
			children: [ageCondition, providerCondition],
		});
		const item = makeCacheItem({ itemType: "series" });
		const knownProviderFalse = baseCtx({
			plexMap: new Map([
				[
					"series:12345",
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
			]),
		});

		expect(seriesRetentionProtectsEpisode(item, [rule], knownProviderFalse, new Set())).toBe(false);
		expect(seriesRetentionProtectsEpisode(item, [rule], { now: NOW }, new Set(), liveAgeOnly)).toBe(
			true,
		);
	});

	it("allows preview when live FALSE dominates provider UNKNOWN in AND", () => {
		const rule = nestedRetentionRule({
			type: "group",
			operator: "AND",
			children: [ageCondition, providerCondition],
		});
		const recentlyAdded = makeCacheItem({
			itemType: "series",
			arrAddedAt: new Date("2026-02-25T00:00:00Z"),
		});

		expect(
			seriesRetentionProtectsEpisode(recentlyAdded, [rule], { now: NOW }, new Set(), liveAgeOnly),
		).toBe(false);
	});

	it.each([
		[
			"FALSE OR UNKNOWN",
			{
				type: "group",
				operator: "OR",
				children: [ageCondition, providerCondition],
			},
		],
		["NOT UNKNOWN", { type: "not", child: providerCondition }],
	])("suppresses preview when %s remains unknown", (_name, root) => {
		const rule = nestedRetentionRule(root);
		const recentlyAdded = makeCacheItem({
			itemType: "series",
			arrAddedAt: new Date("2026-02-25T00:00:00Z"),
		});

		expect(
			seriesRetentionProtectsEpisode(recentlyAdded, [rule], { now: NOW }, new Set(), liveAgeOnly),
		).toBe(true);
	});

	it("applies filters before unknown nested retention evidence", () => {
		const rule = nestedRetentionRule(
			{ type: "not", child: providerCondition },
			{ serviceFilter: JSON.stringify(["RADARR"]) },
		);

		expect(
			seriesRetentionProtectsEpisode(
				makeCacheItem({ itemType: "series" }),
				[rule],
				{ now: NOW },
				new Set(),
				liveAgeOnly,
			),
		).toBe(false);
	});
});

// ===========================================================================
// 4. Write-time Parameter Validation (pure function test)
// ===========================================================================

describe("write-time parameter validation (ruleParamSchemaMap)", () => {
	it("validates age rule with correct params", () => {
		const schema = ruleParamSchemaMap.age;
		expect(schema).toBeDefined();
		const result = schema!.safeParse({ operator: "older_than", days: 30 });
		expect(result.success).toBe(true);
	});

	it("rejects age rule with missing operator", () => {
		const schema = ruleParamSchemaMap.age;
		const result = schema!.safeParse({ days: 30 });
		expect(result.success).toBe(false);
	});

	it("rejects age rule with invalid operator value", () => {
		const schema = ruleParamSchemaMap.age;
		const result = schema!.safeParse({ operator: "invalid_op", days: 30 });
		expect(result.success).toBe(false);
	});

	it("validates rating rule with correct params", () => {
		const schema = ruleParamSchemaMap.rating;
		const result = schema!.safeParse({ source: "tmdb", operator: "less_than", score: 5.0 });
		expect(result.success).toBe(true);
	});

	it("rejects size rule with negative value", () => {
		const schema = ruleParamSchemaMap.size;
		const result = schema!.safeParse({ operator: "greater_than", sizeGb: -1 });
		expect(result.success).toBe(false);
	});

	it("validates plex_watch_count with correct params", () => {
		const schema = ruleParamSchemaMap.plex_watch_count;
		expect(schema).toBeDefined();
		const result = schema!.safeParse({ operator: "less_than", count: 1 });
		expect(result.success).toBe(true);
	});

	// ── Phase 5: external list-membership rules ─────────────────────────

	it("validates tmdb_list_member with correct params", () => {
		const schema = ruleParamSchemaMap.tmdb_list_member;
		expect(schema).toBeDefined();
		const result = schema!.safeParse({ listId: "8068", operator: "is_in" });
		expect(result.success).toBe(true);
	});

	it("rejects tmdb_list_member with empty listId", () => {
		const schema = ruleParamSchemaMap.tmdb_list_member;
		const result = schema!.safeParse({ listId: "", operator: "is_in" });
		expect(result.success).toBe(false);
	});

	it("validates trakt_list_member with username/list-slug format", () => {
		const schema = ruleParamSchemaMap.trakt_list_member;
		expect(schema).toBeDefined();
		const result = schema!.safeParse({
			listSlug: "trakt-official/oscar-winners",
			operator: "is_in",
		});
		expect(result.success).toBe(true);
	});

	it("rejects trakt_list_member with malformed slug (no slash)", () => {
		const schema = ruleParamSchemaMap.trakt_list_member;
		const result = schema!.safeParse({ listSlug: "no-slash-here", operator: "not_in" });
		expect(result.success).toBe(false);
	});
});

// ===========================================================================
// 5. Circuit Breaker Logic (unit-level)
// ===========================================================================

describe("circuit breaker logic", () => {
	// The circuit breaker is inside executeDirectRemoval() in cleanup-executor.ts,
	// which is hard to unit test without a full Fastify app. Here we test the
	// behavior pattern: consecutive failure counting with reset on success.

	function simulateCircuitBreaker(
		outcomes: ("success" | "failure")[],
		threshold = 3,
	): { circuitBroken: boolean; processed: number; skipped: number } {
		let consecutiveFailures = 0;
		let circuitBroken = false;
		let processed = 0;
		let skipped = 0;

		for (const outcome of outcomes) {
			if (circuitBroken) {
				skipped++;
				continue;
			}

			processed++;
			if (outcome === "failure") {
				consecutiveFailures++;
				if (consecutiveFailures >= threshold) {
					circuitBroken = true;
				}
			} else {
				consecutiveFailures = 0;
			}
		}

		return { circuitBroken, processed, skipped };
	}

	it("trips after 3 consecutive failures", () => {
		const result = simulateCircuitBreaker(["failure", "failure", "failure", "failure", "failure"]);
		expect(result.circuitBroken).toBe(true);
		expect(result.processed).toBe(3); // Only processes up to trip point
		expect(result.skipped).toBe(2);
	});

	it("resets counter on success", () => {
		const result = simulateCircuitBreaker([
			"failure",
			"failure",
			"success", // counter resets
			"failure",
			"failure",
			"success", // counter resets again
		]);
		expect(result.circuitBroken).toBe(false);
		expect(result.processed).toBe(6);
		expect(result.skipped).toBe(0);
	});

	it("does not trip with intermittent failures", () => {
		const result = simulateCircuitBreaker([
			"failure",
			"success",
			"failure",
			"success",
			"failure",
			"success",
		]);
		expect(result.circuitBroken).toBe(false);
		expect(result.processed).toBe(6);
	});

	it("trips exactly at threshold", () => {
		const result = simulateCircuitBreaker([
			"success",
			"success",
			"failure",
			"failure",
			"failure", // trips here
			"success",
			"success",
		]);
		expect(result.circuitBroken).toBe(true);
		expect(result.processed).toBe(5); // 2 success + 3 failures
		expect(result.skipped).toBe(2);
	});
});

// ===========================================================================
// 6. Integration — Retention + Prefetch Failure Combined
// ===========================================================================

describe("retention + prefetch failure interaction", () => {
	const ctx = baseCtx();

	it("item is protected when an applicable retention rule's data source failed", () => {
		// Retention: protect if plex watch count > 0 (but plex is down)
		// Cleanup: remove if age > 30 days
		const retRule = makeRule({
			id: "ret-plex",
			retentionMode: true,
			ruleType: "plex_watch_count",
			parameters: JSON.stringify({ operator: "greater_than", count: 0 }),
		});
		const cleanRule = makeRule({
			id: "clean-age",
			retentionMode: false,
			ruleType: "age",
			parameters: JSON.stringify({ operator: "older_than", days: 30 }),
		});
		const failedSources = new Set<"seerr" | "tautulli" | "plex" | null>(["plex"]);

		const result = evaluateItemAgainstRules(
			makeCacheItem(),
			[retRule, cleanRule] as LibraryCleanupRule[],
			"RADARR",
			ctx,
			failedSources,
		);
		// Missing Plex evidence cannot disprove retention.
		expect(result).toBeNull();
	});

	it("item is still protected by retention rule using healthy data source", () => {
		// Retention: protect if rating > 5 (no external data source needed)
		// Cleanup: remove if age > 30 days
		const retRule = makeRule({
			id: "ret-rating",
			retentionMode: true,
			ruleType: "rating",
			parameters: JSON.stringify({ operator: "greater_than", score: 5 }),
		});
		const cleanRule = makeRule({
			id: "clean-age",
			retentionMode: false,
			ruleType: "age",
			parameters: JSON.stringify({ operator: "older_than", days: 30 }),
		});
		const failedSources = new Set<"seerr" | "tautulli" | "plex" | null>(["plex"]);

		const result = evaluateItemAgainstRules(
			makeCacheItem(), // rating 7.5 > 5
			[retRule, cleanRule] as LibraryCleanupRule[],
			"RADARR",
			ctx,
			failedSources,
		);
		// Rating retention matches (no plex dependency) → item protected
		expect(result).toBeNull();
	});
});
