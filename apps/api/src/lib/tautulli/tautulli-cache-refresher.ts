/**
 * Tautulli Cache Refresher
 *
 * Fetches watch history from Tautulli and upserts into the TautulliCache table.
 * This provides a materialized view of watch data for cleanup rule evaluation.
 *
 * Strategy:
 * 1. Get all Tautulli libraries
 * 2. For each library, paginate through watch history
 * 3. For each unique rating_key, fetch metadata to get TMDB GUID
 * 4. Aggregate per-item stats (last watched, total plays, unique users)
 * 5. Upsert into TautulliCache keyed by (instanceId, tmdbId, mediaType)
 */

import type { FastifyBaseLogger } from "fastify";
import type { PrismaClient } from "../prisma.js";
import { delay } from "../utils/delay.js";
import type { TautulliClient, TautulliHistoryItem } from "./tautulli-client.js";

// Maximum pages of history to fetch per library (50 items per page)
const MAX_HISTORY_PAGES = 20;
const HISTORY_PAGE_SIZE = 50;

// Rate limit: max metadata lookups per refresh cycle
const MAX_METADATA_LOOKUPS = 500;

/** Parsed TMDB ID from Tautulli GUIDs */
interface ParsedGuid {
	tmdbId: number;
	mediaType: "movie" | "series";
}

/**
 * Refresh the TautulliCache for a given instance.
 * Fetches history from Tautulli and aggregates into per-item watch stats.
 */
export async function refreshTautulliCache(
	client: TautulliClient,
	prisma: PrismaClient,
	instanceId: string,
	log: FastifyBaseLogger,
): Promise<{ upserted: number; errors: number }> {
	let upserted = 0;
	let errors = 0;

	try {
		// 1. Get libraries to iterate over
		const libraries = await client.getLibraries();
		const movieAndShowLibs = libraries.filter(
			(lib) => lib.section_type === "movie" || lib.section_type === "show",
		);

		// 2. Collect all history items across libraries
		const allHistory: TautulliHistoryItem[] = [];
		for (const lib of movieAndShowLibs) {
			for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
				const result = await client.getHistory({
					section_id: lib.section_id,
					length: HISTORY_PAGE_SIZE,
					start: page * HISTORY_PAGE_SIZE,
				});

				allHistory.push(...result.data);
				if (result.data.length < HISTORY_PAGE_SIZE) break;
				if (page === MAX_HISTORY_PAGES - 1) {
					log.warn(
						{ sectionId: lib.section_id, limit: MAX_HISTORY_PAGES * HISTORY_PAGE_SIZE },
						"Tautulli history page cap reached — watch data may be incomplete for this library",
					);
				}
			}
		}

		// 3. Group history by rating_key (for movies) or grandparent_rating_key (for shows)
		const itemMap = new Map<
			string,
			{
				ratingKey: string;
				isShow: boolean;
				users: Set<string>;
				lastDate: number;
				playCount: number;
			}
		>();

		for (const item of allHistory) {
			const isShow = item.media_type === "episode";
			// For episodes, use the show's rating key; for movies, use the item's
			const key = isShow ? item.grandparent_rating_key : item.rating_key;
			if (!key) continue;

			const existing = itemMap.get(key);
			if (existing) {
				existing.users.add(item.user);
				existing.lastDate = Math.max(existing.lastDate, item.date);
				existing.playCount++;
			} else {
				itemMap.set(key, {
					ratingKey: key,
					isShow,
					users: new Set([item.user]),
					lastDate: item.date,
					playCount: 1,
				});
			}
		}

		// 4. For each unique item, look up TMDB ID via metadata
		let lookupCount = 0;
		const ratingKeyToGuid = new Map<string, ParsedGuid>();

		for (const [ratingKey, info] of itemMap) {
			if (lookupCount >= MAX_METADATA_LOOKUPS) {
				log.warn(
					{ limit: MAX_METADATA_LOOKUPS },
					"Tautulli cache refresh: hit metadata lookup limit",
				);
				break;
			}

			try {
				if (lookupCount > 0) await delay(50);
				const metadata = await client.getMetadata(ratingKey);
				lookupCount++;

				const guid = parseTmdbGuid(metadata.guids);
				if (guid) {
					// Override mediaType based on actual Tautulli data
					guid.mediaType = info.isShow ? "series" : "movie";
					ratingKeyToGuid.set(ratingKey, guid);
				}
			} catch (error) {
				errors++;
				log.warn(
					{ err: error, ratingKey },
					"Tautulli cache: failed to fetch metadata for item",
				);
			}
		}

		// 5. Upsert into TautulliCache
		for (const [ratingKey, info] of itemMap) {
			const guid = ratingKeyToGuid.get(ratingKey);
			if (!guid) continue;

			try {
				await prisma.tautulliCache.upsert({
					where: {
						instanceId_tmdbId_mediaType: {
							instanceId,
							tmdbId: guid.tmdbId,
							mediaType: guid.mediaType,
						},
					},
					create: {
						instanceId,
						tmdbId: guid.tmdbId,
						mediaType: guid.mediaType,
						lastWatchedAt: new Date(info.lastDate * 1000),
						watchCount: info.playCount,
						watchedByUsers: JSON.stringify([...info.users]),
					},
					update: {
						lastWatchedAt: new Date(info.lastDate * 1000),
						watchCount: info.playCount,
						watchedByUsers: JSON.stringify([...info.users]),
					},
				});
				upserted++;
			} catch (error) {
				errors++;
				log.warn(
					{ err: error, instanceId, tmdbId: guid.tmdbId, mediaType: guid.mediaType },
					"Tautulli cache: failed to upsert item",
				);
			}
		}

		log.info(
			{
				instanceId,
				totalHistory: allHistory.length,
				uniqueItems: itemMap.size,
				upserted,
				errors,
			},
			"Tautulli cache refresh complete",
		);
	} catch (error) {
		log.error({ err: error, instanceId }, "Tautulli cache refresh failed");
		errors++;
	}

	return { upserted, errors };
}

/**
 * Parse TMDB ID from Tautulli's GUIDs array.
 * GUIDs look like: ["tmdb://12345", "imdb://tt1234567", "tvdb://67890"]
 */
function parseTmdbGuid(guids: string[] | undefined): ParsedGuid | null {
	if (!guids) return null;

	for (const guid of guids) {
		const match = guid.match(/^tmdb:\/\/(\d+)$/);
		if (match?.[1]) {
			return {
				tmdbId: Number.parseInt(match[1], 10),
				mediaType: "movie", // Will be overridden by caller
			};
		}
	}

	return null;
}
