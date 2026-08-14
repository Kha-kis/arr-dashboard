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
import { withCurrentJellyfinConnection } from "./jellyfin-connection-guard.js";
import type { JellyfinClient, JellyfinLibrary, JellyfinUser } from "./jellyfin-client.js";

export const JELLYFIN_STALE_EVICTION_CHUNK_SIZE = 500;
/** Bound Prisma's cached createMany query plans for production-sized libraries. */
export const JELLYFIN_CACHE_PUBLICATION_CHUNK_SIZE = 100;
/** Allow bounded publication batches to complete on higher-latency databases. */
export const JELLYFIN_CACHE_PUBLICATION_TRANSACTION_TIMEOUT_MS = 60_000;

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

export interface JellyfinCacheSnapshotRow {
	instanceId: string;
	tmdbId: number;
	mediaType: "movie" | "series";
	libraryId: string;
	libraryName: string;
	title: string;
	jellyfinId: string;
	lastWatchedAt: Date | null;
	watchCount: number;
	watchedByUsers: string;
	onDeck: boolean;
	userRating: number | null;
	collections: string;
	addedAt: Date | null;
	thumb: string | null;
}

export interface JellyfinCacheSnapshot {
	rows: JellyfinCacheSnapshotRow[];
	users: Array<{ id: string; name: string }>;
	libraries: Array<{
		userId: string;
		libraryId: string;
		libraryName: string;
		collectionType: string;
	}>;
}

export interface JellyfinCacheRefreshOptions {
	publish?: boolean;
}

export interface JellyfinCacheRefreshResult {
	upserted: number;
	errors: number;
	errorMessages: string[];
	complete: boolean;
	completedAt?: Date;
	superseded?: boolean;
	snapshot?: JellyfinCacheSnapshot;
}

// ============================================================================
// Main Refresh Function
// ============================================================================

