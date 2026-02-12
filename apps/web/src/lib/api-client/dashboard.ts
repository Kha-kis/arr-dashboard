import type {
	MultiInstanceQueueResponse,
	QueueActionRequest,
	QueueBulkActionRequest,
	MultiInstanceHistoryResponse,
	MultiInstanceCalendarResponse,
	DashboardStatisticsResponse,
	ManualImportCandidate,
	ManualImportSubmission,
} from "@arr/shared";
import { apiRequest, UnauthorizedError } from "./base";
import { buildQueryUrl } from "../build-query-url";

export async function fetchMultiInstanceQueue(): Promise<MultiInstanceQueueResponse> {
	try {
		return await apiRequest<MultiInstanceQueueResponse>("/api/dashboard/queue");
	} catch (error) {
		if (error instanceof UnauthorizedError) {
			return { instances: [], aggregated: [], totalCount: 0 };
		}
		throw error;
	}
}

export async function fetchMultiInstanceHistory(options?: {
	startDate?: string;
	endDate?: string;
	page?: number;
	pageSize?: number;
}): Promise<MultiInstanceHistoryResponse> {
	const path = buildQueryUrl("/api/dashboard/history", {
		startDate: options?.startDate,
		endDate: options?.endDate,
		page: options?.page,
		pageSize: options?.pageSize,
	});

	try {
		return await apiRequest<MultiInstanceHistoryResponse>(path);
	} catch (error) {
		if (error instanceof UnauthorizedError) {
			return { instances: [], aggregated: [], totalCount: 0 };
		}
		throw error;
	}
}

export async function fetchMultiInstanceCalendar(
	options: { start?: string; end?: string; unmonitored?: boolean } = {},
): Promise<MultiInstanceCalendarResponse> {
	const path = buildQueryUrl("/api/dashboard/calendar", {
		start: options.start,
		end: options.end,
		unmonitored: options.unmonitored,
	});

	try {
		return await apiRequest<MultiInstanceCalendarResponse>(path);
	} catch (error) {
		if (error instanceof UnauthorizedError) {
			return { instances: [], aggregated: [], totalCount: 0 };
		}
		throw error;
	}
}

export async function fetchDashboardStatistics(): Promise<DashboardStatisticsResponse> {
	try {
		return await apiRequest<DashboardStatisticsResponse>("/api/dashboard/statistics");
	} catch (error) {
		if (error instanceof UnauthorizedError) {
			return {
				sonarr: { instances: [] },
				radarr: { instances: [] },
				prowlarr: { instances: [] },
				lidarr: { instances: [] },
				readarr: { instances: [] },
			};
		}
		throw error;
	}
}

export async function performQueueAction(payload: QueueActionRequest): Promise<void> {
	await apiRequest<void>("/api/dashboard/queue/action", {
		method: "POST",
		json: payload,
	});
}

export async function performQueueBulkAction(payload: QueueBulkActionRequest): Promise<void> {
	await apiRequest<void>("/api/dashboard/queue/bulk", {
		method: "POST",
		json: payload,
	});
}

export async function fetchManualImportCandidates(params: {
	instanceId: string;
	service: "sonarr" | "radarr" | "lidarr" | "readarr";
	downloadId?: string;
	folder?: string;
	seriesId?: number;
	seasonNumber?: number;
	filterExistingFiles?: boolean;
}): Promise<{ candidates: ManualImportCandidate[]; total: number }> {
	const path = buildQueryUrl("/api/manual-import", {
		instanceId: params.instanceId,
		service: params.service,
		downloadId: params.downloadId,
		folder: params.folder,
		seriesId: params.seriesId,
		seasonNumber: params.seasonNumber,
		filterExistingFiles: params.filterExistingFiles,
	});

	return await apiRequest<{
		candidates: ManualImportCandidate[];
		total: number;
	}>(path);
}

export async function submitManualImport(payload: ManualImportSubmission): Promise<void> {
	await apiRequest<void>("/api/manual-import", {
		method: "POST",
		json: payload,
	});
}
