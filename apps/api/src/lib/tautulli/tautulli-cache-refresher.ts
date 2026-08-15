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
import type { Encryptor } from "../auth/encryption.js";
import type { Prisma, PrismaClient, ServiceInstance } from "../prisma.js";
import { getStoredHttpAuthHeaders } from "../services/http-auth.js";
import {
	createProviderPublicationAuthority,
	type OwnedProviderPublicationSnapshot,
	ProviderIdentityGuardError,
	withGuardedProviderPublication,
} from "../services/provider-identity-guard.js";
import { delay } from "../utils/delay.js";
import { getErrorMessage } from "../utils/error-message.js";
import { TautulliClient } from "./tautulli-client.js";

// Tautulli exposes offset/length pagination without a documented page-count
// ceiling. Bound both the aggregate inventory and requests for the whole
// refresh so multiple libraries cannot multiply the safety limit.
const MAX_HISTORY_RESULTS = 100_000;
const HISTORY_PAGE_SIZE = 200;
const MAX_HISTORY_REQUESTS = 1_000;

// Rate limit: max metadata lookups per refresh cycle
const MAX_METADATA_LOOKUPS = 500;
export const TAUTULLI_CACHE_PUBLICATION_CHUNK_SIZE = 100;

/** Parsed TMDB ID from Tautulli GUIDs */
interface ParsedGuid {
	tmdbId: number;
	mediaType: "movie" | "series";
}

export interface TautulliCacheSnapshotRow {
	instanceId: string;
	tmdbId: number;
	mediaType: "movie" | "series";
	lastWatchedAt: Date;
	watchCount: number;
	watchedByUsers: string;
}

export interface TautulliCacheSnapshot {
	rows: TautulliCacheSnapshotRow[];
}

export interface TautulliPublicationContext {
	prisma: PrismaClient;
	instance: OwnedProviderPublicationSnapshot;
	log: FastifyBaseLogger;
}

export interface TautulliCacheRefreshResult {
	upserted: number;
	errors: number;
	errorMessages: string[];
	complete: boolean;
	completedAt?: Date;
	superseded?: boolean;
	snapshot?: TautulliCacheSnapshot;
}

/**
 * Refresh the TautulliCache for a given instance.
 * Fetches history from Tautulli and aggregates into per-item watch stats.
 */
export function createOwnedTautulliPublicationSnapshot(
	encryptor: Pick<Encryptor, "decrypt">,
	instance: ServiceInstance,
): OwnedProviderPublicationSnapshot {
	if (instance.service !== "TAUTULLI") {
		throw new Error("Tautulli publication requires a Tautulli service instance");
	}
	return {
		...createProviderPublicationAuthority(instance),
		label: instance.label,
		apiKey: encryptor.decrypt({ value: instance.encryptedApiKey, iv: instance.encryptionIv }),
		httpAuthHeaders: getStoredHttpAuthHeaders(encryptor, instance),
	};
}

function tautulliClientForSnapshot(
	instance: OwnedProviderPublicationSnapshot,
	log: FastifyBaseLogger,
): TautulliClient {
	return new TautulliClient(
		instance.baseUrl,
		instance.apiKey,
		log,
		undefined,
		instance.httpAuthHeaders,
	);
}

export async function refreshTautulliCache(
	context: TautulliPublicationContext,
): Promise<TautulliCacheRefreshResult> {
	const { prisma, instance, log } = context;
	try {
		return await withGuardedProviderPublication(
			prisma,
			instance,
			log,
			async () =>
				await collectTautulliCacheLiveEvidence(
					tautulliClientForSnapshot(instance, log),
					instance.id,
					log,
				),
			async (tx, collected) => await publishTautulliCache(tx, instance, collected),
		);
	} catch (error) {
		log.error({ err: error, instanceId: instance.id }, "Tautulli cache publication rejected");
		if (error instanceof ProviderIdentityGuardError && error.code === "PUBLICATION_SUPERSEDED") {
			return { upserted: 0, errors: 0, errorMessages: [], complete: false, superseded: true };
		}
		return {
			upserted: 0,
			errors: 1,
			errorMessages: [
				error instanceof ProviderIdentityGuardError
					? error.message
					: `Atomic cache publication failed: ${getErrorMessage(error)}`,
			],
			complete: false,
		};
	}
}

async function publishTautulliCache(
	tx: Prisma.TransactionClient,
	instance: OwnedProviderPublicationSnapshot,
	collected: TautulliCacheRefreshResult,
): Promise<TautulliCacheRefreshResult> {
	if (!collected.complete || !collected.completedAt || !collected.snapshot) return collected;
	const rows = collected.snapshot.rows;
	await tx.tautulliCache.deleteMany({ where: { instanceId: instance.id } });
	for (let start = 0; start < rows.length; start += TAUTULLI_CACHE_PUBLICATION_CHUNK_SIZE) {
		await tx.tautulliCache.createMany({
			data: rows.slice(start, start + TAUTULLI_CACHE_PUBLICATION_CHUNK_SIZE).map((row) => ({
				...row,
				connectionGeneration: instance.connectionGeneration,
				identityGeneration: instance.identityGeneration,
			})),
		});
	}
	await tx.cacheRefreshStatus.upsert({
		where: { instanceId_cacheType: { instanceId: instance.id, cacheType: "tautulli" } },
		create: {
			instanceId: instance.id,
			cacheType: "tautulli",
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

export async function collectTautulliCacheLiveEvidence(
	client: TautulliClient,
	instanceId: string,
	log: FastifyBaseLogger,
): Promise<TautulliCacheRefreshResult> {
	const upserted = 0;
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
		const rows: TautulliCacheSnapshotRow[] = [];
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
			return {
				upserted: 0,
				errors: 0,
				errorMessages: [],
				complete: true,
				completedAt,
				snapshot: { rows },
			};
		}
		log.warn({ instanceId, errors }, "Skipping cache publication due to incomplete refresh");

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
		return {
			upserted,
			errors,
			errorMessages,
			complete: complete && errors === 0,
			completedAt,
		};
	} catch (error) {
		complete = false;
		log.error({ err: error, instanceId }, "Tautulli cache refresh failed");
		errors++;
		errorMessages.push(`Tautulli cache refresh failed: ${getErrorMessage(error)}`);
	}

	return { upserted, errors, errorMessages, complete: false };
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
