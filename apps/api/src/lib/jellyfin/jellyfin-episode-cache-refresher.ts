/** Publishes a complete per-instance Jellyfin episode snapshot atomically. */

import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { recordCacheRefreshFailure } from "../cache-refresh-status.js";
import type { PrismaClient } from "../prisma.js";
import { getErrorMessage } from "../utils/error-message.js";
import { withCurrentJellyfinConnection } from "./jellyfin-connection-guard.js";
import type { JellyfinClient } from "./jellyfin-client.js";

export const JELLYFIN_EPISODE_MAX_SERIES = 50;

export type JellyfinEpisodeRefreshResult = {
	upserted: number;
	errors: number;
	complete: boolean;
	completedAt?: Date;
	superseded?: boolean;
};

export async function refreshJellyfinEpisodeCache(
	client: JellyfinClient,
	prisma: PrismaClient,
	instanceId: string,
	log: FastifyBaseLogger,
	expectedConnectionFingerprint: string,
): Promise<JellyfinEpisodeRefreshResult> {
	const result = await refreshJellyfinEpisodeCacheInternal(
		client,
		prisma,
		instanceId,
		log,
		expectedConnectionFingerprint,
	);
	if (!result.complete && !result.superseded) {
		const failureStatus = await recordJellyfinEpisodeCacheRefreshFailure(
			prisma,
			instanceId,
			expectedConnectionFingerprint,
			"Jellyfin episode refresh did not produce a complete generation",
			log,
		);
		if (failureStatus === "superseded") return { ...result, errors: 0, superseded: true };
	}
	return result;
}

export async function recordJellyfinEpisodeCacheRefreshFailure(
	prisma: PrismaClient,
	instanceId: string,
	expectedConnectionFingerprint: string,
	message: string,
	log: FastifyBaseLogger,
): Promise<"recorded" | "superseded" | "failed"> {
	try {
		const guarded = await withCurrentJellyfinConnection(
			prisma,
			instanceId,
			expectedConnectionFingerprint,
			async (tx) =>
				await recordCacheRefreshFailure(tx, instanceId, "jellyfin_episode", message.slice(0, 500)),
		);
		return guarded.matched ? "recorded" : "superseded";
	} catch (statusError) {
		log.warn(
			{ err: statusError, instanceId },
			"Failed to record Jellyfin episode cache refresh failure status",
		);
		return "failed";
	}
}

