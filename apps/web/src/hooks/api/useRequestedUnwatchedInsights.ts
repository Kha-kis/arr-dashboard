import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../../lib/api-client/base";

export interface RequestedUnwatchedItem {
	arrItemId: number;
	instanceId: string;
	instanceName: string;
	service: string;
	title: string;
	year: number | null;
	sizeOnDisk: number;
	addedDaysAgo: number;
	requestedBy: string;
	requestedAt: string;
}

interface RequestedUnwatchedResponse {
	success: boolean;
	data: {
		items: RequestedUnwatchedItem[];
		hasSeerrData: boolean;
		hasPlexData: boolean;
	};
}

function fetchRequestedUnwatched(params: {
	minAgeDays?: number;
	limit?: number;
}): Promise<RequestedUnwatchedResponse> {
	const search = new URLSearchParams();
	if (params.minAgeDays !== undefined) search.set("minAgeDays", String(params.minAgeDays));
	if (params.limit !== undefined) search.set("limit", String(params.limit));
	const qs = search.toString();
	return apiRequest(`/api/library/insights/requested-unwatched${qs ? `?${qs}` : ""}`);
}

export function useRequestedUnwatchedInsights(params?: {
	minAgeDays?: number;
	limit?: number;
	enabled?: boolean;
}) {
	return useQuery<RequestedUnwatchedResponse>({
		queryKey: ["library", "insights", "requested-unwatched", params],
		queryFn: () =>
			fetchRequestedUnwatched({
				minAgeDays: params?.minAgeDays,
				limit: params?.limit,
			}),
		enabled: params?.enabled ?? true,
		staleTime: 5 * 60 * 1000,
	});
}
