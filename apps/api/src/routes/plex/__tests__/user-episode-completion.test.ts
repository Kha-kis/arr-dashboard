import { describe, expect, it } from "vitest";
import { aggregateUserEpisodeCompletion, type EpisodeCacheEntry } from "../lib/user-episode-helpers.js";

function episode(overrides: Partial<EpisodeCacheEntry> = {}): EpisodeCacheEntry {
	return {
		showTmdbId: 1234,
		watched: false,
		watchedByUsers: "[]",
		...overrides,
	};
}

describe("aggregateUserEpisodeCompletion", () => {
	it("computes per-user completion for a show", () => {
		const episodes = [
			episode({ showTmdbId: 100, watched: true, watchedByUsers: '["alice", "bob"]' }),
			episode({ showTmdbId: 100, watched: true, watchedByUsers: '["alice"]' }),
			episode({ showTmdbId: 100, watched: false, watchedByUsers: "[]" }),
		];

		const result = aggregateUserEpisodeCompletion(episodes);
		expect(result.shows).toHaveLength(1);
		const show = result.shows[0]!;
		expect(show.tmdbId).toBe(100);

		const alice = show.users.find((u) => u.username === "alice");
		expect(alice?.watched).toBe(2);
		expect(alice?.total).toBe(3);
		expect(alice?.percent).toBe(66.7);

		const bob = show.users.find((u) => u.username === "bob");
		expect(bob?.watched).toBe(1);
		expect(bob?.percent).toBe(33.3);
	});

	it("groups episodes by show", () => {
		const episodes = [
			episode({ showTmdbId: 100, watchedByUsers: '["alice"]' }),
			episode({ showTmdbId: 200, watchedByUsers: '["bob"]' }),
		];

		const result = aggregateUserEpisodeCompletion(episodes);
		expect(result.shows).toHaveLength(2);
	});

	it("returns empty for no episodes", () => {
		const result = aggregateUserEpisodeCompletion([]);
		expect(result.shows).toEqual([]);
	});

	it("handles malformed watchedByUsers JSON", () => {
		const episodes = [episode({ watchedByUsers: "bad-json" })];
		const result = aggregateUserEpisodeCompletion(episodes);
		expect(result.shows[0]?.users).toEqual([]);
	});
});
