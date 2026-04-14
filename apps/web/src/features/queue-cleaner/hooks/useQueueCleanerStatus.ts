import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../../../lib/api-client/base";
import { queueCleanerKeys } from "../../../lib/query-keys";
import { STATUS_REFRESH_INTERVAL } from "../lib/constants";
import type { QueueCleanerStatus } from "../lib/queue-cleaner-types";

async function fetchStatus(): Promise<QueueCleanerStatus> {
	return apiRequest<QueueCleanerStatus>("/api/queue-cleaner/status");
}

/** Hook return type for useQueueCleanerStatus */
interface UseQueueCleanerStatusResult {
	status: QueueCleanerStatus | null;
	isLoading: boolean;
	error: Error | null;
	/** True when a fetch is in flight (includes background refreshes). */
	isFetching: boolean;
	/** Whether the most recent fetch failed — needed for the freshness indicator to show an error while keeping the last good data visible. */
	isError: boolean;
	/** Timestamp (ms since epoch) of the most recent successful fetch, or 0 if never. */
	dataUpdatedAt: number;
}

/**
 * Hook to fetch and manage queue cleaner status.
 * Automatically refreshes at the configured interval.
 */
export function useQueueCleanerStatus(): UseQueueCleanerStatusResult {
	const query = useQuery({
		queryKey: queueCleanerKeys.status,
		queryFn: fetchStatus,
		refetchInterval: STATUS_REFRESH_INTERVAL,
	});

	return {
		status: query.data ?? null,
		isLoading: query.isLoading,
		error: query.error,
		isFetching: query.isFetching,
		isError: query.isError,
		dataUpdatedAt: query.dataUpdatedAt,
	};
}
