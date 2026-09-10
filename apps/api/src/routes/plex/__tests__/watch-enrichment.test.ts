/**
 * Watch Enrichment Aggregation Tests
 *
 * Tests for the pure aggregateWatchEnrichment helper that merges
 * PlexCache + TautulliCache entries into WatchEnrichmentItems.
 *
 * Run with: npx vitest run watch-enrichment.test.ts
 */

import type { ProviderObservationStatus } from "@arr/shared";
import { describe, expect, it } from "vitest";
import {
	aggregateWatchEnrichment,
	type ParseLogger,
	type PlexCacheEntry,
	type TautulliCacheEntry,
} from "../lib/watch-enrichment-helpers.js";

const observedAt = "2026-09-06T12:00:00.000Z";
const exactStatus = {
	availability: "current" as const,
	evidence: "complete" as const,
	observedAt,
	ageSeconds: 0,
	latestAttempt: "successful" as const,
	reasonCodes: [],
	domains: [
		{
			domain: "watch-count" as const,
			availability: "current" as const,
			evidence: "complete" as const,
			valueSemantics: "exact" as const,
			observedAt,
			reasonCodes: [],
		},
		{
			domain: "watch-attribution" as const,
			availability: "current" as const,
			evidence: "complete" as const,
			valueSemantics: "exact" as const,
			observedAt,
			reasonCodes: [],
		},
		{
			domain: "on-deck" as const,
			availability: "current" as const,
			evidence: "complete" as const,
			valueSemantics: "exact" as const,
			observedAt,
			reasonCodes: [],
		},
	],
};
const lowerBoundStatus: ProviderObservationStatus = {
	availability: "partial" as const,
	evidence: "positive-only" as const,
	observedAt,
	ageSeconds: 0,
	latestAttempt: "successful" as const,
	reasonCodes: ["positive-only", "coverage-incomplete"],
	domains: [
		{
			domain: "watch-count" as const,
			availability: "current" as const,
			evidence: "positive-only" as const,
			valueSemantics: "lower-bound" as const,
			observedAt,
			reasonCodes: ["positive-only", "coverage-incomplete"],
		},
	],
};

const testLogger: ParseLogger = { warn: () => {} };

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function plexEntry(overrides: Partial<PlexCacheEntry> = {}): PlexCacheEntry {
	return {
		tmdbId: 100,
		mediaType: "movie",
		instanceId: "plex-1",
		lastWatchedAt: new Date("2024-06-01"),
		watchCount: 3,
		onDeck: false,
		userRating: null,
		ratingKey: "12345",
		watchedByUsers: '["alice","bob"]',
		collections: '["Action"]',
		labels: '["4K"]',
		providerStatus: exactStatus,
		...overrides,
	};
}

function tautulliEntry(overrides: Partial<TautulliCacheEntry> = {}): TautulliCacheEntry {
	return {
		tmdbId: 100,
		mediaType: "movie",
		instanceId: "tautulli-1",
		lastWatchedAt: new Date("2024-06-15"),
		watchCount: 5,
		watchedByUsers: '["alice","charlie"]',
		providerStatus: lowerBoundStatus,
		...overrides,
	};
}

