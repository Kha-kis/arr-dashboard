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

// Tautulli exposes offset/length pagination without a documented page-count
// ceiling. Bound both the aggregate inventory and requests for the whole
// refresh so multiple libraries cannot multiply the safety limit.
const MAX_HISTORY_RESULTS = 100_000;
const HISTORY_PAGE_SIZE = 200;
const MAX_HISTORY_REQUESTS = 1_000;

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

		// 2. Probe every library first and freeze an oldest-first snapshot. New
		// plays append after that snapshot, so they cannot shift later pages.
		const allHistory: TautulliHistoryItem[] = [];
		const historyPlans: Array<{
			sectionId: string;
			expectedRows: number;
			firstPage: TautulliHistoryItem[];
			rowSignatures: string[];
		}> = [];
		let expectedHistoryRows = 0;
		let historyRequests = 0;
		for (const lib of movieAndShowLibs) {
			historyRequests++;
			if (historyRequests > MAX_HISTORY_REQUESTS) {
				throw new Error(
					`Tautulli history exceeded the safe ${MAX_HISTORY_REQUESTS}-request refresh limit`,
				);
			}
			const firstResult = await client.getHistory({
				section_id: lib.section_id,
				length: HISTORY_PAGE_SIZE,
				start: 0,
				order_column: "row_id",
				order_dir: "asc",
				grouping: 0,
				include_activity: 0,
			});
			if (
				!Number.isSafeInteger(firstResult.recordsFiltered) ||
				firstResult.recordsFiltered < 0 ||
				!Number.isSafeInteger(firstResult.recordsTotal) ||
				firstResult.recordsTotal < firstResult.recordsFiltered
			) {
				throw new Error(`Tautulli history returned invalid totals for library ${lib.section_id}`);
			}
			if (
				firstResult.data.length > HISTORY_PAGE_SIZE ||
				firstResult.data.length > firstResult.recordsFiltered
			) {
				throw new Error(
					`Tautulli history exceeded the requested page or declared total for library ${lib.section_id}`,
				);
			}
			expectedHistoryRows += firstResult.recordsFiltered;
			if (expectedHistoryRows > MAX_HISTORY_RESULTS) {
				throw new Error(
					`Tautulli history contains ${expectedHistoryRows} aggregate rows, exceeding the safe ${MAX_HISTORY_RESULTS}-row refresh limit`,
				);
			}
			historyPlans.push({
				sectionId: lib.section_id,
				expectedRows: firstResult.recordsFiltered,
				firstPage: firstResult.data,
				rowSignatures: [],
			});
		}

		const historySignature = (item: TautulliHistoryItem): string =>
			JSON.stringify([
				item.row_id,
				item.rating_key,
				item.parent_rating_key,
				item.grandparent_rating_key,
				item.media_type,
				item.user,
				item.date,
				item.play_count ?? null,
			]);
		const assertUngroupedHistoryRow = (item: TautulliHistoryItem, sectionId: string): void => {
			if (!Number.isSafeInteger(item.row_id) || item.row_id === undefined || item.row_id < 0) {
				throw new Error(
					`Tautulli history did not provide a stable row identity for library ${sectionId}`,
				);
			}
			if ((item.group_count !== undefined && item.group_count > 1) || (item.play_count ?? 1) > 1) {
				throw new Error(`Tautulli history returned grouped play rows for library ${sectionId}`);
			}
		};

		for (const plan of historyPlans) {
			let fetchedRows = 0;
			let previousRowId = -1;
			const seenHistoryRows = new Set<string>();
			let result = {
				data: plan.firstPage,
				recordsFiltered: plan.expectedRows,
				recordsTotal: plan.expectedRows,
			};
			while (fetchedRows < plan.expectedRows) {
				const requestedRows = Math.min(HISTORY_PAGE_SIZE, plan.expectedRows - fetchedRows);
				if (fetchedRows > 0) {
					historyRequests++;
					if (historyRequests > MAX_HISTORY_REQUESTS) {
						throw new Error(
							`Tautulli history exceeded the safe ${MAX_HISTORY_REQUESTS}-request refresh limit`,
						);
					}
					result = await client.getHistory({
						section_id: plan.sectionId,
						length: requestedRows,
						start: fetchedRows,
						order_column: "row_id",
						order_dir: "asc",
						grouping: 0,
						include_activity: 0,
					});
				}

				if (
					!Number.isSafeInteger(result.recordsFiltered) ||
					result.recordsFiltered < 0 ||
					!Number.isSafeInteger(result.recordsTotal) ||
					result.recordsTotal < result.recordsFiltered
				) {
					throw new Error(`Tautulli history returned invalid totals for library ${plan.sectionId}`);
				}
				if (result.data.length > requestedRows) {
					throw new Error(
						`Tautulli history exceeded the requested page size for library ${plan.sectionId}`,
					);
				}
				if (result.recordsFiltered < plan.expectedRows) {
					throw new Error(`Tautulli history shrank while paging library ${plan.sectionId}`);
				}
				if (fetchedRows + result.data.length > plan.expectedRows) {
					throw new Error(
						`Tautulli history exceeded its frozen total for library ${plan.sectionId}`,
					);
				}
				for (const item of result.data) {
					assertUngroupedHistoryRow(item, plan.sectionId);
					if (item.row_id! <= previousRowId) {
						throw new Error(
							`Tautulli history did not honor stable row ordering for library ${plan.sectionId}`,
						);
					}
					previousRowId = item.row_id!;
					const rowIdentity = String(item.row_id);
					if (seenHistoryRows.has(rowIdentity)) {
						throw new Error(
							`Tautulli history returned a duplicate row while paging library ${plan.sectionId}`,
						);
					}
					seenHistoryRows.add(rowIdentity);
					plan.rowSignatures.push(historySignature(item));
					allHistory.push(item);
				}
				fetchedRows += result.data.length;
				if (fetchedRows === plan.expectedRows) break;
				if (result.data.length < requestedRows) {
					throw new Error(
						`Tautulli history stopped before its frozen total for library ${plan.sectionId}`,
					);
				}
			}
		}

		const verifyCompleteHistorySnapshot = async (): Promise<void> => {
			for (const plan of historyPlans) {
				let fetchedRows = 0;
				let previousRowId = -1;
				const seenRows = new Set<string>();
				const signatures: string[] = [];
				do {
					historyRequests++;
					if (historyRequests > MAX_HISTORY_REQUESTS) {
						throw new Error(
							`Tautulli history exceeded the safe ${MAX_HISTORY_REQUESTS}-request refresh limit`,
						);
					}
					const expectedPageRows = Math.min(HISTORY_PAGE_SIZE, plan.expectedRows - fetchedRows);
					const result = await client.getHistory({
						section_id: plan.sectionId,
						length: Math.max(1, expectedPageRows),
						start: fetchedRows,
						order_column: "row_id",
						order_dir: "asc",
						grouping: 0,
						include_activity: 0,
					});
					if (
						result.recordsFiltered !== plan.expectedRows ||
						!Number.isSafeInteger(result.recordsTotal) ||
						result.recordsTotal < result.recordsFiltered ||
						result.data.length !== expectedPageRows
					) {
						throw new Error(
							`Tautulli history changed before the snapshot for library ${plan.sectionId} could be verified`,
						);
					}
					for (const item of result.data) {
						assertUngroupedHistoryRow(item, plan.sectionId);
						if (item.row_id! <= previousRowId) {
							throw new Error(
								`Tautulli history did not honor stable row ordering for library ${plan.sectionId}`,
							);
						}
						previousRowId = item.row_id!;
						const rowIdentity = String(item.row_id);
						if (seenRows.has(rowIdentity)) {
							throw new Error(
								`Tautulli history returned a duplicate row while verifying library ${plan.sectionId}`,
							);
						}
						seenRows.add(rowIdentity);
						signatures.push(historySignature(item));
					}
					fetchedRows += result.data.length;
				} while (fetchedRows < plan.expectedRows);

				if (
					JSON.stringify([...signatures].sort()) !== JSON.stringify([...plan.rowSignatures].sort())
				) {
					throw new Error(
						`Tautulli history changed before the snapshot for library ${plan.sectionId} could be verified`,
					);
				}
			}
		};

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
			// Metadata lookups can take long enough for watch history to change.
			// Re-read the entire snapshot immediately before publication.
			await verifyCompleteHistorySnapshot();
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
