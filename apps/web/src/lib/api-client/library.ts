import type {
	LibraryEpisodeMonitorRequest,
	LibraryEpisodeSearchRequest,
	LibraryEpisodesResponse,
	LibraryService,
	LibraryToggleMonitorRequest,
	LibrarySeasonSearchRequest,
	LibraryMovieSearchRequest,
	LibrarySeriesSearchRequest,
	PaginatedLibraryResponse,
} from "@arr/shared";
import { apiRequest, UnauthorizedError } from "./base";

export interface LibraryQueryParams {
	// Pagination
	page?: number;
	limit?: number;
	// Filters
	service?: LibraryService;
	instanceId?: string;
	search?: string;
	monitored?: "true" | "false" | "all";
	hasFile?: "true" | "false" | "all";
	status?: string;
	qualityProfileId?: number;
	yearMin?: number;
	yearMax?: number;
	// Sorting
	sortBy?: "title" | "sortTitle" | "year" | "sizeOnDisk" | "added";
	sortOrder?: "asc" | "desc";
}

export async function fetchLibrary(
	params: LibraryQueryParams = {},
): Promise<PaginatedLibraryResponse> {
	const search = new URLSearchParams();

	// Pagination
	if (params.page !== undefined) search.set("page", String(params.page));
	if (params.limit !== undefined) search.set("limit", String(params.limit));

	// Filters
	if (params.service) search.set("service", params.service);
	if (params.instanceId) search.set("instanceId", params.instanceId);
	if (params.search) search.set("search", params.search);
	if (params.monitored && params.monitored !== "all") search.set("monitored", params.monitored);
	if (params.hasFile && params.hasFile !== "all") search.set("hasFile", params.hasFile);
	if (params.status) search.set("status", params.status);
	if (params.qualityProfileId !== undefined)
		search.set("qualityProfileId", String(params.qualityProfileId));
	if (params.yearMin !== undefined) search.set("yearMin", String(params.yearMin));
	if (params.yearMax !== undefined) search.set("yearMax", String(params.yearMax));

	// Sorting
	if (params.sortBy) search.set("sortBy", params.sortBy);
	if (params.sortOrder) search.set("sortOrder", params.sortOrder);

	const path = search.size > 0 ? `/api/library?${search.toString()}` : "/api/library";

	try {
		return await apiRequest<PaginatedLibraryResponse>(path);
	} catch (error) {
		if (error instanceof UnauthorizedError) {
			return {
				items: [],
				pagination: { page: 1, limit: 50, totalItems: 0, totalPages: 0 },
				appliedFilters: {},
			};
		}
		throw error;
	}
}

export async function toggleLibraryMonitoring(payload: LibraryToggleMonitorRequest): Promise<void> {
	await apiRequest<void>("/api/library/monitor", {
		method: "POST",
		json: payload,
	});
}

export async function searchLibrarySeason(payload: LibrarySeasonSearchRequest): Promise<void> {
	await apiRequest<void>("/api/library/season/search", {
		method: "POST",
		json: payload,
	});
}

export async function searchLibraryMovie(payload: LibraryMovieSearchRequest): Promise<void> {
	await apiRequest<void>("/api/library/movie/search", {
		method: "POST",
		json: payload,
	});
}

export async function searchLibrarySeries(payload: LibrarySeriesSearchRequest): Promise<void> {
	await apiRequest<void>("/api/library/series/search", {
		method: "POST",
		json: payload,
	});
}

export interface FetchEpisodesParams {
	instanceId: string;
	seriesId: number | string;
	seasonNumber?: number;
}

export async function fetchEpisodes(params: FetchEpisodesParams): Promise<LibraryEpisodesResponse> {
	const search = new URLSearchParams({
		instanceId: params.instanceId,
		seriesId: String(params.seriesId),
	});
	if (params.seasonNumber !== undefined) {
		search.set("seasonNumber", String(params.seasonNumber));
	}

	return await apiRequest<LibraryEpisodesResponse>(`/api/library/episodes?${search.toString()}`);
}

export async function searchLibraryEpisode(payload: LibraryEpisodeSearchRequest): Promise<void> {
	await apiRequest<void>("/api/library/episode/search", {
		method: "POST",
		json: payload,
	});
}

export async function toggleEpisodeMonitoring(
	payload: LibraryEpisodeMonitorRequest,
): Promise<void> {
	await apiRequest<void>("/api/library/episode/monitor", {
		method: "POST",
		json: payload,
	});
}

// ============================================================================
// Library Sync API
// ============================================================================

export interface LibrarySyncStatus {
	instanceId: string;
	instanceName: string;
	service: string;
	syncStatus: {
		lastFullSync: string | null;
		lastSyncDurationMs: number | null;
		syncInProgress: boolean;
		lastError: string | null;
		itemCount: number;
		pollingEnabled: boolean;
		pollingIntervalMins: number;
	};
}

export interface LibrarySyncStatusResponse {
	instances: LibrarySyncStatus[];
}

export async function fetchLibrarySyncStatus(): Promise<LibrarySyncStatusResponse> {
	return await apiRequest<LibrarySyncStatusResponse>("/api/library/sync/status");
}

export async function triggerLibrarySync(
	instanceId: string,
): Promise<{ success: boolean; message: string; instanceId: string }> {
	return await apiRequest<{ success: boolean; message: string; instanceId: string }>(
		`/api/library/sync/${instanceId}`,
		{ method: "POST" },
	);
}

export interface LibrarySyncSettings {
	pollingEnabled?: boolean;
	pollingIntervalMins?: number;
}

export async function updateLibrarySyncSettings(
	instanceId: string,
	settings: LibrarySyncSettings,
): Promise<{ success: boolean; settings: LibrarySyncSettings }> {
	return await apiRequest<{ success: boolean; settings: LibrarySyncSettings }>(
		`/api/library/sync/${instanceId}`,
		{ method: "PATCH", json: settings },
	);
}
