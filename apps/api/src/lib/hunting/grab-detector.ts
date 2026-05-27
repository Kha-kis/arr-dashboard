/**
 * Grab detection for hunt executor.
 *
 * After triggering search commands on *arr instances, these functions
 * detect which items were actually grabbed (downloaded) by checking
 * the instance's history API first, falling back to queue scanning.
 */

import type { LidarrClient } from "arr-sdk/lidarr";
import type { RadarrClient } from "arr-sdk/radarr";
import type { ReadarrClient } from "arr-sdk/readarr";
import type { SonarrClient } from "arr-sdk/sonarr";
import { delay } from "../utils/delay.js";
import { GRAB_CHECK_DELAY_MS } from "./constants.js";
import type { HuntLogger } from "./hunt-filters.js";
import type { ApiCallCounter } from "./pagination-helpers.js";

export interface GrabbedItem {
	title: string;
	quality?: string;
	indexer?: string;
	size?: number;
}

export interface GrabDetectionResult {
	items: GrabbedItem[];
	/** True when both history and queue detection failed — itemsGrabbed count is unreliable */
	failed: boolean;
}

/**
 * Detect grabbed items from history using SDK.
 * Checks the instance's history for "grabbed" events that occurred after
 * search commands were triggered, matching by movie/series/episode IDs.
 *
 * Falls back to queue-based detection on failure.
 */
export async function detectGrabbedItemsFromHistoryWithSdk(
	client: SonarrClient | RadarrClient,
	searchStartTime: Date,
	searchedMovieIds: number[],
	searchedSeriesIds: number[],
	searchedEpisodeIds: number[],
	counter: ApiCallCounter,
	logger: HuntLogger,
): Promise<GrabDetectionResult> {
	try {
		await delay(GRAB_CHECK_DELAY_MS);

		counter.count++;
		// Server-side filter by `eventType=grabbed` (primary). Originally broken
		// in arr-sdk 0.6.0 — Radarr/Sonarr's .NET model binder rejects the
		// string "grabbed" because it binds eventType as `int[]`, not the enum
		// from OpenAPI (issue #472). Fixed upstream in arr-sdk 0.7.0 which now
		// translates string event types to numeric .NET enum values inside the
		// SDK before forwarding.
		const history = await client.history.get({
			pageSize: 100,
			sortKey: "date",
			sortDirection: "descending",
			eventType: "grabbed",
		});

		const grabbedItems: GrabbedItem[] = [];

		for (const record of history.records ?? []) {
			// Defensive guard (belt-and-suspenders with the server-side filter
			// above). arr-sdk's `encodeEventType` returns `undefined` on
			// unknown enum keys and `buildQueryParams` strips undefined values
			// — so a future typo, SDK regression, or upstream rename of the
			// enum key would silently bypass the server filter, returning
			// imports/deletes that share IDs with searched items. Without this
			// guard, those would be over-counted as grabs with no warning.
			if (record.eventType !== "grabbed") continue;
			const eventDate = new Date(record.date ?? "");
			if (eventDate < searchStartTime) continue;

			const recordAny = record as Record<string, unknown>;
			const isMatchingMovie =
				recordAny.movieId && searchedMovieIds.includes(recordAny.movieId as number);
			const isMatchingSeries =
				recordAny.seriesId && searchedSeriesIds.includes(recordAny.seriesId as number);
			const isMatchingEpisode =
				recordAny.episodeId && searchedEpisodeIds.includes(recordAny.episodeId as number);

			if (isMatchingMovie || isMatchingSeries || isMatchingEpisode) {
				const dataObj = (recordAny.data ?? {}) as Record<string, unknown>;

				let size: number | undefined;
				const sizeValue = dataObj.size ?? recordAny.size;
				if (typeof sizeValue === "number") {
					size = sizeValue;
				} else if (typeof sizeValue === "string") {
					const parsed = Number.parseInt(sizeValue, 10);
					if (!Number.isNaN(parsed)) {
						size = parsed;
					}
				}

				const qualityObj = recordAny.quality as Record<string, unknown> | undefined;
				const qualityName =
					((qualityObj?.quality as Record<string, unknown>)?.name as string | undefined) ??
					(qualityObj?.name as string | undefined);

				const indexer = (dataObj.indexer ?? recordAny.indexer) as string | undefined;
				const title = (recordAny.sourceTitle ??
					dataObj.releaseTitle ??
					dataObj.title ??
					"Unknown") as string;

				grabbedItems.push({
					title,
					quality: qualityName,
					indexer,
					size,
				});
			}
		}

		return { items: grabbedItems, failed: false };
	} catch (error) {
		logger.warn(
			{ err: error },
			"History-based grab detection failed, falling back to queue detection",
		);
		return detectGrabbedItemsFromQueueWithSdk(
			client,
			searchedMovieIds,
			searchedSeriesIds,
			searchedEpisodeIds,
			counter,
			logger,
		);
	}
}

