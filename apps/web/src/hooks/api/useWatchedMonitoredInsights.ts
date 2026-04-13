import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../../lib/api-client/base";

export interface WatchedMonitoredItem {
	arrItemId: number;
	instanceId: string;
	instanceName: string;
	service: string;
	title: string;
	year: number | null;
	sizeOnDisk: number;
	watchCount: number;
	lastWatchedAt: string | null;
	qualityProfileName: string | null;
}

interface WatchedMonitoredResponse {
	success: boolean;
	data: {
		items: WatchedMonitoredItem[];
		hasPlexData: boolean;
		hasWatchData: boolean;
	};
}

function fetchWatchedMonitored(params: {
	limit?: number;
}): Promise<WatchedMonitoredResponse> {
	const search = new URLSearchParams();
	if (params.limit !== undefined) search.set("limit", String(params.limit));
	const qs = search.toString();
	return apiRequest(`/api/library/insights/watched-monitored${qs ? `?${qs}` : ""}`);
}

export function useWatchedMonitoredInsights(params?: {
	limit?: number;
	enabled?: boolean;
}) {
	return useQuery<WatchedMonitoredResponse>({
		queryKey: ["library", "insights", "watched-monitored", params],
		queryFn: () => fetchWatchedMonitored({ limit: params?.limit }),
		enabled: params?.enabled ?? true,
		staleTime: 5 * 60 * 1000,
	});
}
