/**
 * Tautulli cache refreshes are gathered outside the database, then published
 * as a complete replacement under the current provider connection generation.
 * A failed or superseded attempt never clears the last successful generation.
 */

import { randomUUID } from "node:crypto";
import type { TautulliHistoryItem, TautulliHistorySnapshot } from "@arr/shared";
import type { FastifyBaseLogger } from "fastify";
import type { PrismaClient } from "../prisma.js";
import { recordProviderCacheRefreshFailure } from "../services/provider-cache-status.js";
import {
	type ProviderConnectionIdentity,
	withCurrentProviderConnection,
} from "../services/provider-connection-guard.js";
import { getErrorMessage } from "../utils/error-message.js";
import type { TautulliClient } from "./tautulli-client.js";

const CACHE_TYPE = "tautulli";
const MAX_HISTORY_RESULTS = 100_000;
const MAX_METADATA_LOOKUPS = 500;

export const STALE_EVICTION_CHUNK_SIZE = 500;

export type TautulliCacheRefreshResult = {
	upserted: number;
	errors: number;
	errorMessages: string[];
	complete: boolean;
	completedAt?: Date;
	superseded?: boolean;
};

type StagedRow = {
	instanceId: string;
	tmdbId: number;
	mediaType: "movie" | "series";
	lastWatchedAt: Date;
	watchCount: number;
	watchedByUsers: string;
};

type SnapshotSection = {
	id: string;
	name: string;
	type: string;
	recordsFiltered: number;
	recordsTotal: number;
};

const inFlightRefreshes = new Map<string, Promise<TautulliCacheRefreshResult>>();

/**
 * Coalesce overlapping work for the same instance and connection generation.
 * A changed generation intentionally starts a distinct attempt, whose guarded
 * publication determines which generation remains current.
 */
export function refreshTautulliCache(
	client: TautulliClient,
	prisma: PrismaClient,
	instanceId: string,
	log: FastifyBaseLogger,
	expectedConnection: ProviderConnectionIdentity,
): Promise<TautulliCacheRefreshResult> {
	const key = `${instanceId}:${expectedConnection.service}:${expectedConnection.connectionGeneration}`;
	const existing = inFlightRefreshes.get(key);
	if (existing) return existing;

	const pending = performTautulliCacheRefresh(client, prisma, instanceId, log, expectedConnection);
	inFlightRefreshes.set(key, pending);
	void pending.finally(() => inFlightRefreshes.delete(key)).catch(() => undefined);
	return pending;
}

export function clearTautulliCacheRefreshSingleFlightsForTests(): void {
	inFlightRefreshes.clear();
}

async function performTautulliCacheRefresh(
	client: TautulliClient,
	prisma: PrismaClient,
	instanceId: string,
	log: FastifyBaseLogger,
	expectedConnection: ProviderConnectionIdentity,
): Promise<TautulliCacheRefreshResult> {
	try {
		const staged = await gatherCompleteSnapshot(client, instanceId);
		const completedAt = new Date();
		const generationId = randomUUID();
		const generationMetadata = JSON.stringify({ sections: staged.sections });
		const publication = await withCurrentProviderConnection(
			prisma,
			instanceId,
			expectedConnection,
			async (tx) => {
				await tx.tautulliCache.deleteMany({ where: { instanceId } });
				if (staged.rows.length > 0) {
					await tx.tautulliCache.createMany({ data: staged.rows });
				}
				await tx.cacheRefreshStatus.upsert({
					where: { instanceId_cacheType: { instanceId, cacheType: CACHE_TYPE } },
					create: {
						instanceId,
						cacheType: CACHE_TYPE,
						lastRefreshedAt: completedAt,
						lastResult: "success",
						lastErrorMessage: null,
						itemCount: staged.rows.length,
						generationId,
						generationMetadata,
						lastAttemptAt: completedAt,
						lastAttemptResult: "success",
						lastAttemptErrorMessage: null,
					},
					update: {
						lastRefreshedAt: completedAt,
						lastResult: "success",
						lastErrorMessage: null,
						itemCount: staged.rows.length,
						generationId,
						generationMetadata,
						lastAttemptAt: completedAt,
						lastAttemptResult: "success",
						lastAttemptErrorMessage: null,
					},
				});
			},
		);

		if (!publication.matched) {
			return {
				upserted: 0,
				errors: 0,
				errorMessages: ["Tautulli service connection changed during refresh"],
				complete: false,
				superseded: true,
			};
		}

		return {
			upserted: staged.rows.length,
			errors: 0,
			errorMessages: [],
			complete: true,
			completedAt,
		};
	} catch (error) {
		const message = getErrorMessage(error, "Tautulli cache refresh failed");
		log.warn(
			{ err: error, instanceId },
			"Tautulli cache refresh did not publish a complete generation",
		);
		const failure = await recordProviderCacheRefreshFailure(
			prisma,
			instanceId,
			CACHE_TYPE,
			message,
			expectedConnection,
			log,
		);
		return {
			upserted: 0,
			errors: 1,
			errorMessages: [message],
			complete: false,
			superseded: failure === "superseded" || undefined,
		};
	}
}

