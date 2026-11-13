import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../../../lib/api-client/base";
import { huntingKeys } from "../../../lib/query-keys";
import { POLLING_ACTIVE } from "../../../lib/polling-intervals";
import type { HuntingStatus } from "../lib/hunting-types";

/**
 * Fetches the current hunting status from the server.
 *
 * @returns The current hunting status as a `HuntingStatus` object.
 */
async function fetchHuntingStatus(): Promise<HuntingStatus> {
	return apiRequest<HuntingStatus>("/api/hunting/status");
}

/**
 * Subscribes to the hunting status API and exposes the latest status along with loading, error, and refetch controls.
 *
 * @returns An object containing:
 * - `status` — the latest `HuntingStatus` value or `null` if not yet available
 * - `isLoading` — `true` while the query is loading, `false` otherwise
 * - `isUnavailable` — the status read failed and has not yet recovered
 * - `isFetching` — a status request is in progress
 * - `refetch` — a function to manually re-run the query
 */
export function useHuntingStatus() {
	const query = useQuery({
		queryKey: huntingKeys.status,
		queryFn: fetchHuntingStatus,
		refetchInterval: POLLING_ACTIVE,
		retry: false,
	});

	return {
		status: query.data ?? null,
		isLoading: query.isLoading,
		// A retry clears the initial query error before any status has been verified.
		isUnavailable: query.isError || (query.data === undefined && query.errorUpdatedAt > 0),
		isFetching: query.isFetching,
		refetch: query.refetch,
	};
}
