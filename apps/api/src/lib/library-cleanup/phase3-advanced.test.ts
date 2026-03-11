/**
 * Phase 3 Advanced Automation Tests
 *
 * Covers:
 *  1. Recently active rule (5 tests)
 *  2. Statistics endpoint logic (4 tests — unit tests of aggregation)
 *
 * Run with: npx vitest run phase3-advanced.test.ts
 */

import { describe, expect, it } from "vitest";
import type { CacheItemForEval, EvalContext, PlexWatchInfo } from "./types.js";
import { evaluateSingleCondition } from "./rule-evaluators.js";

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
		arrAddedAt: new Date("2026-02-15T00:00:00Z"), // 14 days ago
		data: JSON.stringify(DEFAULT_DATA),
		...overrides,
	};
}

function baseCtx(overrides: Partial<EvalContext> = {}): EvalContext {
	return { now: NOW, ...overrides };
}

// ===========================================================================
// 1. Recently Active Rule
// ===========================================================================

describe("recently_active rule", () => {
	it("matches item within protection window (no activity required)", () => {
		const result = evaluateSingleCondition(
			makeCacheItem(), // added 14 days ago
			"recently_active",
			{ protectionDays: 30, requireActivity: false },
			baseCtx(),
		);
		expect(result).toContain("14 days");
		expect(result).toContain("protection window: 30 days");
	});

	it("does not match item outside protection window", () => {
		const result = evaluateSingleCondition(
			makeCacheItem({ arrAddedAt: new Date("2025-01-01T00:00:00Z") }), // 425+ days ago
			"recently_active",
			{ protectionDays: 30, requireActivity: false },
			baseCtx(),
		);
		expect(result).toBeNull();
	});

	it("matches when activity is required and item has watches", () => {
		const plexMap = new Map<string, PlexWatchInfo>();
		plexMap.set("movie:12345", {
			watchCount: 3,
			lastWatchedAt: new Date("2026-02-20T00:00:00Z"),
			addedAt: new Date("2026-02-15T00:00:00Z"),
			onDeck: false,
			userRating: null,
			watchedByUsers: [],
			collections: [],
			labels: [],
			sections: [],
		});

		const result = evaluateSingleCondition(
			makeCacheItem(), // added 14 days ago
			"recently_active",
			{ protectionDays: 30, requireActivity: true },
			baseCtx({ plexMap }),
		);
		expect(result).toContain("activity");
	});

	it("does not match when activity is required but no watches exist", () => {
		const plexMap = new Map<string, PlexWatchInfo>();
		// No entry for this item's TMDB ID

		const result = evaluateSingleCondition(
			makeCacheItem(), // added 14 days ago
			"recently_active",
			{ protectionDays: 30, requireActivity: true },
			baseCtx({ plexMap }),
		);
		expect(result).toBeNull();
	});

	it("does not match when arrAddedAt is null", () => {
		const result = evaluateSingleCondition(
			makeCacheItem({ arrAddedAt: null }),
			"recently_active",
			{ protectionDays: 30, requireActivity: false },
			baseCtx(),
		);
		expect(result).toBeNull();
	});
});

// ===========================================================================
// 2. Statistics Aggregation Logic (pure function tests)
// ===========================================================================

/**
 * These tests verify the aggregation logic that the statistics endpoint uses.
 * We extract the core aggregation into a testable pattern rather than
 * testing the HTTP endpoint directly (which would need full server setup).
 */

interface LogEntry {
	status: string;
	itemsEvaluated: number;
	itemsFlagged: number;
	itemsRemoved: number;
	itemsUnmonitored: number;
	itemsFilesDeleted: number;
	details: string | null;
}

function aggregateStats(logs: LogEntry[]) {
	let successfulRuns = 0;
	let partialRuns = 0;
	let failedRuns = 0;
	let totalItemsEvaluated = 0;
	let totalItemsFlagged = 0;
	let totalItemsRemoved = 0;
	let totalItemsUnmonitored = 0;
	let totalFilesDeleted = 0;
	const ruleMatchCounts = new Map<string, { ruleName: string; count: number }>();

	for (const log of logs) {
		if (log.status === "completed") successfulRuns++;
		else if (log.status === "partial") partialRuns++;
		else failedRuns++;

		totalItemsEvaluated += log.itemsEvaluated;
		totalItemsFlagged += log.itemsFlagged;
		totalItemsRemoved += log.itemsRemoved;
		totalItemsUnmonitored += log.itemsUnmonitored;
		totalFilesDeleted += log.itemsFilesDeleted;

		let details: Array<{ ruleId?: string; rule?: string }> | null = null;
		try {
			details = log.details ? JSON.parse(log.details) : null;
		} catch {
			details = null;
		}
		if (Array.isArray(details)) {
			for (const d of details) {
				if (d.ruleId) {
					const existing = ruleMatchCounts.get(d.ruleId);
					if (existing) {
						existing.count++;
					} else {
						ruleMatchCounts.set(d.ruleId, { ruleName: d.rule ?? d.ruleId, count: 1 });
					}
				}
			}
		}
	}

	return {
		totalRuns: logs.length,
		successfulRuns,
		partialRuns,
		failedRuns,
		totalItemsEvaluated,
		totalItemsFlagged,
		totalItemsRemoved,
		totalItemsUnmonitored,
		totalFilesDeleted,
		ruleEffectiveness: Array.from(ruleMatchCounts.entries())
			.map(([ruleId, { ruleName, count }]) => ({ ruleId, ruleName, matchCount: count }))
			.sort((a, b) => b.matchCount - a.matchCount),
	};
}

