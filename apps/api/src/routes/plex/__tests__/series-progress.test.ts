/**
 * Series Progress Aggregation Tests
 *
 * Tests for the pure aggregateSeriesProgress helper that computes
 * watched/total/percent for each series from episode cache entries.
 *
 * Run with: npx vitest run series-progress.test.ts
 */

import { describe, expect, it } from "vitest";
import { aggregateSeriesProgress, type EpisodeInput } from "../lib/series-progress-helpers.js";

describe("aggregateSeriesProgress", () => {
	it("computes correct progress for a single show (3/5 watched)", () => {
		const episodes: EpisodeInput[] = [
			{ showTmdbId: 100, watched: true },
			{ showTmdbId: 100, watched: true },
			{ showTmdbId: 100, watched: true },
			{ showTmdbId: 100, watched: false },
			{ showTmdbId: 100, watched: false },
		];

		const result = aggregateSeriesProgress(episodes);
		expect(result[100]).toEqual({ total: 5, watched: 3, percent: 60 });
	});

	it("returns 100% when all episodes are watched", () => {
		const episodes: EpisodeInput[] = [
			{ showTmdbId: 200, watched: true },
			{ showTmdbId: 200, watched: true },
			{ showTmdbId: 200, watched: true },
		];

		const result = aggregateSeriesProgress(episodes);
		expect(result[200]).toEqual({ total: 3, watched: 3, percent: 100 });
	});

	it("returns 0% when no episodes are watched", () => {
		const episodes: EpisodeInput[] = [
			{ showTmdbId: 300, watched: false },
			{ showTmdbId: 300, watched: false },
		];

		const result = aggregateSeriesProgress(episodes);
		expect(result[300]).toEqual({ total: 2, watched: 0, percent: 0 });
	});

	it("returns empty map for empty episodes array", () => {
		const result = aggregateSeriesProgress([]);
		expect(result).toEqual({});
	});

	it("groups episodes by showTmdbId into separate entries", () => {
		const episodes: EpisodeInput[] = [
			{ showTmdbId: 100, watched: true },
			{ showTmdbId: 100, watched: false },
			{ showTmdbId: 200, watched: true },
			{ showTmdbId: 200, watched: true },
			{ showTmdbId: 200, watched: true },
			{ showTmdbId: 300, watched: false },
		];

		const result = aggregateSeriesProgress(episodes);
		expect(result[100]).toEqual({ total: 2, watched: 1, percent: 50 });
		expect(result[200]).toEqual({ total: 3, watched: 3, percent: 100 });
		expect(result[300]).toEqual({ total: 1, watched: 0, percent: 0 });
	});
});
