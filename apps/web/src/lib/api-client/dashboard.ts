import type {
	DashboardStatisticsEnvelope,
	HistoryResponseV2,
	HistoryService,
	ManualImportCandidate,
	ManualImportLegacyQuery,
	ManualImportLegacyStatus,
	ManualImportOperationStatus,
	ManualImportRemainderReview,
	ManualImportSourceQuery,
	ManualImportSourceStatus,
	ManualImportSubmission,
	MultiInstanceCalendarResponse,
	MultiInstanceQueueResponse,
	QueueActionRequest,
	QueueBulkActionRequest,
	QueueSearchOutcome,
} from "@arr/shared";
import {
	dashboardStatisticsEnvelopeSchema,
	historyResponseV2Schema,
	manualImportLegacyQuerySchema,
	manualImportLegacyStatusSchema,
	manualImportOperationStatusSchema,
	manualImportRemainderParamsSchema,
	manualImportRemainderReviewSchema,
	manualImportSourceQuerySchema,
	manualImportSourceStatusSchema,
	multiInstanceCalendarResponseSchema,
	queueSearchOutcomeSchema,
} from "@arr/shared";
import { buildQueryUrl } from "../build-query-url";
import { ApiError, apiRequest, InvalidSuccessResponseError, UnauthorizedError } from "./base";

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
	return await apiRequest<MultiInstanceQueueResponse>("/api/dashboard/queue");
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
		const payload = await apiRequest<unknown>(path);
		const parsed = multiInstanceCalendarResponseSchema.safeParse(payload);
		if (!parsed.success) throw new Error("Calendar response could not be verified");
		return parsed.data;
	} catch (error) {
		if (error instanceof UnauthorizedError) throw error;
		if (error instanceof ApiError) throw new ApiError("Calendar request failed", error.status);
		throw new Error("Calendar response could not be verified");
	}
}

export async function fetchDashboardStatistics(): Promise<DashboardStatisticsEnvelope> {
	const payload = await apiRequest<unknown>("/api/dashboard/statistics/snapshot");
	const parsed = dashboardStatisticsEnvelopeSchema.safeParse(payload);
	if (!parsed.success) throw new Error("Dashboard statistics response was invalid");
	return parsed.data;
}

export type QueueSearchResult =
	| QueueSearchOutcome
	| { removal: "unverified"; search: "unconfirmed" };

export function performQueueAction(
	payload: QueueActionRequest & { action: "delete"; search: true },
): Promise<QueueSearchResult>;
export function performQueueAction(
	payload: QueueActionRequest & { action: "manualImport" },
): Promise<ManualImportOperationStatus>;
export function performQueueAction(
	payload: QueueActionRequest & { action: "delete" | "retry" },
): Promise<undefined | QueueSearchResult>;
export function performQueueAction(
	payload: QueueActionRequest,
): Promise<ManualImportOperationStatus | QueueSearchResult | undefined>;
export async function performQueueAction(
	payload: QueueActionRequest,
): Promise<ManualImportOperationStatus | QueueSearchResult | undefined> {
	const searchRemoval = payload.action === "delete" && payload.search === true;
	let result: unknown;
	try {
		result = await apiRequest<unknown>("/api/dashboard/queue/action", {
			method: "POST",
			json: payload,
			requireJsonSuccess: searchRemoval,
			...(payload.action === "retry" || (payload.action === "delete" && !payload.search)
				? { expectedSuccessStatus: 204 }
				: {}),
		});
	} catch (error) {
		if (searchRemoval && error instanceof InvalidSuccessResponseError)
			return { removal: "unverified", search: "unconfirmed" };
		throw error;
	}
	if (payload.action === "manualImport") return parseImportProgress(result);
	if (payload.action === "delete" && payload.search) {
		if (result === undefined) return { removal: "completed", search: "unconfirmed" };
		const parsed = queueSearchOutcomeSchema.safeParse(result);
		return parsed.success ? parsed.data : { removal: "unverified", search: "unconfirmed" };
	}
}

