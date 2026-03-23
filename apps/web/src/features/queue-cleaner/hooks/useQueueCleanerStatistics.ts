import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../../../lib/api-client/base";
import { queueCleanerKeys } from "../../../lib/query-keys";
import type { QueueCleanerStatistics } from "../lib/queue-cleaner-types";
import { POLLING_STANDARD } from "../../../lib/polling-intervals";

const STATISTICS_REFRESH_INTERVAL = POLLING_STANDARD;

async function fetchStatistics(): Promise<QueueCleanerStatistics> {
	return apiRequest<QueueCleanerStatistics>("/api/queue-cleaner/statistics");
}

/** Hook return type for useQueueCleanerStatistics */
interface UseQueueCleanerStatisticsResult {
	statistics: QueueCleanerStatistics | null;
	isLoading: boolean;
	error: Error | null;
	refetch: () => Promise<unknown>;
}

/**
 * Hook to fetch and manage queue cleaner statistics.
 * Includes daily/weekly trends, rule breakdowns, and instance summaries.
 */
export function useQueueCleanerStatistics(): UseQueueCleanerStatisticsResult {
	const query = useQuery({
		queryKey: queueCleanerKeys.statistics,
		queryFn: fetchStatistics,
		refetchInterval: STATISTICS_REFRESH_INTERVAL,
	});

	return {
		statistics: query.data ?? null,
		isLoading: query.isLoading,
		error: query.error,
		refetch: query.refetch,
	};
}