async function gatherCompleteSnapshot(
	client: TautulliClient,
	instanceId: string,
): Promise<{ rows: StagedRow[]; sections: SnapshotSection[] }> {
	const libraries = await client.getLibraries();
	const sections = libraries
		.filter((library) => library.section_type === "movie" || library.section_type === "show")
		.sort((left, right) => left.section_id.localeCompare(right.section_id));
	if (sections.length === 0) {
		throw new Error("Tautulli returned no movie or show libraries");
	}

	const seenSections = new Set<string>();
	const history: Array<{ item: TautulliHistoryItem; sectionId: string }> = [];
	const metadataSections: SnapshotSection[] = [];
	let expectedHistoryRows = 0;

	for (const section of sections) {
		if (seenSections.has(section.section_id)) {
			throw new Error("Tautulli returned duplicate media library sections");
		}
		seenSections.add(section.section_id);
		const snapshot = await client.getHistorySnapshot({ section_id: section.section_id });
		assertCompleteHistorySnapshot(snapshot, section.section_id);
		expectedHistoryRows += snapshot.recordsFiltered;
		if (expectedHistoryRows > MAX_HISTORY_RESULTS) {
			throw new Error(`Tautulli history exceeds the safe ${MAX_HISTORY_RESULTS}-row refresh limit`);
		}
		for (const item of snapshot.items) {
			history.push({ item, sectionId: section.section_id });
		}
		metadataSections.push({
			id: section.section_id,
			name: section.section_name,
			type: section.section_type,
			recordsFiltered: snapshot.recordsFiltered,
			recordsTotal: snapshot.recordsTotal,
		});
	}

	const items = aggregateHistory(history);
	if (items.size > MAX_METADATA_LOOKUPS) {
		throw new Error(
			`Tautulli metadata inventory exceeds the safe ${MAX_METADATA_LOOKUPS}-item refresh limit`,
		);
	}

	const rowsByCacheKey = new Map<string, StagedRow>();
	for (const item of items.values()) {
		const metadata = await client.getMetadata(item.ratingKey);
		const tmdbId = parseTmdbId(metadata.guids);
		if (tmdbId === null) {
			throw new Error(
				"Tautulli metadata did not provide a TMDb identifier for a complete history row",
			);
		}
		const mediaType = item.isShow ? "series" : "movie";
		const cacheKey = `${mediaType}:${tmdbId}`;
		if (rowsByCacheKey.has(cacheKey)) {
			throw new Error("Tautulli metadata resolved multiple history items to one cache identity");
		}
		rowsByCacheKey.set(cacheKey, {
			instanceId,
			tmdbId,
			mediaType,
			lastWatchedAt: new Date(item.lastDate * 1000),
			watchCount: item.watchCount,
			watchedByUsers: JSON.stringify([...item.users].sort()),
		});
	}

	return { rows: [...rowsByCacheKey.values()], sections: metadataSections };
}

