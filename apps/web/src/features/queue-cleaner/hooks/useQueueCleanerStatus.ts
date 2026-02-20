import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../../../lib/api-client/base";
import type { QueueCleanerStatus } from "../lib/queue-cleaner-types";
import { STATUS_REFRESH_INTERVAL } from "../lib/constants";

async function fetchStatus(): Promise<QueueCleanerStatus> {
	return apiRequest<QueueCleanerStatus>("/api/queue-cleaner/status");
}

/** Hook return type for useQueueCleanerStatus */
interface UseQueueCleanerStatusResult {
	status: QueueCleanerStatus | null;
	isLoading: boolean;
	error: Error | null;
}

/**
 * Hook to fetch and manage queue cleaner status.
 * Automatically refreshes at the configured interval.
 */
export function useQueueCleanerStatus(): UseQueueCleanerStatusResult {
	const query = useQuery({
		queryKey: ["queue-cleaner", "status"],
		queryFn: fetchStatus,
		refetchInterval: STATUS_REFRESH_INTERVAL,
	});

	return {
		status: query.data ?? null,
		isLoading: query.isLoading,
		error: query.error,
	};
}
