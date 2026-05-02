"use client";

import type { LibraryItemType } from "@arr/shared";
import { useQuery } from "@tanstack/react-query";
import { fetchTorrentState } from "../../lib/api-client/qui";
import { POLLING_ACTIVE } from "../../lib/polling-intervals";
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