async function refreshJellyfinEpisodeCacheInternal(
	client: JellyfinClient,
	prisma: PrismaClient,
	instanceId: string,
	log: FastifyBaseLogger,
	expectedConnectionFingerprint: string,
): Promise<JellyfinEpisodeRefreshResult> {
	try {
		const users = await client.getUsers();
		if (users.length === 0) {
			log.warn({ instanceId }, "Jellyfin episode refresh returned no users");
			return { upserted: 0, errors: 1, complete: false };
		}
		const parentStatus = await prisma.cacheRefreshStatus.findUnique({
			where: { instanceId_cacheType: { instanceId, cacheType: "jellyfin" } },
			select: { generationId: true, lastResult: true },
		});
		if (!parentStatus?.generationId || parentStatus.lastResult !== "success") {
			log.warn({ instanceId }, "Jellyfin episode refresh requires a successful parent generation");
			return { upserted: 0, errors: 1, complete: false };
		}
		const parentGenerationId = parentStatus.generationId;
		const recentSeriesGroups = await prisma.jellyfinCache.groupBy({
			by: ["tmdbId"],
			where: { instanceId, mediaType: "series", lastWatchedAt: { not: null } },
			_max: { lastWatchedAt: true },
			orderBy: { _max: { lastWatchedAt: "desc" } },
			take: JELLYFIN_EPISODE_MAX_SERIES + 1,
		});
		if (recentSeriesGroups.length > JELLYFIN_EPISODE_MAX_SERIES) {
			log.warn(
				{ instanceId, limit: JELLYFIN_EPISODE_MAX_SERIES },
				"Jellyfin episode inventory exceeded its safe series limit",
			);
			return { upserted: 0, errors: 1, complete: false };
		}
		const recentSeries =
			recentSeriesGroups.length === 0
				? []
				: await prisma.jellyfinCache.findMany({
						where: {
							instanceId,
							mediaType: "series",
							tmdbId: { in: recentSeriesGroups.map((series) => series.tmdbId) },
						},
						orderBy: [{ tmdbId: "asc" }, { jellyfinId: "asc" }],
						select: { tmdbId: true, jellyfinId: true, title: true },
					});

		const seriesByTmdbId = new Map<
			number,
			{ tmdbId: number; title: string; jellyfinIds: Set<string> }
		>();
		for (const series of recentSeries) {
			if (!series.jellyfinId) {
				log.warn({ instanceId, tmdbId: series.tmdbId }, "Jellyfin series lacked an item id");
				return { upserted: 0, errors: 1, complete: false };
			}
			const existing = seriesByTmdbId.get(series.tmdbId);
			if (existing) existing.jellyfinIds.add(series.jellyfinId);
			else {
				seriesByTmdbId.set(series.tmdbId, {
					tmdbId: series.tmdbId,
					title: series.title,
					jellyfinIds: new Set([series.jellyfinId]),
				});
			}
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
				for (const seriesId of [...series.jellyfinIds].sort()) {
					let episodes: Awaited<ReturnType<JellyfinClient["getEpisodes"]>>;
					try {
						episodes = await client.getEpisodes(user.id, seriesId);
					} catch (error) {
						log.warn(
							{ err: error, instanceId, seriesId, userId: user.id },
							"Failed to prove complete Jellyfin episode inventory",
						);
						return { upserted: 0, errors: 1, complete: false };
					}
					const seenCoordinates = new Set<string>();
					for (const episode of episodes) {
						const { seasonNumber, episodeNumber } = episode;
						if (
							!Number.isSafeInteger(seasonNumber) ||
							seasonNumber === undefined ||
							seasonNumber < 0 ||
							!Number.isSafeInteger(episodeNumber) ||
							episodeNumber === undefined ||
							episodeNumber <= 0
						)
							return { upserted: 0, errors: 1, complete: false };
						const key = `${seasonNumber}:${episodeNumber}`;
						if (seenCoordinates.has(key)) return { upserted: 0, errors: 1, complete: false };
						seenCoordinates.add(key);
						const entry = episodeMap.get(key);
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
								if (Number.isNaN(playedAt.getTime()))
									return { upserted: 0, errors: 1, complete: false };
								if (!current.lastWatchedAt || playedAt > current.lastWatchedAt)
									current.lastWatchedAt = playedAt;
							}
						}
						episodeMap.set(key, current);
					}
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
		const generationId = randomUUID();
		const publication = await withCurrentJellyfinConnection(
			prisma,
			instanceId,
			expectedConnectionFingerprint,
			async (tx) => {
				const currentParent = await tx.cacheRefreshStatus.findUnique({
					where: { instanceId_cacheType: { instanceId, cacheType: "jellyfin" } },
					select: { generationId: true },
				});
				if (currentParent?.generationId !== parentGenerationId) return false;
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
						generationId,
						generationMetadata: JSON.stringify({ parentGenerationId }),
						lastAttemptAt: completedAt,
						lastAttemptResult: "success",
					},
					update: {
						lastRefreshedAt: completedAt,
						lastResult: "success",
						lastErrorMessage: null,
						itemCount: rows.length,
						generationId,
						generationMetadata: JSON.stringify({ parentGenerationId }),
						lastAttemptAt: completedAt,
						lastAttemptResult: "success",
						lastAttemptErrorMessage: null,
					},
				});
				return true;
			},
		);
		if (!publication.matched || !publication.value)
			return { upserted: 0, errors: 0, complete: false, superseded: true };
		return { upserted: rows.length, errors: 0, complete: true, completedAt };
	} catch (error) {
		log.error(
			{ err: error, instanceId },
			`Jellyfin episode cache refresh failed: ${getErrorMessage(error)}`,
		);
		return { upserted: 0, errors: 1, complete: false };
	}
}
