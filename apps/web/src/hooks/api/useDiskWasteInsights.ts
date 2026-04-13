import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../../lib/api-client/base";

export interface DiskWasteItem {
	arrItemId: number;
	instanceId: string;
	instanceName: string;
	service: string;
	title: string;
	year: number | null;
	sizeOnDisk: number;
	addedDaysAgo: number;
	monitored: boolean;
	qualityProfileName: string | null;
}

interface DiskWasteResponse {
	success: boolean;
	data: {
		items: DiskWasteItem[];
		totalWastedBytes: number;
		hasPlexData: boolean;
		hasWatchData: boolean;
	};
}

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
	return useQuery<DiskWasteResponse>({
		queryKey: ["library", "insights", "disk-waste", params],
		queryFn: () =>
			fetchDiskWaste({
				minSizeGb: params?.minSizeGb,
				minAgeDays: params?.minAgeDays,
				limit: params?.limit,
			}),
		enabled: params?.enabled ?? true,
		staleTime: 5 * 60 * 1000,
	});
}
