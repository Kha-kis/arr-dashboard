/**
 * Cache API Operations
 *
 * API functions for TRaSH Guides cache management including
 * status checking, refreshing, and GitHub rate limit monitoring.
 */

import { apiRequest } from "../base";
import type {
	TrashCacheStatus,
	TrashCacheEntry,
	TrashConfigType,
	GitHubRateLimitResponse,
	SyncMetricsSnapshot,
	ServiceType,
} from "./types";

// ============================================================================
// Types
// ============================================================================

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
	serviceType: ServiceType;
	configType?: TrashConfigType;
	force?: boolean;
};

export type RefreshCacheResponse = {
	message: string;
	refreshed: boolean;
	results?: Record<string, unknown>;
	status?: TrashCacheStatus;
};

// ============================================================================
// API Functions
// ============================================================================

/**
 * Fetch cache status for all services or a specific service
 */
export async function fetchCacheStatus(
	serviceType?: ServiceType,
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
 * Fetch GitHub API rate limit status
 */
export async function fetchGitHubRateLimit(): Promise<GitHubRateLimitResponse> {
	return await apiRequest<GitHubRateLimitResponse>("/api/trash-guides/cache/rate-limit");
}

/**
 * Fetch sync operation metrics
 */
export async function fetchSyncMetrics(): Promise<SyncMetricsSnapshot> {
	return await apiRequest<SyncMetricsSnapshot>("/api/trash-guides/sync/metrics");
}

/**
 * Fetch cache entries with data
 */
export async function fetchCacheEntries(
	serviceType: ServiceType,
): Promise<TrashCacheEntry[]> {
	return await apiRequest<TrashCacheEntry[]>(
		`/api/trash-guides/cache/entries?serviceType=${serviceType}`,
	);
}

/**
 * Delete specific cache entry
 */
export async function deleteCacheEntry(
	serviceType: ServiceType,
	configType: TrashConfigType,
): Promise<void> {
	await apiRequest<void>(`/api/trash-guides/cache/${serviceType}/${configType}`, {
		method: "DELETE",
	});
}