function makeKeys(
	...pairs: [string, number][]
): Map<string, { tmdbId: number; mediaType: string }> {
	const map = new Map<string, { tmdbId: number; mediaType: string }>();
	for (const [mediaType, tmdbId] of pairs) {
		map.set(`${mediaType}:${tmdbId}`, { tmdbId, mediaType });
	}
	return map;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("aggregateWatchEnrichment", () => {
	it("aggregates a single Plex match correctly", () => {
		const keys = makeKeys(["movie", 100]);
		const result = aggregateWatchEnrichment(keys, [plexEntry()], [], undefined, testLogger);

		const item = result["movie:100"];
		expect(item).toBeDefined();
		expect(item!.watchCount).toBe(3);
		expect(item!.watchCountSemantics).toBe("exact");
		expect(item!.source).toBe("plex");
		expect(item!.onDeck).toBe(false);
		expect(item!.lastWatchedAt).toBe("2024-06-01T00:00:00.000Z");
		expect(item!.watchedByUsers).toEqual(expect.arrayContaining(["alice", "bob"]));
		expect(item!.collections).toEqual(["Action"]);
		expect(item!.labels).toEqual(["4K"]);
		expect(item!.ratingKey).toBe("12345");
	});

	it("aggregates a single Tautulli match correctly", () => {
		const keys = makeKeys(["movie", 100]);
		const result = aggregateWatchEnrichment(keys, [], [tautulliEntry()], undefined, testLogger);

		const item = result["movie:100"];
		expect(item).toBeDefined();
		expect(item!.watchCount).toBe(5);
		expect(item!.watchCountSemantics).toBe("lower-bound");
		expect(item!.source).toBe("tautulli");
		expect(item!.lastWatchedAt).toBeNull();
		expect(item!.watchedByUsers).toEqual([]);
		// Tautulli entries don't have ratingKey/collections/labels
		expect(item!.ratingKey).toBeNull();
		expect(item!.collections).toEqual([]);
		expect(item!.labels).toEqual([]);
	});

	it("uses max(plex, tautulli) for watchCount and source='both' when both match", () => {
		const keys = makeKeys(["movie", 100]);
		const result = aggregateWatchEnrichment(
			keys,
			[plexEntry({ watchCount: 3 })],
			[tautulliEntry({ watchCount: 5 })],
			undefined,
			testLogger,
		);

		const item = result["movie:100"]!;
		expect(item.watchCount).toBe(5); // max(3, 5)
		expect(item.source).toBe("both");
		expect(item.watchCountSemantics).toBe("lower-bound");
		// Tautulli never supplies timestamps or user attribution to a mixed item.
		expect(item.lastWatchedAt).toBe("2024-06-01T00:00:00.000Z");
		expect(item.watchedByUsers).toEqual(["alice", "bob"]);
	});

	it("aggregates across multiple Plex instances", () => {
		const keys = makeKeys(["movie", 100]);
		const result = aggregateWatchEnrichment(
			keys,
			[
				plexEntry({ instanceId: "plex-1", watchCount: 2, watchedByUsers: '["alice"]' }),
				plexEntry({
					instanceId: "plex-2",
					watchCount: 4,
					ratingKey: null,
					watchedByUsers: '["bob"]',
				}),
			],
			[],
			undefined,
			testLogger,
		);

		const item = result["movie:100"]!;
		// Duplicate provider rows are conservative lower bounds, never a sum.
		expect(item.watchCount).toBe(4);
		expect(item.watchCountSemantics).toBe("lower-bound");
		expect(item.watchedByUsers).toEqual(["alice"]);
	});

	it("does not turn duplicate exact zero counts into a zero lower bound", () => {
		const keys = makeKeys(["movie", 100]);
		const result = aggregateWatchEnrichment(
			keys,
			[
				plexEntry({ instanceId: "plex-1", watchCount: 0 }),
				plexEntry({ instanceId: "plex-2", watchCount: 0, ratingKey: null }),
			],
			[],
			undefined,
			testLogger,
		);

		const item = result["movie:100"]!;
		expect(item.watchCount).toBeNull();
		expect(item.watchCountSemantics).toBe("unknown");
	});

	it("omits keys with no matching entries", () => {
		const keys = makeKeys(["movie", 100], ["series", 200]);
		const result = aggregateWatchEnrichment(
			keys,
			[plexEntry({ tmdbId: 100, mediaType: "movie" })],
			[],
			undefined,
			testLogger,
		);

		expect(result["movie:100"]).toBeDefined();
		expect(result["series:200"]).toBeUndefined();
	});

	it("preserves data when filterUser matches", () => {
		const keys = makeKeys(["movie", 100]);
		const result = aggregateWatchEnrichment(
			keys,
			[plexEntry({ watchedByUsers: '["alice","bob"]' })],
			[],
			"alice",
			testLogger,
		);

		const item = result["movie:100"]!;
		expect(item.watchCount).toBe(3);
		expect(item.watchedByUsers).toEqual(expect.arrayContaining(["alice", "bob"]));
		expect(item.onDeck).toBe(false);
	});

	it("returns unknown rather than asserting zero when filterUser lacks exact attribution", () => {
		const keys = makeKeys(["movie", 100]);
		const result = aggregateWatchEnrichment(
			keys,
			[plexEntry({ watchCount: 3, onDeck: true, userRating: 8.5, watchedByUsers: '["alice"]' })],
			[],
			"dave", // dave is not in watchedByUsers
			testLogger,
		);

		const item = result["movie:100"]!;
		expect(item.watchCount).toBeNull();
		expect(item.watchCountSemantics).toBe("unknown");
		expect(item.lastWatchedAt).toBeNull();
		expect(item.watchedByUsers).toEqual([]);
		expect(item.onDeck).toBe(true);
		expect(item.userRating).toBeNull();
		// source should still reflect where data came from
		expect(item.source).toBe("plex");
	});

	it("keeps on-deck unknown without a current exact on-deck domain", () => {
		const keys = makeKeys(["movie", 100]);
		const result = aggregateWatchEnrichment(
			keys,
			[
				plexEntry({
					onDeck: true,
					providerStatus: {
						...exactStatus,
						domains: exactStatus.domains.filter((domain) => domain.domain !== "on-deck"),
					},
				}),
			],
			[],
			undefined,
			testLogger,
		);

		expect(result["movie:100"]!.onDeck).toBeNull();
	});

	it("gracefully handles malformed JSON in collections/labels/watchedByUsers", () => {
		const keys = makeKeys(["movie", 100]);
		const result = aggregateWatchEnrichment(
			keys,
			[
				plexEntry({
					collections: "not-json",
					labels: "{invalid}",
					watchedByUsers: "broken",
				}),
			],
			[tautulliEntry({ watchedByUsers: "also-broken" })],
			undefined,
			testLogger,
		);

		const item = result["movie:100"]!;
		expect(item.collections).toEqual([]);
		expect(item.labels).toEqual([]);
		expect(item.watchedByUsers).toEqual([]);
		// Both sources matched, even though JSON was bad
		expect(item.source).toBe("both");
	});

	it("keeps rating metadata bound to the selected Plex media-server identity", () => {
		const keys = makeKeys(["movie", 100]);
		const result = aggregateWatchEnrichment(
			keys,
			[
				plexEntry({ instanceId: "plex-1", userRating: 7.0, ratingKey: "a" }),
				plexEntry({ instanceId: "plex-2", userRating: 9.5, ratingKey: null }),
			],
			[],
			undefined,
			testLogger,
		);

		expect(result["movie:100"]!.userRating).toBe(7.0);
	});
});
