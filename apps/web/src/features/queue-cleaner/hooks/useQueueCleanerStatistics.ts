import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../../../lib/api-client/base";
import type { QueueCleanerStatistics } from "../lib/queue-cleaner-types";

const STATISTICS_REFRESH_INTERVAL = 60000; // 1 minute

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
		queryKey: ["queue-cleaner", "statistics"],
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
