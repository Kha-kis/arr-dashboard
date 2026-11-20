import { evidenceFingerprint } from "../evidence-fingerprint.js";
import type { JellyfinSeriesProgressCoordinate } from "./jellyfin-mapped-series-progress.js";

export const MAX_JELLYFIN_MAPPED_PROGRESS_COORDINATES = 100_000;
// Two safe integers, the watched bit, separators, and the receipt envelope.
export const MAX_JELLYFIN_MAPPED_PROGRESS_JSON_LENGTH =
	40 * MAX_JELLYFIN_MAPPED_PROGRESS_COORDINATES + 100;

export type JellyfinMappedProgressContext = {
	instanceId: string;
	generationId: string;
	showTmdbId: number;
	connectionGeneration: number;
	identityGeneration: number;
	observedAt: Date;
	contentFingerprint: string;
};

type CoordinateTuple = [season: number, episode: number, watched: 0 | 1];

function validCoordinate(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function fingerprint(
	context: JellyfinMappedProgressContext,
	coordinates: readonly CoordinateTuple[],
) {
	return evidenceFingerprint([
		"jellyfin-mapped-progress-v1",
		context.instanceId,
		context.generationId,
		context.showTmdbId,
		context.connectionGeneration,
		context.identityGeneration,
		context.observedAt,
		context.contentFingerprint,
		coordinates,
	]);
}

function validTuples(tuples: readonly unknown[]): tuples is readonly CoordinateTuple[] {
	if (tuples.length > MAX_JELLYFIN_MAPPED_PROGRESS_COORDINATES) return false;
	let previousSeason = -1;
	let previousEpisode = -1;
	for (const tuple of tuples) {
		if (!Array.isArray(tuple) || tuple.length !== 3) return false;
		const [season, episode, watched] = tuple;
		if (!validCoordinate(season) || !validCoordinate(episode) || (watched !== 0 && watched !== 1))
			return false;
		if (season < previousSeason || (season === previousSeason && episode <= previousEpisode))
			return false;
		previousSeason = season;
		previousEpisode = episode;
	}
	return true;
}

export function encodeJellyfinMappedProgressReceipt(
	context: JellyfinMappedProgressContext,
	coordinates: readonly JellyfinSeriesProgressCoordinate[],
): string | null {
	if (coordinates.length > MAX_JELLYFIN_MAPPED_PROGRESS_COORDINATES) return null;
	const tuples: CoordinateTuple[] = coordinates.map(({ seasonNumber, episodeNumber, watched }) => [
		seasonNumber,
		episodeNumber,
		watched ? 1 : 0,
	]);
	return validTuples(tuples) ? JSON.stringify([1, fingerprint(context, tuples), tuples]) : null;
}

export function decodeJellyfinMappedProgressReceipt(
	context: JellyfinMappedProgressContext,
	json: string,
): JellyfinSeriesProgressCoordinate[] | null {
	if (json.length > MAX_JELLYFIN_MAPPED_PROGRESS_JSON_LENGTH) return null;
	try {
		const payload: unknown = JSON.parse(json);
		if (!Array.isArray(payload) || payload.length !== 3 || payload[0] !== 1) return null;
		const [, digest, tuples] = payload;
		if (!Array.isArray(tuples) || !validTuples(tuples) || digest !== fingerprint(context, tuples))
			return null;
		return tuples.map(([seasonNumber, episodeNumber, watched]) => ({
			seasonNumber,
			episodeNumber,
			watched: watched === 1,
		}));
	} catch {
		return null;
	}
}

export function jellyfinMappedProgressMatchesPositiveRows(
	coordinates: readonly JellyfinSeriesProgressCoordinate[],
	rows: readonly JellyfinSeriesProgressCoordinate[],
): boolean {
	const watched = new Set<string>();
	for (const coordinate of coordinates) {
		if (coordinate.watched) watched.add(`${coordinate.seasonNumber}:${coordinate.episodeNumber}`);
	}
	return (
		watched.size === rows.length &&
		rows.every((row) => row.watched && watched.delete(`${row.seasonNumber}:${row.episodeNumber}`))
	);
}
