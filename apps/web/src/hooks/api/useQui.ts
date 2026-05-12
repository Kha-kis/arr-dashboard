"use client";

import type { CrossSeedDiscoveryResponse, LibraryItemType } from "@arr/shared";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
	fetchCrossSeedAvailability,
	fetchCrossSeedDiscoveryBatch,
	fetchTorrentState,
} from "../../lib/api-client/qui";
import { POLLING_ACTIVE, POLLING_BACKGROUND } from "../../lib/polling-intervals";
import { quiKeys } from "../../lib/query-keys";

export interface UseTorrentStateArgs {
	arrInstanceId: string;
	arrItemId: number;
	itemType: LibraryItemType;
	enabled?: boolean;
}

/**
 * Fetches torrent state for a single library item via the qui integration.
 * The backend handles all the wiring: cache lookup, lazy *arr-history backfill
 * for the infoHash, qui torrent + cross-seed lookup. The hook is just a thin
 * React Query wrapper.
 *
 * Used by the deep `TorrentHealthPanel` modal — single-item, on-demand.
 * The previous batch variant has been retired: per-card data now ships
 * inside the page-level `/library` response (`LibraryItem.torrentState` /
 * `torrentRatio`), so the badge no longer needs to poll per item.
 */
export const useTorrentState = ({
	arrInstanceId,
	arrItemId,
	itemType,
	enabled = true,
}: UseTorrentStateArgs) => {
	return useQuery({
		queryKey: quiKeys.torrentState(arrInstanceId, arrItemId, itemType),
		queryFn: () => fetchTorrentState({ arrInstanceId, arrItemId, itemType }),
		enabled: enabled && Boolean(arrInstanceId) && Number.isFinite(arrItemId),
		staleTime: POLLING_ACTIVE,
		refetchInterval: POLLING_ACTIVE,
	});
};

/**
 * Probe for the Cross-Seed Discovery page (Phase 3.1). Returns whether the
 * user has qui configured AND has at least one correlated library item to
 * scan. Drives the page's empty-state copy before any expensive scan call.
 */
export const useCrossSeedAvailability = (enabled: boolean = true) => {
	return useQuery({
		queryKey: quiKeys.crossSeedAvailability(),
		queryFn: fetchCrossSeedAvailability,
		enabled,
		staleTime: POLLING_BACKGROUND,
	});
};

/**
 * Infinite-scroll discovery scan for the Cross-Seed page. Each fetch hits
 * the backend for ~one batch of LibraryCache rows; React Query stitches
 * batches via `nextCursor`. Stops automatically when the backend reports
 * `exhausted: true`.
 */
export const useCrossSeedDiscovery = (enabled: boolean = true, batchSize: number = 100) => {
	return useInfiniteQuery<CrossSeedDiscoveryResponse>({
		queryKey: [...quiKeys.crossSeedDiscovery(), batchSize] as const,
		queryFn: ({ pageParam }) =>
			fetchCrossSeedDiscoveryBatch({
				cursor: typeof pageParam === "string" ? pageParam : null,
				batchSize,
			}),
		initialPageParam: null as string | null,
		getNextPageParam: (lastPage) => (lastPage.exhausted ? undefined : lastPage.nextCursor),
		enabled,
		// Cross-seed siblings change with user actions in qui, but we don't
		// auto-refresh during an active scan — operators have a manual rescan
		// button. Long staleTime keeps the cached scan stable across nav.
		staleTime: POLLING_BACKGROUND,
	});
};