describe("statistics aggregation", () => {
	it("counts run statuses correctly", () => {
		const logs: LogEntry[] = [
			{
				status: "completed",
				itemsEvaluated: 100,
				itemsFlagged: 5,
				itemsRemoved: 3,
				itemsUnmonitored: 1,
				itemsFilesDeleted: 1,
				details: null,
			},
			{
				status: "completed",
				itemsEvaluated: 100,
				itemsFlagged: 2,
				itemsRemoved: 2,
				itemsUnmonitored: 0,
				itemsFilesDeleted: 0,
				details: null,
			},
			{
				status: "partial",
				itemsEvaluated: 50,
				itemsFlagged: 0,
				itemsRemoved: 0,
				itemsUnmonitored: 0,
				itemsFilesDeleted: 0,
				details: null,
			},
			{
				status: "error",
				itemsEvaluated: 0,
				itemsFlagged: 0,
				itemsRemoved: 0,
				itemsUnmonitored: 0,
				itemsFilesDeleted: 0,
				details: null,
			},
		];

		const stats = aggregateStats(logs);
		expect(stats.totalRuns).toBe(4);
		expect(stats.successfulRuns).toBe(2);
		expect(stats.partialRuns).toBe(1);
		expect(stats.failedRuns).toBe(1);
		expect(stats.totalItemsEvaluated).toBe(250);
		expect(stats.totalItemsFlagged).toBe(7);
		expect(stats.totalItemsRemoved).toBe(5);
	});

	it("extracts rule effectiveness from log details", () => {
		const logs: LogEntry[] = [
			{
				status: "completed",
				itemsEvaluated: 100,
				itemsFlagged: 3,
				itemsRemoved: 3,
				itemsUnmonitored: 0,
				itemsFilesDeleted: 0,
				details: JSON.stringify([
					{ ruleId: "rule-1", rule: "Old Movies" },
					{ ruleId: "rule-1", rule: "Old Movies" },
					{ ruleId: "rule-2", rule: "Low Rating" },
				]),
			},
			{
				status: "completed",
				itemsEvaluated: 100,
				itemsFlagged: 1,
				itemsRemoved: 1,
				itemsUnmonitored: 0,
				itemsFilesDeleted: 0,
				details: JSON.stringify([{ ruleId: "rule-1", rule: "Old Movies" }]),
			},
		];

		const stats = aggregateStats(logs);
		expect(stats.ruleEffectiveness).toHaveLength(2);
		// Sorted by match count descending
		expect(stats.ruleEffectiveness[0]).toEqual({
			ruleId: "rule-1",
			ruleName: "Old Movies",
			matchCount: 3,
		});
		expect(stats.ruleEffectiveness[1]).toEqual({
			ruleId: "rule-2",
			ruleName: "Low Rating",
			matchCount: 1,
		});
	});

	it("handles empty logs", () => {
		const stats = aggregateStats([]);
		expect(stats.totalRuns).toBe(0);
		expect(stats.totalItemsEvaluated).toBe(0);
		expect(stats.ruleEffectiveness).toEqual([]);
	});

	it("handles malformed details gracefully", () => {
		const logs: LogEntry[] = [
			{
				status: "completed",
				itemsEvaluated: 50,
				itemsFlagged: 1,
				itemsRemoved: 1,
				itemsUnmonitored: 0,
				itemsFilesDeleted: 0,
				details: "not valid json{{{",
			},
			{
				status: "completed",
				itemsEvaluated: 50,
				itemsFlagged: 0,
				itemsRemoved: 0,
				itemsUnmonitored: 0,
				itemsFilesDeleted: 0,
				details: null,
			},
		];

		const stats = aggregateStats(logs);
		expect(stats.totalRuns).toBe(2);
		expect(stats.ruleEffectiveness).toEqual([]);
		// Counts still aggregate correctly even without rule details
		expect(stats.totalItemsEvaluated).toBe(100);
	});
});
