/**
 * Plex Cache Refresher
 *
 * Fetches watch history, on-deck status, and user ratings from Plex
 * and upserts into the PlexCache table. This provides a materialized
 * view of Plex data for cleanup rule evaluation.
 *
 * Strategy:
 * 1. Get accounts → build accountId→username map
 * 2. Get library sections → filter movie/show sections
 * 3. For each section: get library items → extract TMDB GUIDs and ratings
 * 4. Get history → group by ratingKey, map accountId→username
 * 5. Get on-deck → set of ratingKeys currently on-deck
 * 6. Upsert into PlexCache
 */

import type { FastifyBaseLogger } from "fastify";
import { getErrorMessage } from "../utils/error-message.js";
import type { PrismaClient } from "../prisma.js";
import type { PlexClient } from "./plex-client.js";

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

// ============================================================================
// Refresher
// ============================================================================

/**
 * Refresh the PlexCache for a given instance.
 */
export async function refreshPlexCache(
	client: PlexClient,
	prisma: PrismaClient,
	instanceId: string,
	log: FastifyBaseLogger,
): Promise<{ upserted: number; errors: number; errorMessages: string[] }> {
	let upserted = 0;
	let errors = 0;
	const errorMessages: string[] = [];

	try {
		// 1. Build accountId → username map
		const accounts = await client.getAccounts();
		const accountMap = new Map<number, string>();
		for (const account of accounts) {
			accountMap.set(account.id, account.name);
		}

		// 2. Get library sections (movie and show only)
		const sections = await client.getLibrarySections();
		const mediaLibs = sections.filter((s) => s.type === "movie" || s.type === "show");

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
					if (!tmdbId) continue;

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
				const msg = `Failed to fetch library "${lib.title}": ${getErrorMessage(err)}`;
				log.warn({ err, sectionId: lib.key, sectionTitle: lib.title }, msg);
				errors++;
				errorMessages.push(msg);
			}
		}

		// 4. Get history and aggregate (per-section: key includes sectionId)
		const history = await client.getHistory({ maxResults: 5000 });
		const aggregations = new Map<string, ItemAggregation>();

		for (const entry of history) {
			// For episodes, use the show's ratingKey
			const isEpisode = entry.type === "episode";
			const itemRatingKey = isEpisode
				? (entry.grandparentRatingKey ?? entry.ratingKey)
				: entry.ratingKey;

			const itemData = ratingKeyMap.get(itemRatingKey);
			if (!itemData) continue;

			const aggKey = `${itemData.mediaType}:${itemData.tmdbId}:${itemData.sectionId}`;
			const username = accountMap.get(entry.accountID) ?? `account-${entry.accountID}`;

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
		try {
			const onDeckItems = await client.getOnDeck();
			for (const deckItem of onDeckItems) {
				// For episodes, use the show's ratingKey
				const itemRatingKey =
					deckItem.type === "episode"
						? (deckItem.grandparentRatingKey ?? deckItem.ratingKey)
						: deckItem.ratingKey;

				const itemData = ratingKeyMap.get(itemRatingKey);
				if (!itemData) continue;

				const aggKey = `${itemData.mediaType}:${itemData.tmdbId}:${itemData.sectionId}`;
				const agg = aggregations.get(aggKey);
				if (agg) {
					agg.onDeck = true;
				}
			}
		} catch (err) {
			log.warn({ err }, "Failed to fetch Plex on-deck items");
		}

		// 6. Upsert into PlexCache in batches (reduces 2000 transactions to ~20)
		const BATCH_SIZE = 100;
		const upsertedIds: string[] = [];
		const aggregationsArray = [...aggregations.values()];

		for (let i = 0; i < aggregationsArray.length; i += BATCH_SIZE) {
			const chunk = aggregationsArray.slice(i, i + BATCH_SIZE);
			try {
				const results = await prisma.$transaction(
					chunk.map((agg) =>
						prisma.plexCache.upsert({
							where: {
								instanceId_tmdbId_mediaType_sectionId: {
									instanceId,
									tmdbId: agg.tmdbId,
									mediaType: agg.mediaType,
									sectionId: agg.sectionId,
								},
							},
							create: {
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
							},
							update: {
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
							},
						}),
					),
				);
				for (const row of results) {
					upsertedIds.push(row.id);
					upserted++;
				}
			} catch (_error) {
				// If a batch fails, fall back to individual upserts for that chunk
				for (const agg of chunk) {
					try {
						const row = await prisma.plexCache.upsert({
							where: {
								instanceId_tmdbId_mediaType_sectionId: {
									instanceId,
									tmdbId: agg.tmdbId,
									mediaType: agg.mediaType,
									sectionId: agg.sectionId,
								},
							},
							create: {
								instanceId, tmdbId: agg.tmdbId, mediaType: agg.mediaType,
								sectionId: agg.sectionId, sectionTitle: agg.sectionTitle,
								title: agg.title, ratingKey: agg.ratingKey,
								lastWatchedAt: agg.lastWatchedAt, watchCount: agg.watchCount,
								watchedByUsers: JSON.stringify([...agg.watchedByUsers]),
								onDeck: agg.onDeck, userRating: agg.userRating,
								collections: JSON.stringify(agg.collections),
								labels: JSON.stringify(agg.labels),
								addedAt: agg.addedAt, thumb: agg.thumb,
							},
							update: {
								sectionTitle: agg.sectionTitle, title: agg.title,
								ratingKey: agg.ratingKey, lastWatchedAt: agg.lastWatchedAt,
								watchCount: agg.watchCount,
								watchedByUsers: JSON.stringify([...agg.watchedByUsers]),
								onDeck: agg.onDeck, userRating: agg.userRating,
								collections: JSON.stringify(agg.collections),
								labels: JSON.stringify(agg.labels),
								addedAt: agg.addedAt, thumb: agg.thumb,
							},
						});
						upsertedIds.push(row.id);
						upserted++;
					} catch (itemError) {
						const msg = `Failed to upsert ${agg.mediaType} tmdb:${agg.tmdbId}: ${getErrorMessage(itemError)}`;
						errors++;
						errorMessages.push(msg);
						log.warn({ err: itemError, instanceId, tmdbId: agg.tmdbId, mediaType: agg.mediaType }, msg);
					}
				}
			}
		}

		// Evict stale rows: items that were in a previous refresh but no longer exist in Plex
		if (upsertedIds.length > 0) {
			const evicted = await prisma.plexCache.deleteMany({
				where: { instanceId, id: { notIn: upsertedIds } },
			});
			if (evicted.count > 0) {
				log.info({ instanceId, evicted: evicted.count }, "Plex cache: evicted stale rows");
			}
		} else if (aggregations.size > 0) {
			log.warn(
				{ instanceId, aggregationSize: aggregations.size, errors },
				"Plex cache: skipping eviction — all upserts failed, stale rows may accumulate",
			);
		}

		log.info(
			{
				instanceId,
				totalLibraryItems: ratingKeyMap.size,
				totalHistory: history.length,
				uniqueItems: aggregations.size,
				upserted,
				errors,
			},
			"Plex cache refresh complete",
		);
	} catch (error) {
		const msg = `Plex cache refresh failed: ${getErrorMessage(error)}`;
		log.error({ err: error, instanceId }, msg);
		errors++;
		errorMessages.push(msg);
	}

	return { upserted, errors, errorMessages };
}
