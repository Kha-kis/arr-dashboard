/**
 * Jellyfin Cache Refresher
 *
 * Fetches library items with watch data from Jellyfin and replaces JellyfinCache
 * only after a complete, internally consistent snapshot has been gathered.
 */

import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { PrismaClient } from "../prisma.js";
import { getErrorMessage } from "../utils/error-message.js";
import type { JellyfinClient } from "./jellyfin-client.js";
import { withCurrentJellyfinConnection } from "./jellyfin-connection-guard.js";

/** Bound Prisma's cached createMany query plans for production-sized libraries. */
export const JELLYFIN_CACHE_PUBLICATION_CHUNK_SIZE = 100;

interface ItemAggregation {
	tmdbId: number;
	mediaType: "movie" | "series";
	libraryId: string;
	libraryName: string;
	title: string;
	jellyfinId: string;
	lastWatchedAt: Date | null;
	watchCount: number;
	watchedByUsers: Set<string>;
	onDeck: boolean;
	userRating: number | null;
	collections: string[];
	addedAt: Date | null;
	thumb: string | null;
}

export async function refreshJellyfinCache(
	client: JellyfinClient,
	prisma: PrismaClient,
	instanceId: string,
	log: FastifyBaseLogger,
	expectedConnectionFingerprint?: string,
): Promise<{
	upserted: number;
	errors: number;
	errorMessages: string[];
	complete: boolean;
	completedAt?: Date;
	superseded?: boolean;
}> {
	let upserted = 0;
	let errors = 0;
	let complete = true;
	const errorMessages: string[] = [];

	try {
		const users = await client.getUsers();
		if (users.length === 0) {
			log.warn({ instanceId }, "Jellyfin cache refresh: no users found");
			return {
				upserted: 0,
				errors: 1,
				errorMessages: ["Jellyfin returned no users"],
				complete: false,
			};
		}

		// Library visibility is user-specific. Enumerating only the first returned
		// user can make a populated server look empty or omit a restricted library.
		const mediaLibrariesByUser = new Map<
			string,
			Awaited<ReturnType<JellyfinClient["getLibraries"]>>
		>();
		for (const user of users) {
			try {
				const libraries = await client.getLibraries(user.id);
				mediaLibrariesByUser.set(
					user.id,
					libraries.filter(
						(library) =>
							library.collectionType === "movies" ||
							library.collectionType === "tvshows" ||
							library.collectionType === "CollectionFolder",
					),
				);
			} catch (error) {
				complete = false;
				errors++;
				const message = `Library enumeration failed for user ${user.name}: ${getErrorMessage(error, "unknown")}`;
				errorMessages.push(message);
				log.warn({ err: error, instanceId, userId: user.id }, message);
			}
		}

		const mediaLibraryCount = new Set(
			[...mediaLibrariesByUser.values()].flat().map((library) => library.id),
		).size;
		if (mediaLibraryCount === 0) {
			log.info({ instanceId }, "Jellyfin cache refresh: no movie/TV libraries found");
			return {
				upserted: 0,
				errors: 1,
				errorMessages: ["Jellyfin returned no movie or TV libraries"],
				complete: false,
			};
		}

		const aggregations = new Map<string, ItemAggregation>();
		for (const user of users) {
			for (const library of mediaLibrariesByUser.get(user.id) ?? []) {
				const includeItemTypes =
					library.collectionType === "movies"
						? "Movie"
						: library.collectionType === "tvshows"
							? "Series"
							: "Movie,Series";
				try {
					const items = await client.getLibraryItems(user.id, library.id, { includeItemTypes });
					for (const item of items) {
						if (item.type !== "Movie" && item.type !== "Series") {
							complete = false;
							continue;
						}
						if (!item.tmdbId) {
							complete = false;
							errorMessages.push("Jellyfin returned a current library item without a TMDb mapping");
							continue;
						}

						const mediaType = item.type === "Movie" ? "movie" : "series";
						const key = `${item.tmdbId}:${mediaType}:${library.id}`;
						let aggregation = aggregations.get(key);
						if (!aggregation) {
							aggregation = {
								tmdbId: item.tmdbId,
								mediaType,
								libraryId: library.id,
								libraryName: library.name,
								title: item.name,
								jellyfinId: item.id,
								lastWatchedAt: null,
								watchCount: 0,
								watchedByUsers: new Set(),
								onDeck: false,
								userRating: null,
								collections: [],
								addedAt: item.dateCreated ? new Date(item.dateCreated) : null,
								thumb: item.imageTags?.Primary ? `/Items/${item.id}/Images/Primary` : null,
							};
							aggregations.set(key, aggregation);
						} else if (aggregation.jellyfinId !== item.id) {
							complete = false;
						}

						if (item.played) {
							aggregation.watchedByUsers.add(user.name);
							aggregation.watchCount = Math.max(aggregation.watchCount, item.playCount);
						}
						if (item.lastPlayedDate) {
							const playDate = new Date(item.lastPlayedDate);
							if (!aggregation.lastWatchedAt || playDate > aggregation.lastWatchedAt) {
								aggregation.lastWatchedAt = playDate;
							}
						}
						if (item.isFavorite) aggregation.userRating = 10;
					}
				} catch (error) {
					complete = false;
					errors++;
					const message = `Library ${library.name} for user ${user.name}: ${getErrorMessage(error, "unknown")}`;
					errorMessages.push(message);
					log.warn({ err: error, libraryId: library.id, userId: user.id }, message);
				}
			}
		}

		// Every user's in-progress inventory is required. Restricting this to the
		// primary user can erase another user's active playback evidence.
		for (const user of users) {
			try {
				const [resumeItems, nextUp] = await Promise.all([
					client.getResumeItems(user.id),
					client.getNextUp(user.id),
				]);
				for (const item of [...resumeItems, ...nextUp]) {
					if (item.type !== "Movie" && item.type !== "Series" && item.type !== "Episode") continue;
					const jellyfinId =
						item.type === "Movie" || item.type === "Series" ? item.id : item.seriesId;
					if (!jellyfinId) {
						complete = false;
						continue;
					}
					let matched = false;
					for (const aggregation of aggregations.values()) {
						if (aggregation.jellyfinId === jellyfinId) {
							aggregation.onDeck = true;
							matched = true;
						}
					}
					if (!matched) {
						complete = false;
						errorMessages.push(
							"Jellyfin resume item could not be attributed to the current library snapshot",
						);
					}
				}
			} catch (error) {
				complete = false;
				errors++;
				const message = `Resume/NextUp fetch failed for ${user.name}: ${getErrorMessage(error, "unknown")}`;
				errorMessages.push(message);
				log.warn(
					{ err: error, instanceId, userId: user.id },
					"Failed to fetch Jellyfin resume/nextUp for onDeck status",
				);
			}
		}

		const items = Array.from(aggregations.values());
		let completedAt: Date | undefined;
		if (errors !== 0 || !complete) {
			log.warn({ instanceId, errors }, "Skipping cache publication due to incomplete refresh");
			return { upserted, errors, errorMessages, complete: false };
		}

		completedAt = new Date();
		const generationId = randomUUID();
		try {
			const publication = await withCurrentJellyfinConnection(
				prisma,
				instanceId,
				expectedConnectionFingerprint,
				async (tx) => {
					await tx.jellyfinCache.deleteMany({ where: { instanceId } });
					if (items.length > 0) {
						for (
							let start = 0;
							start < items.length;
							start += JELLYFIN_CACHE_PUBLICATION_CHUNK_SIZE
						) {
							const chunk = items.slice(start, start + JELLYFIN_CACHE_PUBLICATION_CHUNK_SIZE);
							await tx.jellyfinCache.createMany({
								data: chunk.map((item) => ({
									instanceId,
									tmdbId: item.tmdbId,
									mediaType: item.mediaType,
									libraryId: item.libraryId,
									libraryName: item.libraryName,
									title: item.title,
									jellyfinId: item.jellyfinId,
									lastWatchedAt: item.lastWatchedAt,
									watchCount: item.watchCount,
									watchedByUsers: JSON.stringify([...item.watchedByUsers]),
									onDeck: item.onDeck,
									userRating: item.userRating,
									collections: JSON.stringify(item.collections),
									addedAt: item.addedAt,
									thumb: item.thumb,
								})),
							});
						}
					}
					await tx.cacheRefreshStatus.upsert({
						where: { instanceId_cacheType: { instanceId, cacheType: "jellyfin" } },
						create: {
							instanceId,
							cacheType: "jellyfin",
							lastRefreshedAt: completedAt!,
							lastResult: "success",
							itemCount: items.length,
							generationId,
							lastAttemptAt: completedAt!,
							lastAttemptResult: "success",
						},
						update: {
							lastRefreshedAt: completedAt!,
							lastResult: "success",
							lastErrorMessage: null,
							itemCount: items.length,
							generationId,
							generationMetadata: null,
							lastAttemptAt: completedAt!,
							lastAttemptResult: "success",
							lastAttemptErrorMessage: null,
						},
					});
				},
			);
			if (!publication.matched) {
				log.warn({ instanceId }, "Discarding Jellyfin cache refresh from a superseded connection");
				return {
					upserted: 0,
					errors: 0,
					errorMessages: ["Jellyfin service connection changed during refresh"],
					complete: false,
					superseded: true,
				};
			}
			upserted = items.length;
			return { upserted, errors, errorMessages, complete: true, completedAt };
		} catch (error) {
			const message = `Atomic cache publication failed: ${getErrorMessage(error, "unknown")}`;
			errorMessages.push(message);
			log.error({ err: error, instanceId, itemCount: items.length }, message);
			return { upserted: 0, errors: errors + 1, errorMessages, complete: false };
		}
	} catch (error) {
		const message = getErrorMessage(error, "Top-level refresh failure");
		errorMessages.push(message);
		log.error({ err: error, instanceId }, "Jellyfin cache refresh failed");
		return { upserted: 0, errors: errors + 1, errorMessages, complete: false };
	}
}
