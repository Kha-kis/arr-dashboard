import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../../../lib/api-client/base";
import type { QueueCleanerStatus } from "../lib/queue-cleaner-types";
import { STATUS_REFRESH_INTERVAL } from "../lib/constants";

async function fetchStatus(): Promise<QueueCleanerStatus> {
	return apiRequest<QueueCleanerStatus>("/api/queue-cleaner/status");
}

export function useQueueCleanerStatus() {
	const query = useQuery({
		queryKey: ["queue-cleaner", "status"],
		queryFn: fetchStatus,
		refetchInterval: STATUS_REFRESH_INTERVAL,
	});

	return {
		status: query.data ?? null,
		isLoading: query.isLoading,
		error: query.error,
		refetch: query.refetch,
	};
}
