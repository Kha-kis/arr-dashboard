import type { DiskWasteInsightsResponse } from "@arr/shared";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../../lib/api-client/base";

export type { DiskWasteItem, DiskWasteInsightsResponse } from "@arr/shared";
export type DiskWasteResponse = DiskWasteInsightsResponse;

function fetchDiskWaste(params: {
	minSizeGb?: number;
	minAgeDays?: number;
	limit?: number;
}): Promise<DiskWasteResponse> {
	const search = new URLSearchParams();
	if (params.minSizeGb !== undefined) search.set("minSizeGb", String(params.minSizeGb));
	if (params.minAgeDays !== undefined) search.set("minAgeDays", String(params.minAgeDays));
	if (params.limit !== undefined) search.set("limit", String(params.limit));
	const qs = search.toString();
	return apiRequest(`/api/library/insights/disk-waste${qs ? `?${qs}` : ""}`);
}

export function useDiskWasteInsights(params?: {
	minSizeGb?: number;
	minAgeDays?: number;
	limit?: number;
	enabled?: boolean;
}) {
	const { enabled = true, ...queryParams } = params ?? {};
	return useQuery<DiskWasteResponse>({
		queryKey: ["library", "insights", "disk-waste", params ? queryParams : undefined],
		queryFn: () =>
			fetchDiskWaste({
				minSizeGb: params?.minSizeGb,
				minAgeDays: params?.minAgeDays,
				limit: params?.limit,
			}),
		enabled,
		staleTime: 5 * 60 * 1000,
	});
}