export async function performQueueBulkAction(payload: QueueBulkActionRequest): Promise<void> {
	await apiRequest<void>("/api/dashboard/queue/bulk", {
		method: "POST",
		json: payload,
		...(payload.action === "retry" || (payload.action === "delete" && !payload.search)
			? { expectedSuccessStatus: 204 }
			: {}),
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

function parseImportProgress(payload: unknown): ManualImportOperationStatus {
	const parsed = manualImportOperationStatusSchema.safeParse(payload);
	if (!parsed.success) throw new Error("Manual import progress response was invalid.");
	return parsed.data;
}

export async function submitManualImport(
	payload: ManualImportSubmission,
): Promise<ManualImportOperationStatus> {
	return parseImportProgress(
		await apiRequest<unknown>("/api/manual-import", {
			method: "POST",
			json: payload,
		}),
	);
}

export async function fetchManualImportProgress(
	idempotencyKey: string,
): Promise<ManualImportOperationStatus> {
	try {
		return parseImportProgress(
			await apiRequest<unknown>(buildQueryUrl("/api/manual-import/operations", { idempotencyKey })),
		);
	} catch (error) {
		if (error instanceof UnauthorizedError) throw error;
		if (error instanceof ApiError)
			throw new ApiError("Cached import progress is unavailable.", error.status);
		throw new Error("Cached import progress is unavailable.");
	}
}

export async function fetchManualImportRemainderReview(
	operationId: string,
	query: ManualImportLegacyQuery,
): Promise<ManualImportRemainderReview> {
	try {
		const params = manualImportRemainderParamsSchema.parse({ operationId });
		const input = manualImportLegacyQuerySchema.parse(query);
		const review = manualImportRemainderReviewSchema.parse(
			await apiRequest<unknown>(
				buildQueryUrl(
					"/api/manual-import/operations/" + encodeURIComponent(params.operationId) + "/remainder",
					input,
				),
			),
		);
		if (
			review.operation.operationId !== operationId ||
			review.candidates.some((candidate) => candidate.service !== input.service)
		)
			throw new Error("Review binding changed");
		return review;
	} catch (error) {
		if (error instanceof UnauthorizedError) throw error;
		if (error instanceof ApiError)
			throw new ApiError("Remaining-file review is unavailable.", error.status);
		throw new Error("Remaining-file review is unavailable.");
	}
}

export async function fetchManualImportLegacyProgress(
	query: ManualImportLegacyQuery,
): Promise<ManualImportLegacyStatus> {
	try {
		const input = manualImportLegacyQuerySchema.safeParse(query);
		if (!input.success) throw new Error("Invalid legacy progress query");
		const parsed = manualImportLegacyStatusSchema.safeParse(
			await apiRequest<unknown>(buildQueryUrl("/api/manual-import/legacy", input.data)),
		);
		if (!parsed.success) throw new Error("Invalid legacy progress response");
		return parsed.data;
	} catch (error) {
		if (error instanceof UnauthorizedError) throw error;
		if (error instanceof ApiError)
			throw new ApiError("Cached legacy import progress is unavailable.", error.status);
		throw new Error("Cached legacy import progress is unavailable.");
	}
}

export async function fetchManualImportSourceProgress(
	query: ManualImportSourceQuery,
): Promise<ManualImportSourceStatus> {
	try {
		const input = manualImportSourceQuerySchema.safeParse(query);
		if (!input.success) throw new Error("Invalid source progress query");
		const parsed = manualImportSourceStatusSchema.safeParse(
			await apiRequest<unknown>(buildQueryUrl("/api/manual-import/source", input.data)),
		);
		if (!parsed.success) throw new Error("Invalid source progress response");
		return parsed.data;
	} catch (error) {
		if (error instanceof UnauthorizedError) throw error;
		if (error instanceof ApiError)
			throw new ApiError("Cached import progress is unavailable.", error.status);
		throw new Error("Cached import progress is unavailable.");
	}
}
