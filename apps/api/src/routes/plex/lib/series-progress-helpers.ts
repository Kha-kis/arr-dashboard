import type { SeriesProgressItem } from "@arr/shared";

/** Coordinates identify an episode across connections to the same library. */
export interface EpisodeInput {
	showTmdbId: number;
	seasonNumber: number;
	episodeNumber: number;
	watched: boolean;
}

export function aggregateSeriesProgress(
	episodes: EpisodeInput[],
	requestedIds: readonly number[] = [...new Set(episodes.map((episode) => episode.showTmdbId))],
	complete = true,
): Record<number, SeriesProgressItem> {
	const selected = new Set(requestedIds);
	const coordinates = new Map<number, Map<string, boolean>>();
	const malformed = new Set<number>();
	for (const episode of episodes) {
		if (!selected.has(episode.showTmdbId)) continue;
		if (
			!Number.isSafeInteger(episode.seasonNumber) ||
			episode.seasonNumber < 0 ||
			!Number.isSafeInteger(episode.episodeNumber) ||
			episode.episodeNumber < 0 ||
			typeof episode.watched !== "boolean"
		) {
			malformed.add(episode.showTmdbId);
			continue;
		}
		const show = coordinates.get(episode.showTmdbId) ?? new Map<string, boolean>();
		const key = `${episode.seasonNumber}:${episode.episodeNumber}`;
		show.set(key, show.get(key) === true || episode.watched);
		coordinates.set(episode.showTmdbId, show);
	}
	const progress: Record<number, SeriesProgressItem> = {};
	for (const tmdbId of requestedIds) {
		const show = coordinates.get(tmdbId);
		const watched = show ? [...show.values()].filter(Boolean).length : 0;
		if (complete && !malformed.has(tmdbId) && show && show.size > 0) {
			progress[tmdbId] = {
				status: "exact",
				total: show.size,
				watched,
				percent: Math.round((watched / show.size) * 100),
				watchedSemantics: "exact",
			};
		} else if (watched > 0) {
			progress[tmdbId] = {
				status: "partial",
				total: null,
				watched,
				percent: null,
				watchedSemantics: "lower-bound",
			};
		} else {
			progress[tmdbId] = {
				status: "unknown",
				total: null,
				watched: null,
				percent: null,
				watchedSemantics: "unknown",
			};
		}
	}
	return progress;
}
