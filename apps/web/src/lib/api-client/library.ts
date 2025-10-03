import type {
  LibraryService,
  LibraryToggleMonitorRequest,
  LibrarySeasonSearchRequest,
  LibraryMovieSearchRequest,
  LibrarySeriesSearchRequest,
  MultiInstanceLibraryResponse,
} from "@arr/shared";
import { apiRequest, UnauthorizedError } from "./base";

export interface LibraryQueryParams {
  service?: LibraryService;
  instanceId?: string;
}

export async function fetchLibrary(
  params: LibraryQueryParams = {},
): Promise<MultiInstanceLibraryResponse> {
  const search = new URLSearchParams();
  if (params.service) {
    search.set("service", params.service);
  }
  if (params.instanceId) {
    search.set("instanceId", params.instanceId);
  }

  const path = search.size > 0 ? `/api/library?${search.toString()}` : "/api/library";

  try {
    return await apiRequest<MultiInstanceLibraryResponse>(path);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return { instances: [], aggregated: [], totalCount: 0 };
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

