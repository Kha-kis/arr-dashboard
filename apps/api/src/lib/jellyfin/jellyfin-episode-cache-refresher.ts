/** Publishes a complete per-instance Jellyfin/Emby episode snapshot atomically. */

import type { FastifyBaseLogger } from "fastify";
import type { Prisma, PrismaClient } from "../prisma.js";
import { recordWatchProviderCacheRefreshFailure } from "../services/provider-cache-status.js";
import {
	hasAuthoritativeProviderCacheGeneration,
	type OwnedProviderPublicationSnapshot,
	ProviderIdentityGuardError,
	withGuardedProviderPublication,
} from "../services/provider-identity-guard.js";
import { getErrorMessage } from "../utils/error-message.js";
import {
	JELLYFIN_CACHE_PUBLICATION_CHUNK_SIZE,
	type JellyfinPublicationContext,
} from "./jellyfin-cache-refresher.js";
import { JellyfinClient } from "./jellyfin-client.js";

export const JELLYFIN_EPISODE_MAX_SERIES = 50;

export type JellyfinEpisodeRefreshResult = {
	upserted: number;
	errors: number;
	complete: boolean;
	completedAt?: Date;
	superseded?: boolean;
};

type JellyfinEpisodeRow = {
	instanceId: string;
	showTmdbId: number;
	seasonNumber: number;
	episodeNumber: number;
	jellyfinId: string;
	title: string;
	watched: boolean;
	watchedByUsers: string;
	lastWatchedAt: Date | null;
};

type CollectedEpisodes = JellyfinEpisodeRefreshResult & { rows?: JellyfinEpisodeRow[] };

export async function refreshJellyfinEpisodeCache(
	context: JellyfinPublicationContext,
): Promise<JellyfinEpisodeRefreshResult> {
	const { prisma, instance, log } = context;
	let result: JellyfinEpisodeRefreshResult;
	try {
		const client = new JellyfinClient(
			instance.baseUrl,
			instance.apiKey,
			log,
			undefined,
			instance.httpAuthHeaders,
		);
		result = await withGuardedProviderPublication(
			prisma,
			instance,
			log,
			async () => await collectJellyfinEpisodes(client, prisma, instance, log),
			async (tx, collected) => await publishJellyfinEpisodes(tx, instance, collected),
		);
	} catch (error) {
		if (error instanceof ProviderIdentityGuardError && error.code === "PUBLICATION_SUPERSEDED") {
			return { upserted: 0, errors: 0, complete: false, superseded: true };
		}
		log.error(
			{ err: error, instanceId: instance.id },
			`Jellyfin episode cache refresh failed: ${getErrorMessage(error)}`,
		);
		result = { upserted: 0, errors: 1, complete: false };
	}

	if (!result.complete && !result.superseded) {
		const failure = await recordWatchProviderCacheRefreshFailure(
			prisma,
			"jellyfin_episode",
			"Jellyfin episode refresh did not produce a complete generation",
			instance,
			log,
		);
		if (failure === "superseded") return { ...result, errors: 0, superseded: true };
	}
	return result;
}

async function collectJellyfinEpisodes(
	client: JellyfinClient,
	prisma: PrismaClient,
	instance: OwnedProviderPublicationSnapshot,
	log: FastifyBaseLogger,
): Promise<CollectedEpisodes> {
	const instanceId = instance.id;
	const sourceStatus = await prisma.cacheRefreshStatus.findUnique({
		where: { instanceId_cacheType: { instanceId, cacheType: "jellyfin" } },
		select: {
			lastResult: true,
			connectionGeneration: true,
			identityGeneration: true,
		},
	});
	if (
		sourceStatus?.lastResult !== "success" ||
		!hasAuthoritativeProviderCacheGeneration(sourceStatus, instance)
	) {
		return { upserted: 0, errors: 1, complete: false };
	}

	const users = await client.getUsers();
	if (users.length === 0) {
		log.warn({ instanceId }, "Jellyfin episode refresh returned no users");
		return { upserted: 0, errors: 1, complete: false };
	}
	const recentSeries = await prisma.jellyfinCache.findMany({
		where: {
			instanceId,
			mediaType: "series",
			lastWatchedAt: { not: null },
			connectionGeneration: instance.connectionGeneration,
			identityGeneration: instance.identityGeneration,
		},
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

	const seriesByTmdbId = new Map<number, { tmdbId: number; jellyfinId: string; title: string }>();
	for (const series of recentSeries) {
		if (!series.jellyfinId) return { upserted: 0, errors: 1, complete: false };
		const existing = seriesByTmdbId.get(series.tmdbId);
		if (existing && existing.jellyfinId !== series.jellyfinId) {
			return { upserted: 0, errors: 1, complete: false };
		}
		seriesByTmdbId.set(series.tmdbId, { ...series, jellyfinId: series.jellyfinId });
	}

	const rows: JellyfinEpisodeRow[] = [];
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
				episodes = await client.getEpisodes(user.id, series.jellyfinId);
			} catch (error) {
				log.warn(
					{ err: error, instanceId, seriesId: series.jellyfinId, userId: user.id },
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
				) {
					return { upserted: 0, errors: 1, complete: false };
				}
				const key = `${seasonNumber}:${episodeNumber}`;
				if (seenCoordinates.has(key)) return { upserted: 0, errors: 1, complete: false };
				seenCoordinates.add(key);
				const existing = episodeMap.get(key);
				if (existing && existing.jellyfinId !== episode.id) {
					return { upserted: 0, errors: 1, complete: false };
				}
				const current = existing ?? {
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
	return { upserted: 0, errors: 0, complete: true, completedAt: new Date(), rows };
}

async function publishJellyfinEpisodes(
	tx: Prisma.TransactionClient,
	instance: OwnedProviderPublicationSnapshot,
	collected: CollectedEpisodes,
): Promise<JellyfinEpisodeRefreshResult> {
	if (!collected.complete || !collected.completedAt || !collected.rows) return collected;
	const rows = collected.rows;
	await tx.jellyfinEpisodeCache.deleteMany({ where: { instanceId: instance.id } });
	for (let start = 0; start < rows.length; start += JELLYFIN_CACHE_PUBLICATION_CHUNK_SIZE) {
		await tx.jellyfinEpisodeCache.createMany({
			data: rows.slice(start, start + JELLYFIN_CACHE_PUBLICATION_CHUNK_SIZE).map((row) => ({
				...row,
				connectionGeneration: instance.connectionGeneration,
				identityGeneration: instance.identityGeneration,
			})),
		});
	}
	await tx.cacheRefreshStatus.upsert({
		where: { instanceId_cacheType: { instanceId: instance.id, cacheType: "jellyfin_episode" } },
		create: {
			instanceId: instance.id,
			cacheType: "jellyfin_episode",
			lastRefreshedAt: collected.completedAt,
			lastResult: "success",
			itemCount: rows.length,
			lastAttemptAt: collected.completedAt,
			lastAttemptResult: "success",
			connectionGeneration: instance.connectionGeneration,
			identityGeneration: instance.identityGeneration,
		},
		update: {
			lastRefreshedAt: collected.completedAt,
			lastResult: "success",
			lastErrorMessage: null,
			itemCount: rows.length,
			lastAttemptAt: collected.completedAt,
			lastAttemptResult: "success",
			lastAttemptErrorMessage: null,
			connectionGeneration: instance.connectionGeneration,
			identityGeneration: instance.identityGeneration,
		},
	});
	return { ...collected, upserted: rows.length };
}
