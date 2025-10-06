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
}): Promise<MultiInstanceHistoryResponse> {
  const searchParams = new URLSearchParams();
  if (options?.startDate) {
    searchParams.set("startDate", options.startDate);
  }
  if (options?.endDate) {
    searchParams.set("endDate", options.endDate);
  }
  const path =
    searchParams.size > 0
      ? `/api/dashboard/history?${searchParams.toString()}`
      : "/api/dashboard/history";

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
  const searchParams = new URLSearchParams();
  if (options.start) {
    searchParams.set("start", options.start);
  }
  if (options.end) {
    searchParams.set("end", options.end);
  }
  if (typeof options.unmonitored === "boolean") {
    searchParams.set("unmonitored", String(options.unmonitored));
  }

  const path =
    searchParams.size > 0
      ? `/api/dashboard/calendar?${searchParams.toString()}`
      : "/api/dashboard/calendar";

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
    return await apiRequest<DashboardStatisticsResponse>(
      "/api/dashboard/statistics",
    );
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return {
        sonarr: { instances: [] },
        radarr: { instances: [] },
        prowlarr: { instances: [] },
      };
    }
    throw error;
  }
}

export async function performQueueAction(
  payload: QueueActionRequest,
): Promise<void> {
  await apiRequest<void>("/api/dashboard/queue/action", {
    method: "POST",
    json: payload,
  });
}

export async function performQueueBulkAction(
  payload: QueueBulkActionRequest,
): Promise<void> {
  await apiRequest<void>("/api/dashboard/queue/bulk", {
    method: "POST",
    json: payload,
  });
}

export async function fetchManualImportCandidates(params: {
  instanceId: string;
  service: "sonarr" | "radarr";
  downloadId?: string;
  folder?: string;
  seriesId?: number;
  seasonNumber?: number;
  filterExistingFiles?: boolean;
}): Promise<{ candidates: ManualImportCandidate[]; total: number }> {
  const search = new URLSearchParams({
    instanceId: params.instanceId,
    service: params.service,
  });

  if (params.downloadId) {
    search.set("downloadId", params.downloadId);
  }
  if (params.folder) {
    search.set("folder", params.folder);
  }
  if (typeof params.seriesId === "number") {
    search.set("seriesId", String(params.seriesId));
  }
  if (typeof params.seasonNumber === "number") {
    search.set("seasonNumber", String(params.seasonNumber));
  }
  if (typeof params.filterExistingFiles === "boolean") {
    search.set("filterExistingFiles", String(params.filterExistingFiles));
  }

  return await apiRequest<{
    candidates: ManualImportCandidate[];
    total: number;
  }>(`/api/manual-import?${search.toString()}`);
}

export async function submitManualImport(
  payload: ManualImportSubmission,
): Promise<void> {
  await apiRequest<void>("/api/manual-import", {
    method: "POST",
    json: payload,
  });
}