/**
 * Detect grabbed items from queue using SDK (fallback).
 * Note: Returns empty array on failure since the hunt searches were still triggered,
 * we just couldn't verify what was grabbed. The hunt result will still be accurate
 * for itemsSearched, just not for itemsGrabbed.
 */
export async function detectGrabbedItemsFromQueueWithSdk(
	client: SonarrClient | RadarrClient,
	searchedMovieIds: number[],
	searchedSeriesIds: number[],
	searchedEpisodeIds: number[],
	counter: ApiCallCounter,
	logger: HuntLogger,
): Promise<GrabDetectionResult> {
	try {
		counter.count++;
		const queue = await client.queue.get({ pageSize: 1000 });
		const grabbedItems: GrabbedItem[] = [];

		for (const item of queue.records ?? []) {
			const itemAny = item as Record<string, unknown>;
			const isMatchingMovie =
				itemAny.movieId && searchedMovieIds.includes(itemAny.movieId as number);
			const isMatchingSeries =
				itemAny.seriesId && searchedSeriesIds.includes(itemAny.seriesId as number);
			const isMatchingEpisode =
				itemAny.episodeId && searchedEpisodeIds.includes(itemAny.episodeId as number);

			if (isMatchingMovie || isMatchingSeries || isMatchingEpisode) {
				const qualityObj = itemAny.quality as Record<string, unknown> | undefined;
				grabbedItems.push({
					title: itemAny.title as string,
					quality: (qualityObj?.quality as Record<string, unknown>)?.name as string | undefined,
					indexer: itemAny.indexer as string | undefined,
					size: itemAny.size as number | undefined,
				});
			}
		}

		return { items: grabbedItems, failed: false };
	} catch (error) {
		// Both history and queue detection failed - log as error since this is unexpected
		logger.error(
			{ err: error },
			"Grab detection failed completely (both history and queue methods) - grabbed items count will be inaccurate",
		);
		return { items: [], failed: true };
	}
}

// ============================================================================
// Shared helper for extracting grab metadata from a history record
// ============================================================================

function extractGrabMetadata(recordAny: Record<string, unknown>): GrabbedItem {
	const dataObj = (recordAny.data ?? {}) as Record<string, unknown>;

	let size: number | undefined;
	const sizeValue = dataObj.size ?? recordAny.size;
	if (typeof sizeValue === "number") {
		size = sizeValue;
	} else if (typeof sizeValue === "string") {
		const parsed = Number.parseInt(sizeValue, 10);
		if (!Number.isNaN(parsed)) {
			size = parsed;
		}
	}

	const qualityObj = recordAny.quality as Record<string, unknown> | undefined;
	const qualityName =
		((qualityObj?.quality as Record<string, unknown>)?.name as string | undefined) ??
		(qualityObj?.name as string | undefined);

	const indexer = (dataObj.indexer ?? recordAny.indexer) as string | undefined;
	const title = (recordAny.sourceTitle ??
		dataObj.releaseTitle ??
		dataObj.title ??
		"Unknown") as string;

	return { title, quality: qualityName, indexer, size };
}

// ============================================================================
// Lidarr grab detection (album-based)
// ============================================================================

/**
 * Detect grabbed items from Lidarr history after album searches.
 * Matches history records by albumId.
 */
export async function detectLidarrGrabbedItems(
	client: LidarrClient,
	searchStartTime: Date,
	searchedAlbumIds: number[],
	counter: ApiCallCounter,
	logger: HuntLogger,
): Promise<GrabDetectionResult> {
	try {
		await delay(GRAB_CHECK_DELAY_MS);

		counter.count++;
		// Server-side filter via `eventType=grabbed`. arr-sdk 0.7.0+ translates
		// the string event type to its numeric .NET enum value before sending
		// to upstream Lidarr (issue #472 fix).
		const history = await client.history.get({
			pageSize: 100,
			sortKey: "date",
			sortDirection: "descending",
			eventType: "grabbed",
		});

		const grabbedItems: GrabbedItem[] = [];

		for (const record of history.records ?? []) {
			// Defensive guard against silent SDK filter-drop (see Sonarr/Radarr
			// version above for the full rationale).
			if (record.eventType !== "grabbed") continue;
			const eventDate = new Date(record.date ?? "");
			if (eventDate < searchStartTime) continue;

			const recordAny = record as Record<string, unknown>;
			if (recordAny.albumId && searchedAlbumIds.includes(recordAny.albumId as number)) {
				grabbedItems.push(extractGrabMetadata(recordAny));
			}
		}

		return { items: grabbedItems, failed: false };
	} catch (error) {
		logger.warn({ err: error }, "Lidarr history-based grab detection failed, trying queue");
		return detectLidarrGrabbedItemsFromQueue(client, searchedAlbumIds, counter, logger);
	}
}

