import type { FastifyBaseLogger } from "fastify";
import { getErrorMessage } from "../utils/error-message.js";
import type { PlexClient, PlexEpisodeItem } from "./plex-client.js";

const MAX_SHOWS_PER_REFRESH = 50;
const REFRESHES_PER_FRESHNESS_WINDOW = 4;
const MAX_COMPLETE_SHOWS = MAX_SHOWS_PER_REFRESH * REFRESHES_PER_FRESHNESS_WINDOW;
const MAX_HISTORY_RESULTS = 100_000;

export type PlexEpisodeRow = {
	instanceId: string;
	showTmdbId: number;
	seasonNumber: number;
	episodeNumber: number;
	ratingKey: string;
	title: string;
	watched: boolean;
	watchedByUsers: string;
	lastWatchedAt: Date | null;
	watchCount: number;
	refreshedAt: Date;
	sourceFingerprint: string;
};

export interface CollectedPlexEpisodeRefresh {
	upserted: number;
	errors: number;
	errorMessages: string[];
	eligibleShows: number;
	refreshedShows: number;
	coverageIncomplete: boolean;
	capacityDegraded: boolean;
	complete: boolean;
	completedAt?: Date;
	rows?: PlexEpisodeRow[];
}

function failedResult(
	errorMessages: string[],
	eligibleShows: number,
	refreshedShows: number,
	capacityDegraded = false,
): CollectedPlexEpisodeRefresh {
	return {
		upserted: 0,
		errors: Math.max(1, errorMessages.length),
		errorMessages,
		eligibleShows,
		refreshedShows,
		coverageIncomplete: true,
		capacityDegraded,
		complete: false,
	};
}

export async function collectPlexEpisodeLiveEvidence(
	client: PlexClient,
	showMap: Map<number, Set<string>>,
	instanceId: string,
	log: FastifyBaseLogger,
	sourceFingerprint: string,
): Promise<CollectedPlexEpisodeRefresh> {
	const eligibleShows = showMap.size;
	if (eligibleShows > MAX_COMPLETE_SHOWS) {
		const message = `Plex episode inventory exceeded ${MAX_COMPLETE_SHOWS} eligible shows`;
		log.warn({ instanceId, eligibleShows, limit: MAX_COMPLETE_SHOWS }, message);
		return failedResult([message], eligibleShows, 0, true);
	}

	const errorMessages: string[] = [];
	let history: Awaited<ReturnType<PlexClient["getHistory"]>>;
	try {
		history = await client.getHistory({
			maxResults: MAX_HISTORY_RESULTS,
			requireComplete: true,
		});
	} catch (error) {
		const message = `Failed to prove complete Plex history: ${getErrorMessage(error)}`;
		log.warn({ err: error, instanceId }, message);
		return failedResult([message], eligibleShows, 0);
	}

	let accounts: Awaited<ReturnType<PlexClient["getAccounts"]>> = [];
	if (history.some((entry) => entry.type === "episode")) {
		try {
			accounts = await client.getAccounts();
		} catch (error) {
			const message = `Failed to prove complete Plex accounts: ${getErrorMessage(error)}`;
			log.warn({ err: error, instanceId }, message);
			return failedResult([message], eligibleShows, 0);
		}
	}
	const accountMap = new Map(accounts.map((account) => [account.id, account.name]));
	const historyMap = new Map<
		string,
		{ users: Set<string>; lastWatched: number; eventCount: number }
	>();
	for (const item of history) {
		if (item.type !== "episode") continue;
		const userName = accountMap.get(item.accountID);
		if (!userName?.trim()) {
			const message = `Plex history account ${item.accountID} was absent from the complete account inventory`;
			return failedResult([message], eligibleShows, 0);
		}
		const current = historyMap.get(item.ratingKey);
		if (current) {
			current.users.add(userName);
			current.lastWatched = Math.max(current.lastWatched, item.viewedAt);
			current.eventCount++;
		} else {
			historyMap.set(item.ratingKey, {
				users: new Set([userName]),
				lastWatched: item.viewedAt,
				eventCount: 1,
			});
		}
	}

	const rows: PlexEpisodeRow[] = [];
	const completedAt = new Date();
	let refreshedShows = 0;

	for (const [tmdbId, ratingKeys] of [...showMap.entries()].sort(([a], [b]) => a - b)) {
		const copies: PlexEpisodeItem[] = [];
		for (const ratingKey of [...ratingKeys].sort()) {
			try {
				copies.push(...(await client.getEpisodes(ratingKey)));
			} catch (error) {
				const message = `Failed to fetch episodes for show tmdb:${tmdbId} copy:${ratingKey}: ${getErrorMessage(error)}`;
				errorMessages.push(message);
				log.warn({ err: error, instanceId, tmdbId, ratingKey }, message);
			}
		}
		if (errorMessages.length > 0) continue;
		refreshedShows++;

		const byCoordinate = new Map<string, PlexEpisodeItem[]>();
		for (const episode of copies) {
			const coordinate = `${episode.seasonNumber}:${episode.episodeNumber}`;
			const episodeCopies = byCoordinate.get(coordinate) ?? [];
			episodeCopies.push(episode);
			byCoordinate.set(coordinate, episodeCopies);
		}
		for (const episodeCopies of [...byCoordinate.values()].sort(
			([left], [right]) =>
				left!.seasonNumber - right!.seasonNumber || left!.episodeNumber - right!.episodeNumber,
		)) {
			const episode = [...episodeCopies].sort((left, right) => {
				const leftCount = Number.isSafeInteger(left.viewCount) ? (left.viewCount ?? 0) : 0;
				const rightCount = Number.isSafeInteger(right.viewCount) ? (right.viewCount ?? 0) : 0;
				return rightCount - leftCount || left.ratingKey.localeCompare(right.ratingKey);
			})[0]!;
			const watchCount = Math.max(0, episode.viewCount ?? 0);
			const evidence = episodeCopies
				.map((copy) => historyMap.get(copy.ratingKey))
				.filter((entry) => entry !== undefined);
			const lastWatched = Math.max(
				...evidence.map((entry) => entry.lastWatched),
				...episodeCopies.map((copy) => copy.lastViewedAt ?? 0),
				0,
			);
			rows.push({
				instanceId,
				showTmdbId: tmdbId,
				seasonNumber: episode.seasonNumber,
				episodeNumber: episode.episodeNumber,
				ratingKey: episode.ratingKey,
				title: episode.title,
				watched: watchCount > 0 || evidence.some((entry) => entry.eventCount > 0),
				watchedByUsers: JSON.stringify(
					[...new Set(evidence.flatMap((entry) => [...entry.users]))].sort(),
				),
				lastWatchedAt: lastWatched > 0 ? new Date(lastWatched * 1000) : null,
				watchCount,
				refreshedAt: completedAt,
				sourceFingerprint,
			});
		}
	}

	if (errorMessages.length > 0 || refreshedShows !== eligibleShows) {
		return failedResult(errorMessages, eligibleShows, refreshedShows);
	}

	try {
		await client.verifyHistorySnapshot(history);
	} catch (error) {
		const message = `Failed to revalidate Plex history before publication: ${getErrorMessage(error)}`;
		log.warn({ err: error, instanceId }, message);
		return failedResult([message], eligibleShows, refreshedShows);
	}

	return {
		upserted: 0,
		errors: 0,
		errorMessages: [],
		eligibleShows,
		refreshedShows,
		coverageIncomplete: false,
		capacityDegraded: false,
		complete: true,
		completedAt,
		rows,
	};
}