export async function refreshJellyfinCache(
	client: JellyfinClient,
	prisma: PrismaClient,
	instanceId: string,
	log: FastifyBaseLogger,
	expectedConnectionFingerprint?: string,
	options: JellyfinCacheRefreshOptions = {},
): Promise<JellyfinCacheRefreshResult> {
	let upserted = 0;
	let errors = 0;
	let complete = true;
	const errorMessages: string[] = [];

	try {
		// Step 1: Get all users
		const users = await client.getUsers();
		if (users.length === 0) {
			complete = false;
			log.warn({ instanceId }, "Jellyfin cache refresh: no users found");
			return {
				upserted: 0,
				errors: 1,
				errorMessages: ["Jellyfin returned no users"],
				complete,
			};
		}

		// Step 2: Inventory each user's visible media libraries. Jellyfin and Emby
		// permissions can expose different libraries to different users, so no
		// single user is an authoritative proxy for server-wide coverage.
		const librariesByUser: Array<{
			user: JellyfinUser;
			libraries: JellyfinLibrary[];
		}> = [];
		for (const user of users) {
			const libraries = await client.getLibraries(user.id);
			librariesByUser.push({
				user,
				libraries: libraries.filter(
					(lib) =>
						lib.collectionType === "movies" ||
						lib.collectionType === "tvshows" ||
						lib.collectionType === "CollectionFolder",
				),
			});
		}

		if (librariesByUser.every(({ libraries }) => libraries.length === 0)) {
			complete = false;
			log.info({ instanceId }, "Jellyfin cache refresh: no movie/TV libraries found");
			return {
				upserted: 0,
				errors: 1,
				errorMessages: ["Jellyfin returned no movie or TV libraries"],
				complete,
			};
		}

		// Step 3: Aggregate items across all users
		const aggregations = new Map<string, ItemAggregation>();

		for (const { user, libraries } of librariesByUser) {
			for (const library of libraries) {
				const includeItemTypes =
					library.collectionType === "movies"
						? "Movie"
						: library.collectionType === "tvshows"
							? "Series"
							: "Movie,Series"; // CollectionFolder or unknown — fetch both

				try {
					const items = await client.getLibraryItems(user.id, library.id, {
						includeItemTypes,
					});

					for (const item of items) {
						if (item.type !== "Movie" && item.type !== "Series") {
							complete = false;
							continue;
						}
						if (!item.tmdbId) {
							complete = false;
							continue;
						}

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
						} else if (agg.jellyfinId !== item.id) {
							complete = false;
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
					complete = false;
					const msg = `Library ${library.name} for user ${user.name}: ${getErrorMessage(err, "unknown")}`;
					errorMessages.push(msg);
					errors++;
					log.warn({ err, libraryId: library.id, userId: user.id }, msg);
				}
			}
		}

		// Step 4: Get resume items for every user. A primary-user-only snapshot can
		// miss another user's in-progress item and incorrectly authorize cleanup.
		for (const user of users) {
			try {
				const [resumeItems, nextUp] = await Promise.all([
					client.getResumeItems(user.id),
					client.getNextUp(user.id),
				]);
				for (const item of [...resumeItems, ...nextUp]) {
					if (item.type !== "Movie" && item.type !== "Series" && item.type !== "Episode") {
						continue;
					}
					const jellyfinId =
						item.type === "Movie" || item.type === "Series" ? item.id : item.seriesId;
					if (!jellyfinId) {
						complete = false;
						continue;
					}
					let matched = false;
					for (const agg of aggregations.values()) {
						if (agg.jellyfinId === jellyfinId) {
							agg.onDeck = true;
							matched = true;
						}
					}
					if (!matched) complete = false;
				}
			} catch (err) {
				complete = false;
				errors++;
				errorMessages.push(
					`Resume/NextUp fetch failed for ${user.name}: ${getErrorMessage(err, "unknown")}`,
				);
				log.warn(
					{ err, instanceId, userId: user.id },
					"Failed to fetch Jellyfin resume/nextUp for onDeck status",
				);
			}
		}

		// Step 5: Publish a complete replacement atomically. An incomplete scan
		// must leave the previous successful generation untouched.
		const items = Array.from(aggregations.values());
		let completedAt: Date | undefined;
		if (errors === 0 && complete) {
			completedAt = new Date();
			if (options.publish === false) {
				const rows: JellyfinCacheSnapshotRow[] = items.map((agg) => ({
					instanceId,
					tmdbId: agg.tmdbId,
					mediaType: agg.mediaType,
					libraryId: agg.libraryId,
					libraryName: agg.libraryName,
					title: agg.title,
					jellyfinId: agg.jellyfinId,
					lastWatchedAt: agg.lastWatchedAt,
					watchCount: agg.watchCount,
					watchedByUsers: JSON.stringify([...agg.watchedByUsers].sort()),
					onDeck: agg.onDeck,
					userRating: agg.userRating,
					collections: JSON.stringify([...agg.collections].sort()),
					addedAt: agg.addedAt,
					thumb: agg.thumb,
				}));
				return {
					upserted: 0,
					errors: 0,
					errorMessages: [],
					complete: true,
					completedAt,
					snapshot: {
						rows,
						users: users
							.map((user) => ({ id: user.id, name: user.name }))
							.sort((left, right) => left.id.localeCompare(right.id)),
						libraries: librariesByUser
							.flatMap(({ user, libraries }) =>
								libraries.map((library) => ({
									userId: user.id,
									libraryId: library.id,
									libraryName: library.name,
									collectionType: library.collectionType,
								})),
							)
							.sort(
								(left, right) =>
									left.userId.localeCompare(right.userId) ||
									left.libraryId.localeCompare(right.libraryId),
							),
					},
				};
			}
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
									data: chunk.map((agg) => ({
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
								lastAttemptAt: completedAt!,
								lastAttemptResult: "success",
							},
							update: {
								lastRefreshedAt: completedAt!,
								lastResult: "success",
								lastErrorMessage: null,
								itemCount: items.length,
								lastAttemptAt: completedAt!,
								lastAttemptResult: "success",
								lastAttemptErrorMessage: null,
							},
						});
					},
					{ timeout: JELLYFIN_CACHE_PUBLICATION_TRANSACTION_TIMEOUT_MS },
				);
				if (!publication.matched) throw new JellyfinRefreshSupersededError();
				upserted = items.length;
			} catch (err) {
				complete = false;
				completedAt = undefined;
				if (err instanceof JellyfinRefreshSupersededError) {
					log.warn(
						{ instanceId },
						"Discarding Jellyfin cache refresh from a superseded connection",
					);
					return {
						upserted: 0,
						errors: 0,
						errorMessages: ["Jellyfin service connection changed during refresh"],
						complete: false,
						superseded: true,
					};
				}
				errors++;
				const msg = `Atomic cache publication failed: ${getErrorMessage(err, "unknown")}`;
				errorMessages.push(msg);
				log.error({ err, instanceId, itemCount: items.length }, msg);
			}
		} else {
			log.warn({ instanceId, errors }, "Skipping cache publication due to incomplete refresh");
		}

		return {
			upserted,
			errors,
			errorMessages,
			complete: complete && errors === 0,
			completedAt,
		};
	} catch (err) {
		complete = false;
		errors++;
		errorMessages.push(getErrorMessage(err, "Top-level refresh failure"));
		log.error({ err, instanceId }, "Jellyfin cache refresh failed");
	}

	return { upserted, errors, errorMessages, complete: false };
}

class JellyfinRefreshSupersededError extends Error {
	constructor() {
		super("Jellyfin service connection changed during refresh");
		this.name = "JellyfinRefreshSupersededError";
	}
}