async function detectLidarrGrabbedItemsFromQueue(
	client: LidarrClient,
	searchedAlbumIds: number[],
	counter: ApiCallCounter,
	logger: HuntLogger,
): Promise<GrabDetectionResult> {
	try {
		counter.count++;
		const queue = await client.queue.get({ pageSize: 1000 });
		const grabbedItems: GrabbedItem[] = [];

		for (const item of queue.records ?? []) {
			const itemAny = item as Record<string, unknown>;
			if (itemAny.albumId && searchedAlbumIds.includes(itemAny.albumId as number)) {
				const qualityObj = itemAny.quality as Record<string, unknown> | undefined;
				grabbedItems.push({
					title: itemAny.title as string,
					quality: (qualityObj?.quality as Record<string, unknown>)?.name as string | undefined,
					indexer: itemAny.indexer as string | undefined,
					size: itemAny.size as number | undefined,
				});
			}
		}

		return { items: grabbedItems, failed: false };
	} catch (error) {
		logger.error({ err: error }, "Lidarr grab detection failed completely");
		return { items: [], failed: true };
	}
}

// ============================================================================
// Readarr grab detection (book-based)
// ============================================================================

/**
 * Detect grabbed items from Readarr history after book searches.
 * Matches history records by bookId.
 */
export async function detectReadarrGrabbedItems(
	client: ReadarrClient,
	searchStartTime: Date,
	searchedBookIds: number[],
	counter: ApiCallCounter,
	logger: HuntLogger,
): Promise<GrabDetectionResult> {
	try {
		await delay(GRAB_CHECK_DELAY_MS);

		counter.count++;
		// Server-side filter via `eventType=grabbed`. arr-sdk 0.7.0+ translates
		// the string event type to its numeric .NET enum value before sending
		// to upstream Readarr (issue #472 fix).
		const history = await client.history.get({
			pageSize: 100,
			sortKey: "date",
			sortDirection: "descending",
			eventType: "grabbed",
		});

		const grabbedItems: GrabbedItem[] = [];

		for (const record of history.records ?? []) {
			// Defensive guard against silent SDK filter-drop (see Sonarr/Radarr
			// version above for the full rationale).
			if (record.eventType !== "grabbed") continue;
			const eventDate = new Date(record.date ?? "");
			if (eventDate < searchStartTime) continue;

			const recordAny = record as Record<string, unknown>;
			if (recordAny.bookId && searchedBookIds.includes(recordAny.bookId as number)) {
				grabbedItems.push(extractGrabMetadata(recordAny));
			}
		}

		return { items: grabbedItems, failed: false };
	} catch (error) {
		logger.warn({ err: error }, "Readarr history-based grab detection failed, trying queue");
		return detectReadarrGrabbedItemsFromQueue(client, searchedBookIds, counter, logger);
	}
}

async function detectReadarrGrabbedItemsFromQueue(
	client: ReadarrClient,
	searchedBookIds: number[],
	counter: ApiCallCounter,
	logger: HuntLogger,
): Promise<GrabDetectionResult> {
	try {
		counter.count++;
		const queue = await client.queue.get({ pageSize: 1000 });
		const grabbedItems: GrabbedItem[] = [];

		for (const item of queue.records ?? []) {
			const itemAny = item as Record<string, unknown>;
			if (itemAny.bookId && searchedBookIds.includes(itemAny.bookId as number)) {
				const qualityObj = itemAny.quality as Record<string, unknown> | undefined;
				grabbedItems.push({
					title: itemAny.title as string,
					quality: (qualityObj?.quality as Record<string, unknown>)?.name as string | undefined,
					indexer: itemAny.indexer as string | undefined,
					size: itemAny.size as number | undefined,
				});
			}
		}

		return { items: grabbedItems, failed: false };
	} catch (error) {
		logger.error({ err: error }, "Readarr grab detection failed completely");
		return { items: [], failed: true };
	}
}
