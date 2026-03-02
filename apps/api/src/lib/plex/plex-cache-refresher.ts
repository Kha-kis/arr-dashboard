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
	ratingKey: string | null;
	lastWatchedAt: Date | null;
	watchCount: number;
	watchedByUsers: Set<string>;
	onDeck: boolean;
	userRating: number | null;
	collections: string[];
	labels: string[];
	addedAt: Date | null;
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
): Promise<{ upserted: number; errors: number }> {
	let upserted = 0;
	let errors = 0;

	try {
		// 1. Build accountId → username map
		const accounts = await client.getAccounts();
		const accountMap = new Map<number, string>();
		for (const account of accounts) {
			accountMap.set(account.id, account.name);
		}

		// 2. Get library sections (movie and show only)
		const sections = await client.getLibrarySections();
		const mediaLibs = sections.filter(
			(s) => s.type === "movie" || s.type === "show",
		);

		// 3. Build ratingKey → item data (TMDB ID, media type, rating, section)
		const ratingKeyMap = new Map<
			string,
			{
				tmdbId: number;
				mediaType: "movie" | "series";
				ratingKey: string;
				userRating: number | null;
				sectionId: string;
				sectionTitle: string;
				collections: string[];
				labels: string[];
				addedAt: number | null;
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
						userRating: item.userRating ?? null,
						sectionId: lib.key,
						sectionTitle: lib.title,
						collections: item.Collection?.map((c) => c.tag) ?? [],
						labels: item.Label?.map((l) => l.tag) ?? [],
						addedAt: item.addedAt ?? null,
					});
				}
			} catch (err) {
				log.warn({ err, sectionId: lib.key, sectionTitle: lib.title }, "Failed to fetch Plex library items");
				errors++;
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
					ratingKey: itemData.ratingKey,
					lastWatchedAt: new Date(entry.viewedAt * 1000),
					watchCount: 1,
					watchedByUsers: new Set([username]),
					onDeck: false,
					userRating: itemData.userRating,
					collections: itemData.collections,
					labels: itemData.labels,
					addedAt: itemData.addedAt ? new Date(itemData.addedAt * 1000) : null,
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
					ratingKey: itemData.ratingKey,
					lastWatchedAt: null,
					watchCount: 0,
					watchedByUsers: new Set(),
					onDeck: false,
					userRating: itemData.userRating,
					collections: itemData.collections,
					labels: itemData.labels,
					addedAt: itemData.addedAt ? new Date(itemData.addedAt * 1000) : null,
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

		// 6. Upsert into PlexCache (per-section rows)
		const upsertedIds: string[] = [];
		for (const agg of aggregations.values()) {
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
						instanceId,
						tmdbId: agg.tmdbId,
						mediaType: agg.mediaType,
						sectionId: agg.sectionId,
						sectionTitle: agg.sectionTitle,
						ratingKey: agg.ratingKey,
						lastWatchedAt: agg.lastWatchedAt,
						watchCount: agg.watchCount,
						watchedByUsers: JSON.stringify([...agg.watchedByUsers]),
						onDeck: agg.onDeck,
						userRating: agg.userRating,
						collections: JSON.stringify(agg.collections),
						labels: JSON.stringify(agg.labels),
						addedAt: agg.addedAt,
					},
					update: {
						sectionTitle: agg.sectionTitle,
						ratingKey: agg.ratingKey,
						lastWatchedAt: agg.lastWatchedAt,
						watchCount: agg.watchCount,
						watchedByUsers: JSON.stringify([...agg.watchedByUsers]),
						onDeck: agg.onDeck,
						userRating: agg.userRating,
						collections: JSON.stringify(agg.collections),
						labels: JSON.stringify(agg.labels),
						addedAt: agg.addedAt,
					},
				});
				upsertedIds.push(row.id);
				upserted++;
			} catch (error) {
				errors++;
				log.warn(
					{ err: error, instanceId, tmdbId: agg.tmdbId, mediaType: agg.mediaType },
					"Plex cache: failed to upsert item",
				);
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
		log.error({ err: error, instanceId }, "Plex cache refresh failed");
		errors++;
	}

	return { upserted, errors };
}
