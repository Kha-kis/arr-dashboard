import type { TrashCacheStatus, TrashCacheEntry } from "@arr/shared";
import { apiRequest } from "./base";

export type TrashCacheStatusResponse = {
	radarr: TrashCacheStatus[];
	sonarr: TrashCacheStatus[];
	stats?: {
		totalEntries: number;
		staleEntries: number;
		totalSizeBytes: number;
		oldestEntry?: string;
		newestEntry?: string;
	};
};

export type RefreshCachePayload = {
	serviceType: "RADARR" | "SONARR";
	configType?: "CUSTOM_FORMATS" | "CF_GROUPS" | "QUALITY_SIZE" | "NAMING";
	force?: boolean;
};

export type RefreshCacheResponse = {
	message: string;
	refreshed: boolean;
	results?: Record<string, unknown>;
	status?: TrashCacheStatus;
};

/**
 * Fetch cache status for all services or a specific service
 */
export async function fetchCacheStatus(
	serviceType?: "RADARR" | "SONARR",
): Promise<TrashCacheStatusResponse> {
	const url = serviceType
		? `/api/trash-guides/cache/status?serviceType=${serviceType}`
		: "/api/trash-guides/cache/status";

	return await apiRequest<TrashCacheStatusResponse>(url);
}

/**
 * Refresh cache from GitHub
 */
export async function refreshCache(payload: RefreshCachePayload): Promise<RefreshCacheResponse> {
	return await apiRequest<RefreshCacheResponse>("/api/trash-guides/cache/refresh", {
		method: "POST",
		json: payload,
	});
}

/**
 * Fetch cache entries with data
 */
export async function fetchCacheEntries(
	serviceType: "RADARR" | "SONARR",
): Promise<TrashCacheEntry[]> {
	return await apiRequest<TrashCacheEntry[]>(
		`/api/trash-guides/cache/entries?serviceType=${serviceType}`,
	);
}

/**
 * Delete specific cache entry
 */
export async function deleteCacheEntry(
	serviceType: "RADARR" | "SONARR",
	configType: "CUSTOM_FORMATS" | "CF_GROUPS" | "QUALITY_SIZE" | "NAMING",
): Promise<void> {
	await apiRequest<void>(`/api/trash-guides/cache/${serviceType}/${configType}`, {
		method: "DELETE",
	});
}
