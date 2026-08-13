import type {
	TautulliActivityResponse,
	TautulliCacheHealthResponse,
	TautulliCacheRefreshResponse,
	TautulliCacheStatusResponse,
	TautulliPlaysByDateResponse,
	TautulliStatsResponse,
	TautulliWatchHistoryResponse,
} from "@arr/shared";
import { apiRequest } from "./base";

export const fetchTautulliActivity = (): Promise<TautulliActivityResponse> =>
	apiRequest("/api/tautulli/activity");

export const fetchTautulliStats = (timeRange: number): Promise<TautulliStatsResponse> =>
	apiRequest(`/api/tautulli/stats?timeRange=${encodeURIComponent(timeRange)}`);

export const fetchTautulliPlaysByDate = (timeRange: number): Promise<TautulliPlaysByDateResponse> =>
	apiRequest(`/api/tautulli/stats/plays-by-date?timeRange=${encodeURIComponent(timeRange)}`);

export const fetchTautulliHistory = (
	offset: number,
	limit: number,
): Promise<TautulliWatchHistoryResponse> =>
	apiRequest(
		`/api/tautulli/history?offset=${encodeURIComponent(offset)}&limit=${encodeURIComponent(limit)}`,
	);

export const fetchTautulliCacheStatus = (
	instanceId: string,
): Promise<TautulliCacheStatusResponse> =>
	apiRequest(`/api/tautulli/cache/${encodeURIComponent(instanceId)}/status`);

export const fetchTautulliCacheHealth = (): Promise<TautulliCacheHealthResponse> =>
	apiRequest("/api/tautulli/cache/health");

export const refreshTautulliCache = (instanceId: string): Promise<TautulliCacheRefreshResponse> =>
	apiRequest(`/api/tautulli/cache/${encodeURIComponent(instanceId)}/refresh`, {
		method: "POST",
		json: {},
	});
