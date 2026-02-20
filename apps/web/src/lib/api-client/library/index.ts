import type {
	LibraryAlbumMonitorRequest,
	LibraryAlbumSearchRequest,
	LibraryAlbumsResponse,
	LibraryArtistSearchRequest,
	LibraryAuthorSearchRequest,
	LibraryBookMonitorRequest,
	LibraryBookSearchRequest,
	LibraryBooksResponse,
	LibraryEpisodeMonitorRequest,
	LibraryEpisodeSearchRequest,
	LibraryEpisodesResponse,
	LibraryMovieFileResponse,
	LibraryToggleMonitorRequest,
	LibrarySeasonSearchRequest,
	LibraryMovieSearchRequest,
	LibrarySeriesSearchRequest,
	LibraryTracksResponse,
	PaginatedLibraryResponse,
} from "@arr/shared";
import { apiRequest, UnauthorizedError } from "../base";
import type {
	FetchAlbumsParams,
	FetchBooksParams,
	FetchEpisodesParams,
	FetchTracksParams,
	LibraryQueryParams,
	LibrarySyncSettings,
	LibrarySyncStatusResponse,
} from "./types";

export type {
	FetchAlbumsParams,
	FetchBooksParams,
	FetchEpisodesParams,
	FetchTracksParams,
	LibraryQueryParams,
	LibrarySyncSettings,
	LibrarySyncStatus,
	LibrarySyncStatusResponse,
} from "./types";

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

export async function fetchMovieFile(params: {
	instanceId: string;
	movieId: number | string;
}): Promise<LibraryMovieFileResponse> {
	const search = new URLSearchParams({
		instanceId: params.instanceId,
		movieId: String(params.movieId),
	});
	return await apiRequest<LibraryMovieFileResponse>(`/api/library/movie-file?${search.toString()}`);
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
// Lidarr Album API (child items of artists)
// ============================================================================

export async function fetchAlbums(params: FetchAlbumsParams): Promise<LibraryAlbumsResponse> {
	const search = new URLSearchParams({
		instanceId: params.instanceId,
		artistId: String(params.artistId),
	});

	return await apiRequest<LibraryAlbumsResponse>(`/api/library/albums?${search.toString()}`);
}

export async function fetchTracks(params: FetchTracksParams): Promise<LibraryTracksResponse> {
	const search = new URLSearchParams({
		instanceId: params.instanceId,
		albumId: String(params.albumId),
	});

	return await apiRequest<LibraryTracksResponse>(`/api/library/tracks?${search.toString()}`);
}

export async function searchLibraryArtist(payload: LibraryArtistSearchRequest): Promise<void> {
	await apiRequest<void>("/api/library/artist/search", {
		method: "POST",
		json: payload,
	});
}

export async function searchLibraryAlbum(payload: LibraryAlbumSearchRequest): Promise<void> {
	await apiRequest<void>("/api/library/album/search", {
		method: "POST",
		json: payload,
	});
}

export async function toggleAlbumMonitoring(
	payload: LibraryAlbumMonitorRequest,
): Promise<void> {
	await apiRequest<void>("/api/library/album/monitor", {
		method: "POST",
		json: payload,
	});
}

// ============================================================================
// Readarr Book API (child items of authors)
// ============================================================================

export async function fetchBooks(params: FetchBooksParams): Promise<LibraryBooksResponse> {
	const search = new URLSearchParams({
		instanceId: params.instanceId,
		authorId: String(params.authorId),
	});

	return await apiRequest<LibraryBooksResponse>(`/api/library/books?${search.toString()}`);
}

export async function searchLibraryAuthor(payload: LibraryAuthorSearchRequest): Promise<void> {
	await apiRequest<void>("/api/library/author/search", {
		method: "POST",
		json: payload,
	});
}

export async function searchLibraryBook(payload: LibraryBookSearchRequest): Promise<void> {
	await apiRequest<void>("/api/library/book/search", {
		method: "POST",
		json: payload,
	});
}

export async function toggleBookMonitoring(
	payload: LibraryBookMonitorRequest,
): Promise<void> {
	await apiRequest<void>("/api/library/book/monitor", {
		method: "POST",
		json: payload,
	});
}

// ============================================================================
// Library Sync API
// ============================================================================

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

export async function updateLibrarySyncSettings(
	instanceId: string,
	settings: LibrarySyncSettings,
): Promise<{ success: boolean; settings: LibrarySyncSettings }> {
	return await apiRequest<{ success: boolean; settings: LibrarySyncSettings }>(
		`/api/library/sync/${instanceId}`,
		{ method: "PATCH", json: settings },
	);
}
