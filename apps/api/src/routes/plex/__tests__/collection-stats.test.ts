import { describe, expect, it } from "vitest";
import { aggregateCollectionStats, type PlexCacheEntry } from "../lib/collection-stats-helpers.js";

function entry(overrides: Partial<PlexCacheEntry> = {}): PlexCacheEntry {
	return {
		collections: "[]",
		labels: "[]",
		watchCount: 0,
		...overrides,
	};
}

describe("aggregateCollectionStats", () => {
	it("counts items per collection with watched percentage", () => {
		const entries = [
			entry({ collections: '["Action", "Sci-Fi"]', watchCount: 3 }),
			entry({ collections: '["Action"]', watchCount: 0 }),
			entry({ collections: '["Sci-Fi"]', watchCount: 1 }),
		];

		const result = aggregateCollectionStats(entries);
		const action = result.collections.find((c) => c.name === "Action");
		expect(action?.totalItems).toBe(2);
		expect(action?.watchedItems).toBe(1);
		expect(action?.watchPercent).toBe(50);
	});

	it("counts items per label", () => {
		const entries = [
			entry({ labels: '["4K", "HDR"]', watchCount: 1 }),
			entry({ labels: '["4K"]', watchCount: 0 }),
		];

		const result = aggregateCollectionStats(entries);
		const label4k = result.labels.find((l) => l.name === "4K");
		expect(label4k?.totalItems).toBe(2);
		expect(label4k?.watchedItems).toBe(1);
	});

	it("handles empty collections/labels gracefully", () => {
		const entries = [entry({ collections: "[]", labels: "[]" })];
		const result = aggregateCollectionStats(entries);
		expect(result.collections).toEqual([]);
		expect(result.labels).toEqual([]);
	});

	it("handles malformed JSON gracefully", () => {
		const entries = [entry({ collections: "not-json", labels: "not-json" })];
		const result = aggregateCollectionStats(entries);
		expect(result.collections).toEqual([]);
		expect(result.labels).toEqual([]);
	});

	it("sorts by totalItems descending", () => {
		const entries = [
			entry({ collections: '["Rare"]' }),
			entry({ collections: '["Popular"]' }),
			entry({ collections: '["Popular"]' }),
			entry({ collections: '["Popular"]' }),
		];

		const result = aggregateCollectionStats(entries);
		expect(result.collections[0]?.name).toBe("Popular");
	});
});
