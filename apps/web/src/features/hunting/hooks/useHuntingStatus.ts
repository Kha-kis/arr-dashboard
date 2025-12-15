import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../../../lib/api-client/base";
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
 * - `error` — the query error object if the request failed, otherwise `undefined`
 * - `refetch` — a function to manually re-run the query
 */
export function useHuntingStatus() {
	const query = useQuery({
		queryKey: ["hunting", "status"],
		queryFn: fetchHuntingStatus,
		refetchInterval: 30000, // Refresh every 30 seconds
	});

	return {
		status: query.data ?? null,
		isLoading: query.isLoading,
		error: query.error,
		refetch: query.refetch,
	};
}