/**
 * User Episode Completion Helpers
 *
 * Pure functions for computing per-user episode completion percentages
 * from PlexEpisodeCache data.
 */

import type { UserEpisodeCompletion } from "@arr/shared";

/** PlexEpisodeCache row shape for completion analysis */
export interface EpisodeCacheEntry {
	showTmdbId: number;
	watched: boolean;
	watchedByUsers: string; // JSON array of usernames
}

/**
 * Compute per-user episode completion for a set of shows.
 */
export interface EpisodeCompletionResult extends UserEpisodeCompletion {
	parseFailures: number;
	totalEpisodes: number;
	failedPreviews: string[];
}

export function aggregateUserEpisodeCompletion(
	episodes: EpisodeCacheEntry[],
): EpisodeCompletionResult {
	// Group episodes by show
	const showMap = new Map<number, EpisodeCacheEntry[]>();
	for (const ep of episodes) {
		const list = showMap.get(ep.showTmdbId) ?? [];
		list.push(ep);
		showMap.set(ep.showTmdbId, list);
	}

	let parseFailures = 0;
	const failedPreviews: string[] = [];

	const shows = [...showMap.entries()].map(([tmdbId, showEpisodes]) => {
		const totalEpisodes = showEpisodes.length;

		// Collect all users who appear in any watchedByUsers
		const userWatchCounts = new Map<string, number>();
		for (const ep of showEpisodes) {
			let users: string[] = [];
			try {
				const parsed = JSON.parse(ep.watchedByUsers);
				if (Array.isArray(parsed)) users = parsed;
			} catch {
				parseFailures++;
				if (failedPreviews.length < 5)
					failedPreviews.push(`watchedByUsers: ${ep.watchedByUsers.slice(0, 80)}`);
			}

			for (const user of users) {
				userWatchCounts.set(user, (userWatchCounts.get(user) ?? 0) + 1);
			}
		}

		const users = [...userWatchCounts.entries()]
			.map(([username, watched]) => ({
				username,
				watched,
				total: totalEpisodes,
				percent: totalEpisodes > 0 ? Math.round((watched / totalEpisodes) * 1000) / 10 : 0,
			}))
			.sort((a, b) => b.percent - a.percent);

		return { tmdbId, users };
	});

	return { shows, parseFailures, totalEpisodes: episodes.length, failedPreviews };
}
