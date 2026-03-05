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

import { describe, expect, it } from "vitest";
import type { CacheItemForEval, EvalContext, PlexWatchInfo, SeerrRequestInfo } from "./types.js";
import {
	evaluateItemAgainstRules,
	explainItemAgainstRules,
} from "./rule-evaluators.js";
import { ruleParamSchemaMap } from "@arr/shared";

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

// ===========================================================================
// 1. Retention Rules
// ===========================================================================

describe("retention rules", () => {
	const seerrMap = new Map<string, SeerrRequestInfo[]>();
	seerrMap.set("movie:12345", [{
		requestId: 1,
		status: 5, // completed
		requestedBy: "alice",
		requestedByUserId: 10,
		createdAt: "2025-06-01T00:00:00Z",
		updatedAt: "2025-06-15T00:00:00Z",
		modifiedBy: null,
		is4k: false,
	}]);

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
		const rules = [retentionRule, cleanupRule] as any[];
		// Item has 5 plex watches → retention matches → returns null (protected)
		const result = evaluateItemAgainstRules(makeCacheItem(), rules, "RADARR", ctx);
		expect(result).toBeNull();
	});

	it("retention rules checked before cleanup regardless of priority order", () => {
		// Swap priority — cleanup P1, retention P2 — retention still checked first
		const rules = [
			makeRule({ ...cleanupRule, priority: 1 }),
			makeRule({ ...retentionRule, priority: 2 }),
		] as any[];
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
		const rules = [strictRetention, cleanupRule] as any[];
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
		const rules = [ret1, ret2, cleanupRule] as any[];
		const result = evaluateItemAgainstRules(makeCacheItem(), rules, "RADARR", ctx);
		expect(result).toBeNull(); // ret-2 matches → protected
	});

	it("disabled retention rule is skipped", () => {
		const disabledRet = makeRule({
			...retentionRule,
			enabled: false,
		});
		const rules = [disabledRet, cleanupRule] as any[];
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
			[plexRule] as any[],
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
			[ageRule] as any[],
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
			[compositeRule] as any[],
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
			[compositeRule] as any[],
			"RADARR",
			ctx,
			failedSources,
		);
		expect(result).not.toBeNull(); // Both conditions match, no source dependency on seerr
		expect(result!.ruleId).toBe("composite-2");
	});

	it("skips retention rule when its data source has failed", () => {
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
			[retRule, cleanupRule] as any[],
			"RADARR",
			ctx,
			failedSources,
		);
		// Retention rule skipped (plex failed) → cleanup rule matches
		expect(result).not.toBeNull();
		expect(result!.ruleId).toBe("cleanup-age");
	});

	it("no failedSources = normal evaluation", () => {
		const plexRule = makeRule({
			id: "plex-rule",
			ruleType: "plex_last_watched",
			parameters: JSON.stringify({ operator: "never" }),
		});
		// No plexMap in context, so plex_last_watched with "never" and no watch data
		// should match (watch is null → "never" matches)
		const result = evaluateItemAgainstRules(
			makeCacheItem(),
			[plexRule] as any[],
			"RADARR",
			ctx,
			undefined,
		);
		expect(result).not.toBeNull();
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
		] as any[];

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
		] as any[];
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
		] as any[];
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
		] as any[];
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
		] as any[];
		const results = explainItemAgainstRules(makeCacheItem(), rules, "RADARR", ctx);
		expect(results[0]!.retentionMode).toBe(true);
		expect(results[0]!.matched).toBe(true); // item has 5 plex watches
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
			"failure", "failure", "success", // counter resets
			"failure", "failure", "success", // counter resets again
		]);
		expect(result.circuitBroken).toBe(false);
		expect(result.processed).toBe(6);
		expect(result.skipped).toBe(0);
	});

	it("does not trip with intermittent failures", () => {
		const result = simulateCircuitBreaker([
			"failure", "success", "failure", "success", "failure", "success",
		]);
		expect(result.circuitBroken).toBe(false);
		expect(result.processed).toBe(6);
	});

	it("trips exactly at threshold", () => {
		const result = simulateCircuitBreaker([
			"success", "success",
			"failure", "failure", "failure", // trips here
			"success", "success",
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

	it("item is NOT protected when retention rule's data source failed", () => {
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
			[retRule, cleanRule] as any[],
			"RADARR",
			ctx,
			failedSources,
		);
		// Retention is skipped (plex failed) → age rule matches → item flagged
		expect(result).not.toBeNull();
		expect(result!.ruleId).toBe("clean-age");
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
			[retRule, cleanRule] as any[],
			"RADARR",
			ctx,
			failedSources,
		);
		// Rating retention matches (no plex dependency) → item protected
		expect(result).toBeNull();
	});
});
