/**
 * Plex Cache Refresher
 *
 * Fetches watch history, on-deck status, and user ratings from Plex
 * and atomically replaces the PlexCache table for the instance. This provides
 * a materialized view of a complete Plex snapshot for cleanup rule evaluation.
 *
 * Strategy:
 * 1. Get accounts → build accountId→username map
 * 2. Get library sections → filter movie/show sections
 * 3. For each section: get library items → extract TMDB GUIDs and ratings
 * 4. Get history → group by ratingKey, map accountId→username
 * 5. Get on-deck → set of ratingKeys currently on-deck
 * 6. Atomically publish a complete PlexCache generation
 */

import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { PrismaClient } from "../prisma.js";
import {
	type ProviderConnectionIdentity,
	withCurrentProviderConnection,
} from "../services/provider-connection-guard.js";
import { getErrorMessage } from "../utils/error-message.js";
import type { PlexClient } from "./plex-client.js";

/** Bound Prisma's cached createMany query plans for production-sized libraries. */
export const PLEX_CACHE_PUBLICATION_CHUNK_SIZE = 100;

// ============================================================================
// GUID Parsing
// ============================================================================

/**
 * Parse TMDB ID from Plex's Guid array.
 * Plex stores GUIDs like: [{id: "tmdb://12345"}, {id: "imdb://tt1234567"}]
 */
function parsePlexTmdbId(guids: Array<{ id: string }> | undefined): number | null {
	if (!guids) return null;

	for (const guid of guids) {
		const match = guid.id.match(/^tmdb:\/\/(\d+)$/);
		if (match?.[1]) {
			return Number.parseInt(match[1], 10);
		}
	}

	return null;
}

// ============================================================================
// Aggregation Types
// ============================================================================

interface ItemAggregation {
	tmdbId: number;
	mediaType: "movie" | "series";
	sectionId: string;
	sectionTitle: string;
	title: string;
	ratingKey: string | null;
	lastWatchedAt: Date | null;
	watchCount: number;
	watchedByUsers: Set<string>;
	onDeck: boolean;
	userRating: number | null;
	collections: string[];
	labels: string[];
	addedAt: Date | null;
	thumb: string | null;
}

function onDeckSignature(items: Awaited<ReturnType<PlexClient["getOnDeck"]>>): string[] {
	return items
		.map((item) =>
			JSON.stringify([
				item.type,
				item.ratingKey,
				item.parentRatingKey ?? null,
				item.grandparentRatingKey ?? null,
			]),
		)
		.sort();
}

export type PlexCacheRefreshResult = {
	upserted: number;
	errors: number;
	errorMessages: string[];
	complete: boolean;
	completedAt?: Date;
	superseded?: boolean;
};

const inFlightRefreshes = new Map<string, Promise<PlexCacheRefreshResult>>();

// ============================================================================
// Refresher
// ============================================================================

/**
 * Refresh the PlexCache for a given instance.
 */
export function refreshPlexCache(
	client: PlexClient,
	prisma: PrismaClient,
	instanceId: string,
	log: FastifyBaseLogger,
	expectedConnection?: ProviderConnectionIdentity,
): Promise<PlexCacheRefreshResult> {
	const key = `${instanceId}:${expectedConnection?.service ?? "PLEX"}:${expectedConnection?.connectionGeneration ?? "unguarded"}:${expectedConnection?.connectionFingerprint ?? "unguarded"}`;
	const existing = inFlightRefreshes.get(key);
	if (existing) return existing;

	const pending = performPlexCacheRefresh(client, prisma, instanceId, log, expectedConnection);
	inFlightRefreshes.set(key, pending);
	void pending.finally(() => inFlightRefreshes.delete(key)).catch(() => undefined);
	return pending;
}

export function clearPlexCacheRefreshSingleFlightsForTests(): void {
	inFlightRefreshes.clear();
}

