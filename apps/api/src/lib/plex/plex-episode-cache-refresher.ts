/**
 * Plex Episode Cache Refresher
 *
 * Fetches per-episode watch status for shows with recent activity.
 * Only refreshes shows that have been watched recently (not all shows)
 * to keep API call count bounded.
 */

import type { FastifyBaseLogger } from "fastify";
import type { PrismaClientInstance } from "../prisma.js";
import type { PlexClient } from "./plex-client.js";

const MAX_SHOWS_PER_REFRESH = 50;

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
): Promise<{ upserted: number; errors: number }> {
	let upserted = 0;
	let errors = 0;

	// Find shows with recent watch activity (have a ratingKey and non-zero watchCount)
	const recentlyWatchedShows = await prisma.plexCache.findMany({
		where: {
			instanceId,
			mediaType: "series",
			ratingKey: { not: null },
			watchCount: { gt: 0 },
		},
		orderBy: { lastWatchedAt: "desc" },
		take: MAX_SHOWS_PER_REFRESH,
		select: {
			tmdbId: true,
			ratingKey: true,
		},
	});

	if (recentlyWatchedShows.length === 0) {
		log.debug({ instanceId }, "No recently watched shows to refresh episodes for");
		return { upserted, errors };
	}

	// Deduplicate by tmdbId (same show may appear in multiple sections)
	const showMap = new Map<number, string>();
	for (const show of recentlyWatchedShows) {
		if (show.ratingKey && !showMap.has(show.tmdbId)) {
			showMap.set(show.tmdbId, show.ratingKey);
		}
	}

	// Fetch history for user attribution
	let historyMap: Map<string, { users: Set<string>; lastWatched: number }>;
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
				if (item.viewedAt > existing.lastWatched) {
					existing.lastWatched = item.viewedAt;
				}
			} else {
				historyMap.set(key, {
					users: new Set([userName]),
					lastWatched: item.viewedAt,
				});
			}
		}
	} catch (err) {
		log.warn({ err, instanceId }, "Failed to fetch history for episode cache refresh");
		return { upserted, errors: 1 };
	}

	// Process each show
	for (const [tmdbId, showRatingKey] of showMap) {
		try {
			const episodes = await client.getEpisodes(showRatingKey);

			for (const episode of episodes) {
				const watchData = historyMap.get(episode.ratingKey);
				const watched = episode.viewCount > 0 || !!watchData;
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
						},
						update: {
							ratingKey: episode.ratingKey,
							title: episode.title,
							watched,
							watchedByUsers: JSON.stringify(watchedByUsers),
							lastWatchedAt,
						},
					});
					upserted++;
				} catch (err) {
					errors++;
					if (errors <= 3) {
						log.warn(
							{ err, instanceId, tmdbId, episode: `S${episode.seasonNumber}E${episode.episodeNumber}` },
							"Failed to upsert episode cache entry",
						);
					}
				}
			}
		} catch (err) {
			errors++;
			log.warn(
				{ err, instanceId, tmdbId, showRatingKey },
				"Failed to fetch episodes for show",
			);
		}
	}

	log.info(
		{ instanceId, showCount: showMap.size, upserted, errors },
		"Plex episode cache refresh completed",
	);

	return { upserted, errors };
}
