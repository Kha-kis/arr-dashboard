/**
 * Jellyfin Episode Cache Refresher
 *
 * Fetches per-episode watch status for recently-watched series
 * and upserts into JellyfinEpisodeCache.
 *
 * Strategy:
 * 1. Query JellyfinCache for recently watched series (by lastWatchedAt)
 * 2. For each series, get episodes via Jellyfin API
 * 3. Aggregate watch status across all users
 * 4. Upsert into JellyfinEpisodeCache
 */

import type { FastifyBaseLogger } from "fastify";
import type { PrismaClient } from "../prisma.js";
import type { JellyfinClient } from "./jellyfin-client.js";

const MAX_SERIES = 50;

export async function refreshJellyfinEpisodeCache(
	client: JellyfinClient,
	prisma: PrismaClient,
	instanceId: string,
	log: FastifyBaseLogger,
): Promise<{ upserted: number; errors: number }> {
	let upserted = 0;
	let errors = 0;

	try {
		// Get users for cross-user watch aggregation
		const users = await client.getUsers();
		if (users.length === 0) return { upserted: 0, errors: 0 };

		// Get recently watched series from JellyfinCache
		const recentSeries = await prisma.jellyfinCache.findMany({
			where: {
				instanceId,
				mediaType: "series",
				lastWatchedAt: { not: null },
			},
			orderBy: { lastWatchedAt: "desc" },
			take: MAX_SERIES,
			select: {
				tmdbId: true,
				jellyfinId: true,
				title: true,
			},
		});

		// Deduplicate by tmdbId
		const seen = new Set<number>();
		const uniqueSeries = recentSeries.filter((s) => {
			if (!s.jellyfinId || seen.has(s.tmdbId)) return false;
			seen.add(s.tmdbId);
			return true;
		});

		for (const series of uniqueSeries) {
			if (!series.jellyfinId) continue;

			try {
				// Aggregate episode watch status across all users
				const episodeMap = new Map<
					string,
					{
						jellyfinId: string;
						seasonNumber: number;
						episodeNumber: number;
						title: string;
						watched: boolean;
						watchedByUsers: Set<string>;
						lastWatchedAt: Date | null;
					}
				>();

				for (const user of users) {
					try {
						const episodes = await client.getEpisodes(user.id, series.jellyfinId!);

						for (const ep of episodes) {
							if (!ep.seasonNumber || !ep.episodeNumber) continue;

							const key = `${ep.seasonNumber}:${ep.episodeNumber}`;
							let entry = episodeMap.get(key);
							if (!entry) {
								entry = {
									jellyfinId: ep.id,
									seasonNumber: ep.seasonNumber,
									episodeNumber: ep.episodeNumber,
									title: ep.name,
									watched: false,
									watchedByUsers: new Set(),
									lastWatchedAt: null,
								};
								episodeMap.set(key, entry);
							}

							if (ep.played) {
								entry.watched = true;
								entry.watchedByUsers.add(user.name);
								if (ep.lastPlayedDate) {
									const d = new Date(ep.lastPlayedDate);
									if (!entry.lastWatchedAt || d > entry.lastWatchedAt) {
										entry.lastWatchedAt = d;
									}
								}
							}
						}
					} catch {
						// Per-user episode fetch failure — skip, don't fail the series
					}
				}

				// Upsert episodes
				const episodeEntries = Array.from(episodeMap.values());
				if (episodeEntries.length > 0) {
					await prisma.$transaction(
						episodeEntries.map((ep) =>
							prisma.jellyfinEpisodeCache.upsert({
								where: {
									instanceId_showTmdbId_seasonNumber_episodeNumber: {
										instanceId,
										showTmdbId: series.tmdbId,
										seasonNumber: ep.seasonNumber,
										episodeNumber: ep.episodeNumber,
									},
								},
								create: {
									instanceId,
									showTmdbId: series.tmdbId,
									seasonNumber: ep.seasonNumber,
									episodeNumber: ep.episodeNumber,
									jellyfinId: ep.jellyfinId,
									title: ep.title,
									watched: ep.watched,
									watchedByUsers: JSON.stringify([...ep.watchedByUsers]),
									lastWatchedAt: ep.lastWatchedAt,
								},
								update: {
									jellyfinId: ep.jellyfinId,
									title: ep.title,
									watched: ep.watched,
									watchedByUsers: JSON.stringify([...ep.watchedByUsers]),
									lastWatchedAt: ep.lastWatchedAt,
								},
							}),
						),
					);
					upserted += episodeEntries.length;
				}
			} catch (err) {
				errors++;
				log.warn(
					{ err, seriesId: series.jellyfinId, title: series.title },
					"Failed to refresh Jellyfin episode cache for series",
				);
			}
		}
	} catch (err) {
		errors++;
		log.error({ err, instanceId }, "Jellyfin episode cache refresh failed");
	}

	return { upserted, errors };
}