async function performPlexCacheRefresh(
	client: PlexClient,
	prisma: PrismaClient,
	instanceId: string,
	log: FastifyBaseLogger,
	expectedConnection?: ProviderConnectionIdentity,
): Promise<PlexCacheRefreshResult> {
	let upserted = 0;
	let errors = 0;
	let complete = true;
	let completedAt: Date | undefined;
	let superseded = false;
	const errorMessages: string[] = [];

	try {
		// 1. Build accountId → username map
		const accounts = await client.getAccounts();
		if (accounts.length === 0) {
			complete = false;
			errors++;
			errorMessages.push("Plex returned no user accounts");
			log.warn({ instanceId }, "Plex cache refresh: no user accounts discovered");
		}
		const accountMap = new Map<number, string>();
		for (const account of accounts) {
			accountMap.set(account.id, account.name);
		}

		// 2. Get library sections (movie and show only)
		const sections = await client.getLibrarySections();
		const mediaLibs = sections.filter((s) => s.type === "movie" || s.type === "show");
		if (mediaLibs.length === 0) {
			complete = false;
			errors++;
			errorMessages.push("Plex returned no movie or show libraries");
			log.warn({ instanceId }, "Plex cache refresh: no movie or show libraries discovered");
		}

		// 3. Build ratingKey → item data (TMDB ID, media type, rating, section)
		const ratingKeyMap = new Map<
			string,
			{
				tmdbId: number;
				mediaType: "movie" | "series";
				ratingKey: string;
				title: string;
				userRating: number | null;
				sectionId: string;
				sectionTitle: string;
				collections: string[];
				labels: string[];
				addedAt: number | null;
				thumb: string | null;
			}
		>();

		for (const lib of mediaLibs) {
			try {
				const items = await client.getLibraryItems(lib.key);
				for (const item of items) {
					const tmdbId = parsePlexTmdbId(item.Guid);
					if (!tmdbId) {
						complete = false;
						errorMessages.push("Plex returned a current library item without a TMDb mapping");
						continue;
					}

					const mediaType: "movie" | "series" = item.type === "movie" ? "movie" : "series";
					ratingKeyMap.set(item.ratingKey, {
						tmdbId,
						mediaType,
						ratingKey: item.ratingKey,
						title: item.title,
						userRating: item.userRating ?? null,
						sectionId: lib.key,
						sectionTitle: lib.title,
						collections: item.Collection?.map((c) => c.tag) ?? [],
						labels: item.Label?.map((l) => l.tag) ?? [],
						addedAt: item.addedAt ?? null,
						thumb: item.thumb ?? null,
					});
				}
			} catch (err) {
				complete = false;
				const msg = `Failed to fetch library "${lib.title}": ${getErrorMessage(err)}`;
				log.warn({ err, sectionId: lib.key, sectionTitle: lib.title }, msg);
				errors++;
				errorMessages.push(msg);
			}
		}

		// 4. Get history and aggregate (per-section: key includes sectionId)
		const history = await client.getHistory({ maxResults: 100_000, requireComplete: true });
		const historyCount = history.length;
		const aggregations = new Map<string, ItemAggregation>();

		for (const entry of history) {
			// For episodes, use the show's ratingKey
			const isEpisode = entry.type === "episode";
			const itemRatingKey = isEpisode
				? (entry.grandparentRatingKey ?? entry.ratingKey)
				: entry.ratingKey;

			const itemData = ratingKeyMap.get(itemRatingKey);
			if (!itemData) {
				if (entry.type === "movie" || entry.type === "episode") {
					complete = false;
					errorMessages.push(
						"Plex history item could not be mapped to the current library snapshot",
					);
				}
				continue;
			}

			const aggKey = `${itemData.mediaType}:${itemData.tmdbId}:${itemData.sectionId}`;
			const username = accountMap.get(entry.accountID);
			if (!username) {
				complete = false;
				errorMessages.push("Plex history item could not be attributed to a current user");
				continue;
			}

			const existing = aggregations.get(aggKey);
			if (existing) {
				existing.watchCount++;
				existing.watchedByUsers.add(username);
				const watchedAt = new Date(entry.viewedAt * 1000);
				if (!existing.lastWatchedAt || watchedAt > existing.lastWatchedAt) {
					existing.lastWatchedAt = watchedAt;
				}
			} else {
				aggregations.set(aggKey, {
					tmdbId: itemData.tmdbId,
					mediaType: itemData.mediaType,
					sectionId: itemData.sectionId,
					sectionTitle: itemData.sectionTitle,
					title: itemData.title,
					ratingKey: itemData.ratingKey,
					lastWatchedAt: new Date(entry.viewedAt * 1000),
					watchCount: 1,
					watchedByUsers: new Set([username]),
					onDeck: false,
					userRating: itemData.userRating,
					collections: itemData.collections,
					labels: itemData.labels,
					addedAt: itemData.addedAt ? new Date(itemData.addedAt * 1000) : null,
					thumb: itemData.thumb,
				});
			}
		}

		// Ensure all library items are in aggregations (even if unwatched)
		for (const [_ratingKey, itemData] of ratingKeyMap) {
			const aggKey = `${itemData.mediaType}:${itemData.tmdbId}:${itemData.sectionId}`;
			if (!aggregations.has(aggKey)) {
				aggregations.set(aggKey, {
					tmdbId: itemData.tmdbId,
					mediaType: itemData.mediaType,
					sectionId: itemData.sectionId,
					sectionTitle: itemData.sectionTitle,
					title: itemData.title,
					ratingKey: itemData.ratingKey,
					lastWatchedAt: null,
					watchCount: 0,
					watchedByUsers: new Set(),
					onDeck: false,
					userRating: itemData.userRating,
					collections: itemData.collections,
					labels: itemData.labels,
					addedAt: itemData.addedAt ? new Date(itemData.addedAt * 1000) : null,
					thumb: itemData.thumb,
				});
			}
		}

		// 5. Get on-deck items and mark
		let verifiedOnDeckSignature: string[] = [];
		try {
			const onDeckItems = await client.getOnDeck();
			verifiedOnDeckSignature = onDeckSignature(onDeckItems);
			for (const deckItem of onDeckItems) {
				// For episodes, use the show's ratingKey
				const itemRatingKey =
					deckItem.type === "episode"
						? (deckItem.grandparentRatingKey ?? deckItem.ratingKey)
						: deckItem.ratingKey;

				const itemData = ratingKeyMap.get(itemRatingKey);
				if (!itemData) {
					if (deckItem.type === "movie" || deckItem.type === "episode") {
						complete = false;
						errorMessages.push(
							"Plex on-deck item could not be mapped to the current library snapshot",
						);
					}
					continue;
				}

				const aggKey = `${itemData.mediaType}:${itemData.tmdbId}:${itemData.sectionId}`;
				const agg = aggregations.get(aggKey);
				if (agg) {
					agg.onDeck = true;
				}
			}
		} catch (err) {
			complete = false;
			errors++;
			errorMessages.push(`Failed to fetch Plex on-deck items: ${getErrorMessage(err)}`);
			log.warn({ err }, "Failed to fetch Plex on-deck items");
		}

		// Release ratingKeyMap — all data now lives in aggregations (#239)
		const libraryItemCount = ratingKeyMap.size;
		ratingKeyMap.clear();

		// 6. Publish a fully gathered generation as one replacement. Any incomplete
		// dependency snapshot leaves the previous successful cache untouched.
		const aggregationsArray = [...aggregations.values()];
		// Release Map hash table — aggregationsArray now owns all references (#239)
		aggregations.clear();

		if (errors === 0 && complete) {
			await client.verifyHistorySnapshot(history);
			const latestOnDeckSignature = onDeckSignature(await client.getOnDeck());
			if (JSON.stringify(latestOnDeckSignature) !== JSON.stringify(verifiedOnDeckSignature)) {
				throw new Error("Plex on-deck state changed before cache publication");
			}
			completedAt = new Date();
			const generationId = randomUUID();
			const generationMetadata = JSON.stringify({
				sections: mediaLibs
					.map((section) => ({
						key: section.key,
						title: section.title,
						type: section.type,
					}))
					.sort(
						(left, right) =>
							left.key.localeCompare(right.key) ||
							left.title.localeCompare(right.title) ||
							left.type.localeCompare(right.type),
					),
			});
			try {
				const publication = await withCurrentProviderConnection(
					prisma,
					instanceId,
					expectedConnection,
					async (tx) => {
						await tx.plexCache.deleteMany({ where: { instanceId } });
						if (aggregationsArray.length > 0) {
							for (
								let start = 0;
								start < aggregationsArray.length;
								start += PLEX_CACHE_PUBLICATION_CHUNK_SIZE
							) {
								const chunk = aggregationsArray.slice(
									start,
									start + PLEX_CACHE_PUBLICATION_CHUNK_SIZE,
								);
								await tx.plexCache.createMany({
									data: chunk.map((agg) => ({
										instanceId,
										tmdbId: agg.tmdbId,
										mediaType: agg.mediaType,
										sectionId: agg.sectionId,
										sectionTitle: agg.sectionTitle,
										title: agg.title,
										ratingKey: agg.ratingKey,
										lastWatchedAt: agg.lastWatchedAt,
										watchCount: agg.watchCount,
										watchedByUsers: JSON.stringify([...agg.watchedByUsers]),
										onDeck: agg.onDeck,
										userRating: agg.userRating,
										collections: JSON.stringify(agg.collections),
										labels: JSON.stringify(agg.labels),
										addedAt: agg.addedAt,
										thumb: agg.thumb,
									})),
								});
							}
						}
						await tx.cacheRefreshStatus.upsert({
							where: { instanceId_cacheType: { instanceId, cacheType: "plex" } },
							create: {
								instanceId,
								cacheType: "plex",
								lastRefreshedAt: completedAt!,
								lastResult: "success",
								itemCount: aggregationsArray.length,
								generationId,
								generationMetadata,
								lastAttemptAt: completedAt!,
								lastAttemptResult: "success",
							},
							update: {
								lastRefreshedAt: completedAt!,
								lastResult: "success",
								lastErrorMessage: null,
								itemCount: aggregationsArray.length,
								generationId,
								generationMetadata,
								lastAttemptAt: completedAt!,
								lastAttemptResult: "success",
								lastAttemptErrorMessage: null,
							},
						});
					},
				);
				if (publication.matched) {
					upserted = aggregationsArray.length;
				} else {
					superseded = true;
					complete = false;
					completedAt = undefined;
					errorMessages.push("Plex service connection changed during refresh");
				}
			} catch (error) {
				complete = false;
				completedAt = undefined;
				errors++;
				errorMessages.push(`Atomic Plex cache publication failed: ${getErrorMessage(error)}`);
				log.error({ err: error, instanceId }, "Plex cache atomic publication failed");
			}
		} else {
			log.warn(
				{ instanceId, aggregationSize: aggregationsArray.length, errors },
				"Plex cache: skipping publication because the refreshed inventory was incomplete",
			);
		}

		log.info(
			{
				instanceId,
				totalLibraryItems: libraryItemCount,
				totalHistory: historyCount,
				uniqueItems: aggregationsArray.length,
				upserted,
				errors,
			},
			"Plex cache refresh complete",
		);
	} catch (error) {
		complete = false;
		const msg = `Plex cache refresh failed: ${getErrorMessage(error)}`;
		log.error({ err: error, instanceId }, msg);
		errors++;
		errorMessages.push(msg);
	}

	return {
		upserted,
		errors,
		errorMessages,
		complete: complete && errors === 0,
		completedAt,
		superseded: superseded || undefined,
	};
}

