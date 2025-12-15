import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../../../lib/api-client/base";
import type { HuntLog } from "../lib/hunting-types";

interface UseHuntingLogsParams {
	type?: string;
	status?: string;
	instanceId?: string;
	page?: number;
	pageSize?: number;
	/** Faster polling when hunts are running (default: 5000ms for running, 60000ms otherwise) */
	hasRunningHunts?: boolean;
}

interface HuntingLogsResponse {
	logs: HuntLog[];
	totalCount: number;
}

/**
 * Fetches hunting logs from the server using the provided query filters.
 *
 * @param params - Optional filters and pagination: `type`, `status`, `instanceId`, `page`, and `pageSize`
 * @returns An object with `logs` (array of `HuntLog`) and `totalCount` (number)
 */
async function fetchHuntingLogs(params: UseHuntingLogsParams): Promise<HuntingLogsResponse> {
	const searchParams = new URLSearchParams();
	if (params.type) searchParams.set("type", params.type);
	if (params.status) searchParams.set("status", params.status);
	if (params.instanceId) searchParams.set("instanceId", params.instanceId);
	if (params.page) searchParams.set("page", params.page.toString());
	if (params.pageSize) searchParams.set("pageSize", params.pageSize.toString());

	const queryString = searchParams.toString();
	return apiRequest<HuntingLogsResponse>(`/api/hunting/logs${queryString ? `?${queryString}` : ""}`);
}

/**
 * Fetches hunting logs with optional filters and exposes query state and controls.
 *
 * @param params - Optional filters and options: `type`, `status`, `instanceId`, `page`, `pageSize`; include `hasRunningHunts` to request faster polling when true.
 * @returns An object with the fetched logs and query state:
 * - `logs`: Array of `HuntLog` entries matching the filters.
 * - `totalCount`: Total number of matching logs.
 * - `isLoading`: `true` while the query is loading.
 * - `error`: Query error, if any.
 * - `refetch`: Function to manually refetch the logs.
 * - `hasRunningHunts`: `true` if any returned log has `status === "running"`.
 */
export function useHuntingLogs(params: UseHuntingLogsParams = {}) {
	const { hasRunningHunts, ...queryParams } = params;

	const query = useQuery({
		queryKey: ["hunting", "logs", queryParams],
		queryFn: () => fetchHuntingLogs(queryParams),
		// Poll faster when hunts are running to show progress updates
		refetchInterval: hasRunningHunts ? 5000 : 60000,
	});

	// Check if any logs are currently running
	const logs = query.data?.logs ?? [];
	const hasRunning = logs.some(log => log.status === "running");

	return {
		logs,
		totalCount: query.data?.totalCount ?? 0,
		isLoading: query.isLoading,
		error: query.error,
		refetch: query.refetch,
		hasRunningHunts: hasRunning,
	};
}