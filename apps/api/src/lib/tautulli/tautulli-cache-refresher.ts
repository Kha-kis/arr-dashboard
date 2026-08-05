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

import type { TautulliHistoryItem } from "@arr/shared";
import type { FastifyBaseLogger } from "fastify";
import type { PrismaClient } from "../prisma.js";
import { delay } from "../utils/delay.js";
import { getErrorMessage } from "../utils/error-message.js";
import type { TautulliClient } from "./tautulli-client.js";

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
): Promise<{
	upserted: number;
	errors: number;
	errorMessages: string[];
	complete: boolean;
	completedAt?: Date;
}> {
	let upserted = 0;
	let errors = 0;
	let complete = true;
	const errorMessages: string[] = [];

	try {
		// 1. Get libraries to iterate over
		const libraries = await client.getLibraries();
		const movieAndShowLibs = libraries.filter(
			(lib) => lib.section_type === "movie" || lib.section_type === "show",
		);
		if (movieAndShowLibs.length === 0) {
			complete = false;
			errors++;
			errorMessages.push("Tautulli returned no movie or show libraries");
			log.warn({ instanceId }, "Tautulli cache refresh: no movie or show libraries discovered");
		}

		// 2. Collect all history items across libraries
		const allHistory: TautulliHistoryItem[] = [];
		for (const lib of movieAndShowLibs) {
			let expectedRows: number | undefined;
			let fetchedRows = 0;
			const seenHistoryRows = new Set<string>();
			for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
				const result = await client.getHistory({
					section_id: lib.section_id,
					length: HISTORY_PAGE_SIZE,
					start: page * HISTORY_PAGE_SIZE,
				});

				if (
					!Number.isSafeInteger(result.recordsFiltered) ||
					result.recordsFiltered < 0 ||
					!Number.isSafeInteger(result.recordsTotal) ||
					result.recordsTotal < result.recordsFiltered
				) {
					throw new Error(`Tautulli history returned invalid totals for library ${lib.section_id}`);
				}
				if (result.data.length > HISTORY_PAGE_SIZE) {
					throw new Error(
						`Tautulli history exceeded the requested page size for library ${lib.section_id}`,
					);
				}
				if (expectedRows === undefined) {
					expectedRows = result.recordsFiltered;
					if (expectedRows > MAX_HISTORY_PAGES * HISTORY_PAGE_SIZE) {
						complete = false;
						errors++;
						errorMessages.push(
							`Tautulli history exceeded ${MAX_HISTORY_PAGES * HISTORY_PAGE_SIZE} rows for library ${lib.section_id}`,
						);
						log.warn(
							{ sectionId: lib.section_id, limit: MAX_HISTORY_PAGES * HISTORY_PAGE_SIZE },
							"Tautulli history page cap reached — watch data may be incomplete for this library",
						);
					}
				} else if (result.recordsFiltered !== expectedRows) {
					throw new Error(`Tautulli history changed while paging library ${lib.section_id}`);
				}
				if (fetchedRows + result.data.length > expectedRows) {
					throw new Error(
						`Tautulli history exceeded its declared total for library ${lib.section_id}`,
					);
				}
				for (const item of result.data) {
					const rowFingerprint = JSON.stringify([
						item.rating_key,
						item.parent_rating_key,
						item.grandparent_rating_key,
						item.media_type,
						item.user,
						item.date,
						item.play_count ?? null,
					]);
					if (seenHistoryRows.has(rowFingerprint)) {
						throw new Error(
							`Tautulli history returned a duplicate row while paging library ${lib.section_id}`,
						);
					}
					seenHistoryRows.add(rowFingerprint);
					allHistory.push(item);
				}
				fetchedRows += result.data.length;
				if (fetchedRows === expectedRows) break;
				if (result.data.length === 0 || result.data.length < HISTORY_PAGE_SIZE) {
					throw new Error(
						`Tautulli history stopped before its declared total for library ${lib.section_id}`,
					);
				}
			}
			if (expectedRows === undefined || fetchedRows !== expectedRows) {
				complete = false;
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
			if (item.media_type !== "movie" && item.media_type !== "episode") {
				complete = false;
				continue;
			}
			const isShow = item.media_type === "episode";
			// For episodes, use the show's rating key; for movies, use the item's
			const key = isShow ? item.grandparent_rating_key : item.rating_key;
			if (!key) {
				complete = false;
				continue;
			}

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
		if (itemMap.size > MAX_METADATA_LOOKUPS) {
			complete = false;
			errors++;
			errorMessages.push(
				`Tautulli metadata inventory exceeded ${MAX_METADATA_LOOKUPS} unique items`,
			);
			log.warn(
				{ limit: MAX_METADATA_LOOKUPS, itemCount: itemMap.size },
				"Tautulli cache refresh: hit metadata lookup limit",
			);
		}

		for (const [ratingKey, info] of itemMap) {
			if (lookupCount >= MAX_METADATA_LOOKUPS) {
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
				} else {
					complete = false;
				}
			} catch (error) {
				complete = false;
				errors++;
				log.warn({ err: error, ratingKey }, "Tautulli cache: failed to fetch metadata for item");
				if (errorMessages.length < 5) {
					errorMessages.push(
						`Failed to fetch metadata for ratingKey ${ratingKey}: ${getErrorMessage(error)}`,
					);
				}
			}
		}

		// 5. Stage every row, then publish a complete replacement atomically.
		const rows: Array<{
			instanceId: string;
			tmdbId: number;
			mediaType: "movie" | "series";
			lastWatchedAt: Date;
			watchCount: number;
			watchedByUsers: string;
		}> = [];
		for (const [ratingKey, info] of itemMap) {
			const guid = ratingKeyToGuid.get(ratingKey);
			if (!guid) continue;
			rows.push({
				instanceId,
				tmdbId: guid.tmdbId,
				mediaType: guid.mediaType,
				lastWatchedAt: new Date(info.lastDate * 1000),
				watchCount: info.playCount,
				watchedByUsers: JSON.stringify([...info.users].sort()),
			});
		}

		let completedAt: Date | undefined;
		if (errors === 0 && complete) {
			completedAt = new Date();
			try {
				await prisma.$transaction(async (tx) => {
					await tx.tautulliCache.deleteMany({ where: { instanceId } });
					if (rows.length > 0) await tx.tautulliCache.createMany({ data: rows });
					await tx.cacheRefreshStatus.upsert({
						where: { instanceId_cacheType: { instanceId, cacheType: "tautulli" } },
						create: {
							instanceId,
							cacheType: "tautulli",
							lastRefreshedAt: completedAt!,
							lastResult: "success",
							itemCount: rows.length,
							lastAttemptAt: completedAt!,
							lastAttemptResult: "success",
						},
						update: {
							lastRefreshedAt: completedAt!,
							lastResult: "success",
							lastErrorMessage: null,
							itemCount: rows.length,
							lastAttemptAt: completedAt!,
							lastAttemptResult: "success",
							lastAttemptErrorMessage: null,
						},
					});
				});
				upserted = rows.length;
			} catch (error) {
				completedAt = undefined;
				complete = false;
				errors++;
				errorMessages.push(`Atomic cache publication failed: ${getErrorMessage(error)}`);
				log.error({ err: error, instanceId }, "Tautulli cache publication failed");
			}
		} else {
			log.warn({ instanceId, errors }, "Skipping cache publication due to incomplete refresh");
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
		return { upserted, errors, errorMessages, complete: complete && errors === 0, completedAt };
	} catch (error) {
		complete = false;
		log.error({ err: error, instanceId }, "Tautulli cache refresh failed");
		errors++;
		errorMessages.push(`Tautulli cache refresh failed: ${getErrorMessage(error)}`);
	}

	return { upserted, errors, errorMessages, complete: false };
}

// ============================================================================
// Stale Row Eviction
// ============================================================================

/**
 * Chunk size for `id: { in: ... }` deletes. Stays well below SQLite's historical
 * SQLITE_MAX_VARIABLE_NUMBER (999) so no single DELETE statement can exceed the
 * parameter limit. Mirrors the constant used for the Plex refresher (PR #328)
 * — kept local rather than shared so each cache subsystem can tune independently.
 *
 * Exported for tests.
 */
export const STALE_EVICTION_CHUNK_SIZE = 500;

/**
 * Evict rows for `instanceId` whose `id` is not in `keepIds`.
 *
 * Reads existing row ids, diffs in memory, then issues bounded `id: { in: chunk }`
 * deletes. This avoids Prisma P2029 on SQLite when `keepIds` would have been a
 * giant `notIn` parameter list — proactive hardening mirroring the Plex fix
 * from PR #328.
 *
 * Exported for tests.
 */
export async function evictStaleRows(
	prisma: PrismaClient,
	instanceId: string,
	keepIds: string[],
): Promise<number> {
	const existing = await prisma.tautulliCache.findMany({
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
		const { count } = await prisma.tautulliCache.deleteMany({
			where: { instanceId, id: { in: chunk } },
		});
		totalDeleted += count;
	}
	return totalDeleted;
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
