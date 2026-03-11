/**
 * Collection Stats Helpers
 *
 * Pure functions for aggregating collection and label statistics
 * from PlexCache data, including watch progress per collection/label.
 */

import type { CollectionStats } from "@arr/shared";

/** PlexCache row shape for collection/label analysis */
export interface PlexCacheEntry {
	collections: string; // JSON array of collection names
	labels: string; // JSON array of label names
	watchCount: number;
}

/**
 * Aggregate collection and label statistics from PlexCache entries.
 * Each entry's collections/labels are JSON arrays of strings.
 */
export interface CollectionStatsResult extends CollectionStats {
	parseFailures: number;
	totalEntries: number;
	failedPreviews: string[];
}

export function aggregateCollectionStats(entries: PlexCacheEntry[]): CollectionStatsResult {
	const collectionMap = new Map<string, { total: number; watched: number }>();
	const labelMap = new Map<string, { total: number; watched: number }>();
	let parseFailures = 0;
	const failedPreviews: string[] = [];

	for (const entry of entries) {
		const isWatched = entry.watchCount > 0;

		// Parse collections
		let collections: string[] = [];
		try {
			const parsed = JSON.parse(entry.collections);
			if (Array.isArray(parsed)) collections = parsed;
		} catch {
			parseFailures++;
			if (failedPreviews.length < 5)
				failedPreviews.push(`collections: ${entry.collections.slice(0, 80)}`);
		}

		for (const name of collections) {
			const existing = collectionMap.get(name) ?? { total: 0, watched: 0 };
			existing.total++;
			if (isWatched) existing.watched++;
			collectionMap.set(name, existing);
		}

		// Parse labels
		let labels: string[] = [];
		try {
			const parsed = JSON.parse(entry.labels);
			if (Array.isArray(parsed)) labels = parsed;
		} catch {
			parseFailures++;
			if (failedPreviews.length < 5) failedPreviews.push(`labels: ${entry.labels.slice(0, 80)}`);
		}

		for (const name of labels) {
			const existing = labelMap.get(name) ?? { total: 0, watched: 0 };
			existing.total++;
			if (isWatched) existing.watched++;
			labelMap.set(name, existing);
		}
	}

	const toArray = (map: Map<string, { total: number; watched: number }>) =>
		[...map.entries()]
			.map(([name, data]) => ({
				name,
				totalItems: data.total,
				watchedItems: data.watched,
				watchPercent: data.total > 0 ? Math.round((data.watched / data.total) * 1000) / 10 : 0,
			}))
			.sort((a, b) => b.totalItems - a.totalItems);

	return {
		collections: toArray(collectionMap),
		labels: toArray(labelMap),
		parseFailures,
		totalEntries: entries.length,
		failedPreviews,
	};
}
