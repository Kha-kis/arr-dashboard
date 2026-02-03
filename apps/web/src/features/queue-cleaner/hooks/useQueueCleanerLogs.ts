import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../../../lib/api-client/base";
import type { QueueCleanerLog } from "../lib/queue-cleaner-types";
import { LOGS_REFRESH_INTERVAL, LOGS_ACTIVE_REFRESH_INTERVAL } from "../lib/constants";

interface UseLogsParams {
	status?: string;
	instanceId?: string;
	page?: number;
	pageSize?: number;
	hasRunningCleans?: boolean;
}

interface LogsResponse {
	logs: QueueCleanerLog[];
	totalCount: number;
}

async function fetchLogs(params: UseLogsParams): Promise<LogsResponse> {
	const searchParams = new URLSearchParams();
	if (params.status) searchParams.set("status", params.status);
	if (params.instanceId) searchParams.set("instanceId", params.instanceId);
	if (params.page) searchParams.set("page", params.page.toString());
	if (params.pageSize) searchParams.set("pageSize", params.pageSize.toString());

	const queryString = searchParams.toString();
	return apiRequest<LogsResponse>(
		`/api/queue-cleaner/logs${queryString ? `?${queryString}` : ""}`,
	);
}

export function useQueueCleanerLogs(params: UseLogsParams = {}) {
	const { hasRunningCleans, ...queryParams } = params;

	const query = useQuery({
		queryKey: ["queue-cleaner", "logs", queryParams],
		queryFn: () => fetchLogs(queryParams),
		refetchInterval: hasRunningCleans
			? LOGS_ACTIVE_REFRESH_INTERVAL
			: LOGS_REFRESH_INTERVAL,
	});

	const logs = query.data?.logs ?? [];
	const hasRunning = logs.some((log) => log.status === "running");

	return {
		logs,
		totalCount: query.data?.totalCount ?? 0,
		isLoading: query.isLoading,
		error: query.error,
		refetch: query.refetch,
		hasRunningCleans: hasRunning,
	};
}
