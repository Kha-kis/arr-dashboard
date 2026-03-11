/**
 * Recently Added Mapping Tests
 *
 * Tests for the pure mapToRecentlyAddedItems helper that maps PlexCache
 * entries to PlexRecentlyAddedItem response objects.
 *
 * Run with: npx vitest run recently-added-helpers.test.ts
 */

import { describe, expect, it } from "vitest";
import { mapToRecentlyAddedItems, type PlexCacheRecentEntry } from "../lib/recently-added-helpers.js";

describe("mapToRecentlyAddedItems", () => {
	it("maps cache entries to correct response shape", () => {
		const entries: PlexCacheRecentEntry[] = [
			{
				tmdbId: 550,
				title: "Fight Club",
				mediaType: "movie",
				sectionTitle: "Movies",
				addedAt: new Date("2025-06-15T10:30:00.000Z"),
				ratingKey: "12345",
				instanceId: "inst-1",
			},
		];
		const instanceMap = new Map([["inst-1", "My Plex Server"]]);

		const result = mapToRecentlyAddedItems(entries, instanceMap);

		expect(result).toEqual([
			{
				tmdbId: 550,
				title: "Fight Club",
				mediaType: "movie",
				sectionTitle: "Movies",
				addedAt: "2025-06-15T10:30:00.000Z",
				ratingKey: "12345",
				instanceId: "inst-1",
				instanceName: "My Plex Server",
			},
		]);
	});

	it("converts addedAt Date to ISO string", () => {
		const date = new Date("2024-12-25T00:00:00.000Z");
		const entries: PlexCacheRecentEntry[] = [
			{
				tmdbId: 1,
				title: "Holiday Special",
				mediaType: "movie",
				sectionTitle: "Movies",
				addedAt: date,
				ratingKey: "r1",
				instanceId: "a",
			},
		];
		const instanceMap = new Map([["a", "Server"]]);

		const result = mapToRecentlyAddedItems(entries, instanceMap);

		expect(result[0]!.addedAt).toBe("2024-12-25T00:00:00.000Z");
		expect(typeof result[0]!.addedAt).toBe("string");
	});

	it("uses 'Unknown' for unrecognized instance IDs", () => {
		const entries: PlexCacheRecentEntry[] = [
			{
				tmdbId: 100,
				title: "Test",
				mediaType: "movie",
				sectionTitle: "Movies",
				addedAt: new Date(),
				ratingKey: "r1",
				instanceId: "missing-id",
			},
		];
		const instanceMap = new Map<string, string>();

		const result = mapToRecentlyAddedItems(entries, instanceMap);

		expect(result[0]!.instanceName).toBe("Unknown");
	});

	it("returns empty array for empty input", () => {
		const result = mapToRecentlyAddedItems([], new Map());
		expect(result).toEqual([]);
	});
});