// ============================================================================
// Stale Row Eviction
// ============================================================================

/**
 * Chunk size for `id: { in: ... }` deletes. Stays well below SQLite's
 * historical SQLITE_MAX_VARIABLE_NUMBER (999) so no single DELETE statement
 * can exceed the parameter limit, regardless of library size or SQLite build.
 *
 * Exported for tests.
 */
export const STALE_EVICTION_CHUNK_SIZE = 500;

/**
 * Evict rows for `instanceId` whose `id` is not in `keepIds`.
 *
 * Reads existing row ids, diffs in memory, then issues bounded `id: { in: chunk }`
 * deletes. This avoids Prisma P2029 on SQLite when `keepIds` would have been a
 * giant `notIn` parameter list (issue #323).
 *
 * Exported for tests.
 */
export async function evictStaleRows(
	prisma: PrismaClient,
	instanceId: string,
	keepIds: string[],
): Promise<number> {
	const existing = await prisma.plexCache.findMany({
		where: { instanceId },
		select: { id: true },
	});

	const keepSet = new Set(keepIds);
	const staleIds: string[] = [];
	for (const row of existing) {
		if (!keepSet.has(row.id)) staleIds.push(row.id);
	}

	if (staleIds.length === 0) return 0;

	let totalDeleted = 0;
	for (let i = 0; i < staleIds.length; i += STALE_EVICTION_CHUNK_SIZE) {
		const chunk = staleIds.slice(i, i + STALE_EVICTION_CHUNK_SIZE);
		const { count } = await prisma.plexCache.deleteMany({
			where: { instanceId, id: { in: chunk } },
		});
		totalDeleted += count;
	}
	return totalDeleted;
}
