/**
 * Grab detection for hunt executor.
 *
 * After triggering search commands on Sonarr/Radarr, these functions
 * detect which items were actually grabbed (downloaded) by checking
 * the instance's history API first, falling back to queue scanning.
 */

import type { SonarrClient } from "arr-sdk/sonarr";
import type { RadarrClient } from "arr-sdk/radarr";
import type { ApiCallCounter } from "./pagination-helpers.js";
import { GRAB_CHECK_DELAY_MS } from "./constants.js";
import { delay } from "../utils/delay.js";
import type { HuntLogger } from "./hunt-filters.js";

export interface GrabbedItem {
	title: string;
	quality?: string;
	indexer?: string;
	size?: number;
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
): Promise<GrabbedItem[]> {
	try {
		await delay(GRAB_CHECK_DELAY_MS);

		counter.count++;
		const history = await client.history.get({
			pageSize: 100,
			sortKey: "date",
			sortDirection: "descending",
			eventType: "grabbed",
		});

		const grabbedItems: GrabbedItem[] = [];

		for (const record of history.records ?? []) {
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

		return grabbedItems;
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
): Promise<GrabbedItem[]> {
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

		return grabbedItems;
	} catch (error) {
		// Both history and queue detection failed - log as error since this is unexpected
		logger.error(
			{ err: error },
			"Grab detection failed completely (both history and queue methods) - grabbed items count will be inaccurate",
		);
		return [];
	}
}
