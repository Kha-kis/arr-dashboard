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
			{ showTmdbId: 100, seasonNumber: 1, episodeNumber: 1, watched: true },
			{ showTmdbId: 100, seasonNumber: 1, episodeNumber: 2, watched: true },
			{ showTmdbId: 100, seasonNumber: 1, episodeNumber: 3, watched: true },
			{ showTmdbId: 100, seasonNumber: 1, episodeNumber: 4, watched: false },
			{ showTmdbId: 100, seasonNumber: 1, episodeNumber: 5, watched: false },
		];

		const result = aggregateSeriesProgress(episodes);
		expect(result[100]).toEqual({
			status: "exact",
			watchedSemantics: "exact",
			total: 5,
			watched: 3,
			percent: 60,
		});
	});

	it("returns 100% when all episodes are watched", () => {
		const episodes: EpisodeInput[] = [
			{ showTmdbId: 200, seasonNumber: 1, episodeNumber: 6, watched: true },
			{ showTmdbId: 200, seasonNumber: 1, episodeNumber: 7, watched: true },
			{ showTmdbId: 200, seasonNumber: 1, episodeNumber: 8, watched: true },
		];

		const result = aggregateSeriesProgress(episodes);
		expect(result[200]).toEqual({
			status: "exact",
			watchedSemantics: "exact",
			total: 3,
			watched: 3,
			percent: 100,
		});
	});

	it("returns 0% when no episodes are watched", () => {
		const episodes: EpisodeInput[] = [
			{ showTmdbId: 300, seasonNumber: 1, episodeNumber: 9, watched: false },
			{ showTmdbId: 300, seasonNumber: 1, episodeNumber: 10, watched: false },
		];

		const result = aggregateSeriesProgress(episodes);
		expect(result[300]).toEqual({
			status: "exact",
			watchedSemantics: "exact",
			total: 2,
			watched: 0,
			percent: 0,
		});
	});

	it("returns empty map for empty episodes array", () => {
		const result = aggregateSeriesProgress([]);
		expect(result).toEqual({});
	});

	it("groups episodes by showTmdbId into separate entries", () => {
		const episodes: EpisodeInput[] = [
			{ showTmdbId: 100, seasonNumber: 1, episodeNumber: 11, watched: true },
			{ showTmdbId: 100, seasonNumber: 1, episodeNumber: 12, watched: false },
			{ showTmdbId: 200, seasonNumber: 1, episodeNumber: 13, watched: true },
			{ showTmdbId: 200, seasonNumber: 1, episodeNumber: 14, watched: true },
			{ showTmdbId: 200, seasonNumber: 1, episodeNumber: 15, watched: true },
			{ showTmdbId: 300, seasonNumber: 1, episodeNumber: 16, watched: false },
		];

		const result = aggregateSeriesProgress(episodes);
		expect(result[100]).toEqual({
			status: "exact",
			watchedSemantics: "exact",
			total: 2,
			watched: 1,
			percent: 50,
		});
		expect(result[200]).toEqual({
			status: "exact",
			watchedSemantics: "exact",
			total: 3,
			watched: 3,
			percent: 100,
		});
		expect(result[300]).toEqual({
			status: "exact",
			watchedSemantics: "exact",
			total: 1,
			watched: 0,
			percent: 0,
		});
	});
	it("keeps only a lower bound when an episode coordinate is malformed", () => {
		const result = aggregateSeriesProgress(
			[
				{ showTmdbId: 42, seasonNumber: 1, episodeNumber: 1, watched: true },
				{ showTmdbId: 42, seasonNumber: -1, episodeNumber: 2, watched: true },
			],
			[42, 43],
		);
		expect(result[42]).toEqual({
			status: "partial",
			total: null,
			watched: 1,
			percent: null,
			watchedSemantics: "lower-bound",
		});
		expect(result[43]).toEqual({
			status: "unknown",
			total: null,
			watched: null,
			percent: null,
			watchedSemantics: "unknown",
		});
	});
});
