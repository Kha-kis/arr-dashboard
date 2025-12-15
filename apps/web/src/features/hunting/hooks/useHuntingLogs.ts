import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../../../lib/api-client/base";
import type { HuntLog } from "../lib/hunting-types";

interface UseHuntingLogsParams {
	type?: string;
	status?: string;
	instanceId?: string;
	page?: number;
	pageSize?: number;
}

interface HuntingLogsResponse {
	logs: HuntLog[];
	totalCount: number;
}

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

export function useHuntingLogs(params: UseHuntingLogsParams = {}) {
	const query = useQuery({
		queryKey: ["hunting", "logs", params],
		queryFn: () => fetchHuntingLogs(params),
		refetchInterval: 60000, // Refresh every minute
	});

	return {
		logs: query.data?.logs ?? [],
		totalCount: query.data?.totalCount ?? 0,
		isLoading: query.isLoading,
		error: query.error,
		refetch: query.refetch,
	};
}