function assertCompleteHistorySnapshot(snapshot: TautulliHistorySnapshot, sectionId: string): void {
	if (
		Number.isSafeInteger(snapshot.recordsFiltered) &&
		Number.isSafeInteger(snapshot.recordsTotal) &&
		snapshot.recordsTotal < snapshot.recordsFiltered
	) {
		throw new Error(
			`Tautulli history declared total is below filtered total for library ${sectionId}`,
		);
	}
	if (
		!snapshot.complete ||
		!Number.isSafeInteger(snapshot.recordsFiltered) ||
		snapshot.recordsFiltered < 0 ||
		!Number.isSafeInteger(snapshot.recordsTotal) ||
		snapshot.items.length !== snapshot.recordsFiltered
	) {
		throw new Error(`Tautulli history snapshot was incomplete for library ${sectionId}`);
	}

	let previousRowId = -1;
	const rowIds = new Set<number>();
	for (const item of snapshot.items) {
		if (!Number.isSafeInteger(item.row_id) || item.row_id === undefined || item.row_id < 0) {
			throw new Error(
				`Tautulli history did not provide a stable row identity for library ${sectionId}`,
			);
		}
		if (item.row_id <= previousRowId || rowIds.has(item.row_id)) {
			throw new Error(
				`Tautulli history returned duplicate or unordered rows for library ${sectionId}`,
			);
		}
		if ((item.group_count ?? 1) > 1 || (item.play_count ?? 1) > 1) {
			throw new Error(`Tautulli history returned grouped play rows for library ${sectionId}`);
		}
		previousRowId = item.row_id;
		rowIds.add(item.row_id);
	}
}

function aggregateHistory(history: Array<{ item: TautulliHistoryItem; sectionId: string }>) {
	const items = new Map<
		string,
		{ ratingKey: string; isShow: boolean; users: Set<string>; lastDate: number; watchCount: number }
	>();
	for (const { item, sectionId } of history) {
		if (item.media_type !== "movie" && item.media_type !== "episode") {
			throw new Error(
				`Tautulli history returned an unsupported media type for library ${sectionId}`,
			);
		}
		const isShow = item.media_type === "episode";
		const ratingKey = isShow ? item.grandparent_rating_key : item.rating_key;
		if (!ratingKey || !item.user || !Number.isSafeInteger(item.date) || item.date < 0) {
			throw new Error(`Tautulli history returned a sparse row for library ${sectionId}`);
		}
		const key = `${isShow ? "series" : "movie"}:${ratingKey}`;
		const existing = items.get(key);
		if (existing) {
			existing.users.add(item.user);
			existing.lastDate = Math.max(existing.lastDate, item.date);
			existing.watchCount += 1;
		} else {
			items.set(key, {
				ratingKey,
				isShow,
				users: new Set([item.user]),
				lastDate: item.date,
				watchCount: 1,
			});
		}
	}
	return items;
}

function parseTmdbId(guids: string[]): number | null {
	for (const guid of guids) {
		const match = /^tmdb:\/\/(\d+)$/.exec(guid);
		if (match?.[1]) return Number.parseInt(match[1], 10);
	}
	return null;
}

/**
 * Bounded stale-row eviction for consumers that reconcile an existing cache
 * incrementally. Atomic refresh publication above uses a full replacement, so
 * it never constructs an unbounded `notIn` database predicate.
 */
export async function evictStaleRows(
	prisma: Pick<PrismaClient, "tautulliCache">,
	instanceId: string,
	keepIds: string[],
): Promise<number> {
	const existing = await prisma.tautulliCache.findMany({
		where: { instanceId },
		select: { id: true },
	});
	const keepSet = new Set(keepIds);
	const staleIds = existing.filter((row) => !keepSet.has(row.id)).map((row) => row.id);
	let deleted = 0;
	for (let index = 0; index < staleIds.length; index += STALE_EVICTION_CHUNK_SIZE) {
		const chunk = staleIds.slice(index, index + STALE_EVICTION_CHUNK_SIZE);
		const result = await prisma.tautulliCache.deleteMany({
			where: { instanceId, id: { in: chunk } },
		});
		deleted += result.count;
	}
	return deleted;
}
