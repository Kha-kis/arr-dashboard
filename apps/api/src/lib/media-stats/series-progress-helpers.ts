/**
 * Series Progress Aggregation Helpers
 *
 * Pure function for aggregating PlexEpisodeCache entries into per-series
 * progress percentages. Extracted from series-progress-routes.ts for testability.
 */

import type { SeriesProgressItem } from "@arr/shared";

/** Minimal episode shape needed for aggregation */
export interface EpisodeInput {
	showTmdbId: number;
	watched: boolean;
}

/**
 * Aggregate episode watch data into per-series progress percentages.
 *
 * Groups episodes by showTmdbId and computes watched/total/percent for each.
 */
export function aggregateSeriesProgress(
	episodes: EpisodeInput[],
): Record<number, SeriesProgressItem> {
	const counters = new Map<number, { total: number; watched: number }>();

	for (const ep of episodes) {
		const counter = counters.get(ep.showTmdbId) ?? { total: 0, watched: 0 };
		counter.total++;
		if (ep.watched) counter.watched++;
		counters.set(ep.showTmdbId, counter);
	}

	const progressMap: Record<number, SeriesProgressItem> = {};
	for (const [tmdbId, counter] of counters) {
		progressMap[tmdbId] = {
			total: counter.total,
			watched: counter.watched,
			percent: counter.total > 0 ? Math.round((counter.watched / counter.total) * 100) : 0,
		};
	}

	return progressMap;
}
