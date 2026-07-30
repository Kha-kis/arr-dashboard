/**
 * Plex Episode Cache Refresher
 *
 * Fetches per-episode watch status for shows with recent activity.
 * Only refreshes shows that have been watched recently (not all shows)
 * to keep API call count bounded.
 */

import type { FastifyBaseLogger } from "fastify";
import type { PrismaClientInstance } from "../prisma.js";
import { getErrorMessage } from "../utils/error-message.js";
import type { PlexClient } from "./plex-client.js";

const MAX_SHOWS_PER_REFRESH = 50;
const REFRESHES_PER_FRESHNESS_WINDOW = 4;

/**
 * Refresh episode-level watch data for recently-watched shows on a single Plex instance.
 *
 * Strategy:
 * 1. Query PlexCache for shows with recent watch activity on this instance
 * 2. For each show, fetch all episodes from Plex
 * 3. Cross-reference with history to determine watched status
 * 4. Upsert into PlexEpisodeCache
 */
export async function refreshPlexEpisodeCache(
	client: PlexClient,
	prisma: PrismaClientInstance,
	instanceId: string,
	log: FastifyBaseLogger,
	sourceFingerprint: string,
): Promise<{
	upserted: number;
	errors: number;
	errorMessages: string[];
	eligibleShows: number;
	refreshedShows: number;
	coverageIncomplete: boolean;
	capacityDegraded: boolean;
}> {
	let upserted = 0;
	let errors = 0;
	const errorMessages: string[] = [];

	// Find shows with recent watch activity (have a ratingKey and non-zero watchCount)
	const recentlyWatchedShows = await prisma.plexCache.findMany({
		where: {
			instanceId,
			mediaType: "series",
			ratingKey: { not: null },
			watchCount: { gt: 0 },
		},
		orderBy: { lastWatchedAt: "desc" },
		select: {
			tmdbId: true,
			ratingKey: true,
		},
	});

	if (recentlyWatchedShows.length === 0) {
		log.debug({ instanceId }, "No recently watched shows to refresh episodes for");
		return {
			upserted,
			errors,
			errorMessages,
			eligibleShows: 0,
			refreshedShows: 0,
			coverageIncomplete: false,
			capacityDegraded: false,
		};
	}

	// Deduplicate by tmdbId (same show may appear in multiple sections)
	const showMap = new Map<number, string>();
	for (const show of recentlyWatchedShows) {
		if (show.ratingKey && !showMap.has(show.tmdbId)) {
			showMap.set(show.tmdbId, show.ratingKey);
		}
	}
	const eligibleShows = showMap.size;

	// Rotate the bounded batch toward shows with the oldest episode evidence.
	// This guarantees eventual coverage instead of permanently refreshing only
	// the same newest 50 watched shows.
	const existingRefreshes = await prisma.plexEpisodeCache.groupBy({
		by: ["showTmdbId"],
		where: {
			instanceId,
			showTmdbId: { in: [...showMap.keys()] },
		},
		_max: { refreshedAt: true },
	});
	const newestRefreshByShow = new Map<number, number>();
	for (const row of existingRefreshes) {
		if (row._max.refreshedAt) {
			newestRefreshByShow.set(row.showTmdbId, row._max.refreshedAt.getTime());
		}
	}
	const selectedShows = [...showMap.entries()]
		.sort(([leftTmdbId], [rightTmdbId]) => {
			const leftRefresh = newestRefreshByShow.get(leftTmdbId) ?? Number.NEGATIVE_INFINITY;
			const rightRefresh = newestRefreshByShow.get(rightTmdbId) ?? Number.NEGATIVE_INFINITY;
			return leftRefresh - rightRefresh;
		})
		.slice(0, MAX_SHOWS_PER_REFRESH);
	const coverageIncomplete = eligibleShows > selectedShows.length;
	const capacityDegraded =
		eligibleShows > MAX_SHOWS_PER_REFRESH * REFRESHES_PER_FRESHNESS_WINDOW;

	// Fetch history for user attribution
	let historyMap: Map<string, { users: Set<string>; lastWatched: number; eventCount: number }>;
	try {
		const history = await client.getHistory({ maxResults: 5000 });
		const accounts = await client.getAccounts();
		const accountMap = new Map(accounts.map((a) => [a.id, a.name]));

		historyMap = new Map();
		for (const item of history) {
			if (item.type !== "episode") continue;
			const key = item.ratingKey;
			const existing = historyMap.get(key);
			const userName = accountMap.get(item.accountID) ?? `Account ${item.accountID}`;
			if (existing) {
				existing.users.add(userName);
				existing.eventCount++;
				if (item.viewedAt > existing.lastWatched) {
					existing.lastWatched = item.viewedAt;
				}
			} else {
				historyMap.set(key, {
					users: new Set([userName]),
					lastWatched: item.viewedAt,
					eventCount: 1,
				});
			}
		}
	} catch (err) {
		log.warn({ err, instanceId }, "Failed to fetch history for episode cache refresh");
		errorMessages.push(`Failed to fetch history: ${getErrorMessage(err)}`);
		return {
			upserted,
			errors: 1,
			errorMessages,
			eligibleShows,
			refreshedShows: 0,
			coverageIncomplete,
			capacityDegraded,
		};
	}

	// Process each show
	const refreshedAt = new Date();
	let refreshedShows = 0;
	for (const [tmdbId, showRatingKey] of selectedShows) {
		try {
			const episodes = await client.getEpisodes(showRatingKey);
			refreshedShows++;

			for (const episode of episodes) {
				const watchData = historyMap.get(episode.ratingKey);
				const plexViewCount =
					Number.isInteger(episode.viewCount) && episode.viewCount > 0 ? episode.viewCount : 0;
				// History is bounded, so its event count is a lower bound. Plex's
				// episode viewCount may contain events outside that window; taking
				// the maximum never invents a play while preserving either positive
				// witness.
				const watchCount = Math.max(plexViewCount, watchData?.eventCount ?? 0);
				const watched = watchCount > 0;
				const watchedByUsers = watchData ? [...watchData.users] : [];
				const lastWatchedAt = watchData
					? new Date(watchData.lastWatched * 1000)
					: episode.lastViewedAt
						? new Date(episode.lastViewedAt * 1000)
						: null;

				try {
					await prisma.plexEpisodeCache.upsert({
						where: {
							instanceId_showTmdbId_seasonNumber_episodeNumber: {
								instanceId,
								showTmdbId: tmdbId,
								seasonNumber: episode.seasonNumber,
								episodeNumber: episode.episodeNumber,
							},
						},
						create: {
							instanceId,
							showTmdbId: tmdbId,
							seasonNumber: episode.seasonNumber,
							episodeNumber: episode.episodeNumber,
							ratingKey: episode.ratingKey,
							title: episode.title,
							watched,
							watchedByUsers: JSON.stringify(watchedByUsers),
							lastWatchedAt,
							watchCount,
							refreshedAt,
							sourceFingerprint,
						},
						update: {
							ratingKey: episode.ratingKey,
							title: episode.title,
							watched,
							watchedByUsers: JSON.stringify(watchedByUsers),
							lastWatchedAt,
							watchCount,
							refreshedAt,
							sourceFingerprint,
						},
					});
					upserted++;
				} catch (err) {
					errors++;
					if (errors <= 3) {
						log.warn(
							{
								err,
								instanceId,
								tmdbId,
								episode: `S${episode.seasonNumber}E${episode.episodeNumber}`,
							},
							"Failed to upsert episode cache entry",
						);
					}
					if (errorMessages.length < 5) {
						errorMessages.push(
							`Failed to upsert S${episode.seasonNumber}E${episode.episodeNumber}: ${getErrorMessage(err)}`,
						);
					}
				}
			}
		} catch (err) {
			errors++;
			log.warn({ err, instanceId, tmdbId, showRatingKey }, "Failed to fetch episodes for show");
			if (errorMessages.length < 5) {
				errorMessages.push(
					`Failed to fetch episodes for show tmdb:${tmdbId}: ${getErrorMessage(err)}`,
				);
			}
		}
	}

	log.info(
		{
			instanceId,
			eligibleShows,
			refreshedShows,
			coverageIncomplete,
			capacityDegraded,
			upserted,
			errors,
		},
		"Plex episode cache refresh completed",
	);

	return {
		upserted,
		errors,
		errorMessages,
		eligibleShows,
		refreshedShows,
		coverageIncomplete,
		capacityDegraded,
	};
}
