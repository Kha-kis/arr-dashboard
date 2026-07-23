/**
 * Jellyfin Cache Refresher
 *
 * Fetches library items with watch data from Jellyfin and upserts into JellyfinCache.
 * Unlike Plex (which has a separate history endpoint), Jellyfin embeds UserData
 * directly on each item response per-user, so we iterate all users to aggregate.
 *
 * Strategy:
 * 1. Get users → iterate each user for watch data
 * 2. Get libraries (views) → filter to movie/tvshow libraries
 * 3. For each library: get items with ProviderIds + UserData
 * 4. Aggregate watch data across all users
 * 5. Get resume items → mark as onDeck
 * 6. Upsert into JellyfinCache
 */

import type { FastifyBaseLogger } from "fastify";
import { getErrorMessage } from "../utils/error-message.js";
import type { PrismaClient } from "../prisma.js";
import type { JellyfinClient } from "./jellyfin-client.js";

// ============================================================================
// Aggregation Types
// ============================================================================

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

// ============================================================================
// Main Refresh Function
// ============================================================================

export async function refreshJellyfinCache(
	client: JellyfinClient,
	prisma: PrismaClient,
	instanceId: string,
	log: FastifyBaseLogger,
): Promise<{ upserted: number; errors: number; errorMessages: string[] }> {
	let upserted = 0;
	let errors = 0;
	const errorMessages: string[] = [];

	try {
		// Step 1: Get all users
		const users = await client.getUsers();
		if (users.length === 0) {
			log.warn({ instanceId }, "Jellyfin cache refresh: no users found");
			return { upserted: 0, errors: 0, errorMessages: [] };
		}

		// Use the first user (admin) for library enumeration
		const primaryUserId = users[0]!.id;

		// Step 2: Get libraries and filter to movie/tvshow
		const libraries = await client.getLibraries(primaryUserId);
		const mediaLibraries = libraries.filter(
			(lib) =>
				lib.collectionType === "movies" ||
				lib.collectionType === "tvshows" ||
				lib.collectionType === "CollectionFolder",
		);

		if (mediaLibraries.length === 0) {
			log.info({ instanceId }, "Jellyfin cache refresh: no movie/TV libraries found");
			return { upserted: 0, errors: 0, errorMessages: [] };
		}

		// Step 3: Aggregate items across all users
		const aggregations = new Map<string, ItemAggregation>();

		for (const library of mediaLibraries) {
			const includeItemTypes =
				library.collectionType === "movies"
					? "Movie"
					: library.collectionType === "tvshows"
						? "Series"
						: "Movie,Series"; // CollectionFolder or unknown — fetch both

			for (const user of users) {
				try {
					const items = await client.getLibraryItems(user.id, library.id, {
						includeItemTypes,
					});

					for (const item of items) {
						if (!item.tmdbId) continue;

						const mediaType = item.type === "Movie" ? "movie" : "series";
						const key = `${item.tmdbId}:${mediaType}:${library.id}`;

						let agg = aggregations.get(key);
						if (!agg) {
							agg = {
								tmdbId: item.tmdbId,
								mediaType: mediaType as "movie" | "series",
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
							aggregations.set(key, agg);
						}

						// Merge user watch data
						if (item.played) {
							agg.watchedByUsers.add(user.name);
							agg.watchCount = Math.max(agg.watchCount, item.playCount);
						}
						// Capture lastPlayedDate even for partially-watched items (e.g. a series
						// where some but not all episodes are watched). Jellyfin sets
						// UserData.LastPlayedDate on a Series whenever any episode is played, not
						// only when the whole series is finished. Recording it here ensures the
						// episode-cache refresher picks up in-progress series, which is required
						// for the per-episode progress bar to populate on library cards.
						if (item.lastPlayedDate) {
							const playDate = new Date(item.lastPlayedDate);
							if (!agg.lastWatchedAt || playDate > agg.lastWatchedAt) {
								agg.lastWatchedAt = playDate;
							}
						}

						if (item.isFavorite) {
							// Map Jellyfin favorite to a 10.0 rating equivalent
							agg.userRating = 10.0;
						}
					}
				} catch (err) {
					const msg = `Library ${library.name} for user ${user.name}: ${getErrorMessage(err, "unknown")}`;
					errorMessages.push(msg);
					errors++;
					log.warn({ err, libraryId: library.id, userId: user.id }, msg);
				}
			}
		}

		// Step 4: Get resume items to mark onDeck
		try {
			const resumeItems = await client.getResumeItems(primaryUserId);
			const nextUp = await client.getNextUp(primaryUserId);
			const onDeckIds = new Set([
				...resumeItems.map((i) => i.tmdbId).filter(Boolean),
				...nextUp.map((i) => i.tmdbId).filter(Boolean),
			]);
			for (const agg of aggregations.values()) {
				if (onDeckIds.has(agg.tmdbId)) {
					agg.onDeck = true;
				}
			}
		} catch (err) {
			errors++;
			errorMessages.push(`Resume/NextUp fetch failed: ${getErrorMessage(err, "unknown")}`);
			log.warn({ err, instanceId }, "Failed to fetch Jellyfin resume/nextUp for onDeck status");
		}

		// Step 5: Upsert into JellyfinCache in batches
		const BATCH_SIZE = 100;
		const items = Array.from(aggregations.values());

		for (let i = 0; i < items.length; i += BATCH_SIZE) {
			const batch = items.slice(i, i + BATCH_SIZE);
			try {
				await prisma.$transaction(
					batch.map((agg) =>
						prisma.jellyfinCache.upsert({
							where: {
								instanceId_tmdbId_mediaType_libraryId: {
									instanceId,
									tmdbId: agg.tmdbId,
									mediaType: agg.mediaType,
									libraryId: agg.libraryId,
								},
							},
							create: {
								instanceId,
								tmdbId: agg.tmdbId,
								mediaType: agg.mediaType,
								libraryId: agg.libraryId,
								libraryName: agg.libraryName,
								title: agg.title,
								jellyfinId: agg.jellyfinId,
								lastWatchedAt: agg.lastWatchedAt,
								watchCount: agg.watchCount,
								watchedByUsers: JSON.stringify([...agg.watchedByUsers]),
								onDeck: agg.onDeck,
								userRating: agg.userRating,
								collections: JSON.stringify(agg.collections),
								addedAt: agg.addedAt,
								thumb: agg.thumb,
							},
							update: {
								libraryName: agg.libraryName,
								title: agg.title,
								jellyfinId: agg.jellyfinId,
								lastWatchedAt: agg.lastWatchedAt,
								watchCount: agg.watchCount,
								watchedByUsers: JSON.stringify([...agg.watchedByUsers]),
								onDeck: agg.onDeck,
								userRating: agg.userRating,
								collections: JSON.stringify(agg.collections),
								addedAt: agg.addedAt,
								thumb: agg.thumb,
							},
						}),
					),
				);
				upserted += batch.length;
			} catch (err) {
				errors += batch.length;
				const msg = `Batch upsert failed: ${getErrorMessage(err, "unknown")}`;
				errorMessages.push(msg);
				log.error({ err, batchStart: i, batchSize: batch.length }, msg);
			}
		}

		// Step 6: Evict stale rows — only when refresh had no errors
		// to prevent deleting valid data from libraries that failed to fetch
		if (errors > 0) {
			log.warn({ instanceId, errors }, "Skipping stale row eviction due to refresh errors");
		} else {
			const currentKeys = new Set(items.map((i) => `${i.tmdbId}:${i.mediaType}:${i.libraryId}`));
			try {
				const existingRows = await prisma.jellyfinCache.findMany({
					where: { instanceId },
					select: { id: true, tmdbId: true, mediaType: true, libraryId: true },
				});
				const staleIds = existingRows
					.filter((row) => !currentKeys.has(`${row.tmdbId}:${row.mediaType}:${row.libraryId}`))
					.map((row) => row.id);

				if (staleIds.length > 0) {
					await prisma.jellyfinCache.deleteMany({
						where: { id: { in: staleIds } },
					});
					log.info({ instanceId, evicted: staleIds.length }, "Evicted stale Jellyfin cache rows");
				}
			} catch (err) {
				log.warn({ err, instanceId }, "Failed to evict stale Jellyfin cache rows");
			}
		}
	} catch (err) {
		errors++;
		errorMessages.push(getErrorMessage(err, "Top-level refresh failure"));
		log.error({ err, instanceId }, "Jellyfin cache refresh failed");
	}

	return { upserted, errors, errorMessages };
}
