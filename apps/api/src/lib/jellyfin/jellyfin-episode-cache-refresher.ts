/** Publishes a complete per-instance Jellyfin episode snapshot atomically. */

import type { FastifyBaseLogger } from "fastify";
import type { PrismaClient } from "../prisma.js";
import { getErrorMessage } from "../utils/error-message.js";
import type { JellyfinClient } from "./jellyfin-client.js";

export const JELLYFIN_EPISODE_MAX_SERIES = 50;

export async function refreshJellyfinEpisodeCache(
	client: JellyfinClient,
	prisma: PrismaClient,
	instanceId: string,
	log: FastifyBaseLogger,
): Promise<{ upserted: number; errors: number; complete: boolean; completedAt?: Date }> {
	try {
		const users = await client.getUsers();
		if (users.length === 0) {
			log.warn({ instanceId }, "Jellyfin episode refresh returned no users");
			return { upserted: 0, errors: 1, complete: false };
		}
		const recentSeries = await prisma.jellyfinCache.findMany({
			where: { instanceId, mediaType: "series", lastWatchedAt: { not: null } },
			orderBy: { lastWatchedAt: "desc" },
			take: JELLYFIN_EPISODE_MAX_SERIES + 1,
			select: { tmdbId: true, jellyfinId: true, title: true },
		});
		if (recentSeries.length > JELLYFIN_EPISODE_MAX_SERIES) {
			log.warn(
				{ instanceId, limit: JELLYFIN_EPISODE_MAX_SERIES },
				"Jellyfin episode inventory exceeded its safe series limit",
			);
			return { upserted: 0, errors: 1, complete: false };
		}

		const seriesByTmdbId = new Map<number, (typeof recentSeries)[number]>();
		for (const series of recentSeries) {
			if (!series.jellyfinId) {
				log.warn({ instanceId, tmdbId: series.tmdbId }, "Jellyfin series lacked an item id");
				return { upserted: 0, errors: 1, complete: false };
			}
			const existing = seriesByTmdbId.get(series.tmdbId);
			if (existing && existing.jellyfinId !== series.jellyfinId) {
				log.warn({ instanceId, tmdbId: series.tmdbId }, "Jellyfin series identity was ambiguous");
				return { upserted: 0, errors: 1, complete: false };
			}
			seriesByTmdbId.set(series.tmdbId, series);
		}

		const rows: Array<{
			instanceId: string;
			showTmdbId: number;
			seasonNumber: number;
			episodeNumber: number;
			jellyfinId: string;
			title: string;
			watched: boolean;
			watchedByUsers: string;
			lastWatchedAt: Date | null;
		}> = [];

		for (const series of [...seriesByTmdbId.values()].sort((a, b) => a.tmdbId - b.tmdbId)) {
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
				let episodes: Awaited<ReturnType<JellyfinClient["getEpisodes"]>>;
				try {
					episodes = await client.getEpisodes(user.id, series.jellyfinId!);
				} catch (error) {
					log.warn(
						{ err: error, instanceId, seriesId: series.jellyfinId, userId: user.id },
						"Failed to prove complete Jellyfin episode inventory",
					);
					return { upserted: 0, errors: 1, complete: false };
				}
				const seenCoordinates = new Set<string>();
				for (const episode of episodes) {
					const seasonNumber = episode.seasonNumber;
					const episodeNumber = episode.episodeNumber;
					if (
						!Number.isSafeInteger(seasonNumber) ||
						seasonNumber === undefined ||
						seasonNumber < 0 ||
						!Number.isSafeInteger(episodeNumber) ||
						episodeNumber === undefined ||
						episodeNumber <= 0
					) {
						return { upserted: 0, errors: 1, complete: false };
					}
					const key = `${seasonNumber}:${episodeNumber}`;
					if (seenCoordinates.has(key)) return { upserted: 0, errors: 1, complete: false };
					seenCoordinates.add(key);
					const entry = episodeMap.get(key);
					if (entry && entry.jellyfinId !== episode.id) {
						return { upserted: 0, errors: 1, complete: false };
					}
					const current = entry ?? {
						jellyfinId: episode.id,
						seasonNumber,
						episodeNumber,
						title: episode.name,
						watched: false,
						watchedByUsers: new Set<string>(),
						lastWatchedAt: null,
					};
					if (episode.played) {
						current.watched = true;
						current.watchedByUsers.add(user.name);
						if (episode.lastPlayedDate) {
							const playedAt = new Date(episode.lastPlayedDate);
							if (Number.isNaN(playedAt.getTime())) {
								return { upserted: 0, errors: 1, complete: false };
							}
							if (!current.lastWatchedAt || playedAt > current.lastWatchedAt) {
								current.lastWatchedAt = playedAt;
							}
						}
					}
					episodeMap.set(key, current);
				}
			}
			for (const episode of [...episodeMap.values()].sort(
				(a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber,
			)) {
				rows.push({
					instanceId,
					showTmdbId: series.tmdbId,
					seasonNumber: episode.seasonNumber,
					episodeNumber: episode.episodeNumber,
					jellyfinId: episode.jellyfinId,
					title: episode.title,
					watched: episode.watched,
					watchedByUsers: JSON.stringify([...episode.watchedByUsers].sort()),
					lastWatchedAt: episode.lastWatchedAt,
				});
			}
		}

		const completedAt = new Date();
		await prisma.$transaction(async (tx) => {
			await tx.jellyfinEpisodeCache.deleteMany({ where: { instanceId } });
			if (rows.length > 0) await tx.jellyfinEpisodeCache.createMany({ data: rows });
			await tx.cacheRefreshStatus.upsert({
				where: { instanceId_cacheType: { instanceId, cacheType: "jellyfin_episode" } },
				create: {
					instanceId,
					cacheType: "jellyfin_episode",
					lastRefreshedAt: completedAt,
					lastResult: "success",
					itemCount: rows.length,
					lastAttemptAt: completedAt,
					lastAttemptResult: "success",
				},
				update: {
					lastRefreshedAt: completedAt,
					lastResult: "success",
					lastErrorMessage: null,
					itemCount: rows.length,
					lastAttemptAt: completedAt,
					lastAttemptResult: "success",
					lastAttemptErrorMessage: null,
				},
			});
		});
		return { upserted: rows.length, errors: 0, complete: true, completedAt };
	} catch (error) {
		log.error(
			{ err: error, instanceId },
			`Jellyfin episode cache refresh failed: ${getErrorMessage(error)}`,
		);
		return { upserted: 0, errors: 1, complete: false };
	}
}
