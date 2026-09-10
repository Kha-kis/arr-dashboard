import type {
	DashboardStatisticsResponse,
	HistoryResponseV2,
	HistoryService,
	ManualImportCandidate,
	ManualImportSubmission,
	MultiInstanceCalendarResponse,
	MultiInstanceQueueResponse,
	QueueActionRequest,
	QueueBulkActionRequest,
} from "@arr/shared";
import { historyResponseV2Schema } from "@arr/shared";
import { buildQueryUrl } from "../build-query-url";
import { ApiError, apiRequest, UnauthorizedError } from "./base";

export interface HistoryRequest {
	limit: number;
	cursor: string | null;
	startDate: string | null;
	endDate: string | null;
	search: string | null;
	service: HistoryService | null;
	instanceId: string | null;
	eventType: string | null;
	hideProwlarrRss: boolean;
}

const DEFAULT_HISTORY_REQUEST: HistoryRequest = {
	limit: 25,
	cursor: null,
	startDate: null,
	endDate: null,
	search: null,
	service: null,
	instanceId: null,
	eventType: null,
	hideProwlarrRss: true,
};

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

export async function fetchMultiInstanceHistory(
	options: Partial<HistoryRequest> = DEFAULT_HISTORY_REQUEST,
): Promise<HistoryResponseV2> {
	const request = { ...DEFAULT_HISTORY_REQUEST, ...options };
	if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100) {
		throw new Error("History request is invalid");
	}
	const path = buildQueryUrl("/api/dashboard/history", {
		limit: request.limit,
		cursor: request.cursor,
		startDate: request.startDate,
		endDate: request.endDate,
		search: request.search,
		service: request.service,
		instanceId: request.instanceId,
		eventType: request.eventType,
		hideProwlarrRss: request.hideProwlarrRss,
	});

	try {
		const result = await apiRequest<unknown>(path);
		const parsed = historyResponseV2Schema.safeParse(result);
		if (!parsed.success) throw new Error("History response was invalid");
		return parsed.data;
	} catch (error) {
		if (error instanceof UnauthorizedError) throw error;
		if (error instanceof ApiError && error.status >= 500) {
			throw new ApiError("History request failed", error.status);
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
