/**
 * On-Deck Mapping Tests
 *
 * Tests for the pure mapToOnDeckItems helper that maps PlexCache
 * entries to PlexOnDeckItem response objects.
 *
 * Run with: npx vitest run on-deck-helpers.test.ts
 */

import { describe, expect, it } from "vitest";
import { mapToOnDeckItems, type PlexCacheOnDeckEntry } from "../lib/on-deck-helpers.js";

describe("mapToOnDeckItems", () => {
	it("maps cache entries to correct PlexOnDeckItem shape", () => {
		const entries: PlexCacheOnDeckEntry[] = [
			{
				tmdbId: 550,
				title: "Fight Club",
				mediaType: "movie",
				sectionTitle: "Movies",
				instanceId: "inst-1",
				ratingKey: "12345",
			},
		];
		const instanceMap = new Map([["inst-1", "My Plex Server"]]);

		const result = mapToOnDeckItems(entries, instanceMap);

		expect(result).toEqual([
			{
				tmdbId: 550,
				title: "Fight Club",
				mediaType: "movie",
				sectionTitle: "Movies",
				instanceId: "inst-1",
				instanceName: "My Plex Server",
				ratingKey: "12345",
			},
		]);
	});

	it("uses 'Unknown' for unrecognized instance IDs", () => {
		const entries: PlexCacheOnDeckEntry[] = [
			{
				tmdbId: 100,
				title: "Test Movie",
				mediaType: "movie",
				sectionTitle: "Movies",
				instanceId: "unknown-id",
				ratingKey: "99999",
			},
		];
		const instanceMap = new Map<string, string>();

		const result = mapToOnDeckItems(entries, instanceMap);

		expect(result[0]!.instanceName).toBe("Unknown");
	});

	it("returns empty array for empty input", () => {
		const result = mapToOnDeckItems([], new Map());
		expect(result).toEqual([]);
	});

	it("preserves all fields correctly", () => {
		const entries: PlexCacheOnDeckEntry[] = [
			{
				tmdbId: 1,
				title: "Alpha",
				mediaType: "show",
				sectionTitle: "TV Shows",
				instanceId: "a",
				ratingKey: "r1",
			},
			{
				tmdbId: 2,
				title: "Beta",
				mediaType: "episode",
				sectionTitle: "Anime",
				instanceId: "b",
				ratingKey: "r2",
			},
		];
		const instanceMap = new Map([
			["a", "Server A"],
			["b", "Server B"],
		]);

		const result = mapToOnDeckItems(entries, instanceMap);

		expect(result).toHaveLength(2);
		expect(result[0]!.title).toBe("Alpha");
		expect(result[0]!.mediaType).toBe("show");
		expect(result[0]!.instanceName).toBe("Server A");
		expect(result[1]!.title).toBe("Beta");
		expect(result[1]!.mediaType).toBe("episode");
		expect(result[1]!.instanceName).toBe("Server B");
	});
});
