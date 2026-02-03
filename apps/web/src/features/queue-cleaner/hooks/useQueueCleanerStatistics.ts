import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../../../lib/api-client/base";
import type { QueueCleanerStatistics } from "../lib/queue-cleaner-types";

const STATISTICS_REFRESH_INTERVAL = 60000; // 1 minute

async function fetchStatistics(): Promise<QueueCleanerStatistics> {
	return apiRequest<QueueCleanerStatistics>("/api/queue-cleaner/statistics");
}

export function useQueueCleanerStatistics() {
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
