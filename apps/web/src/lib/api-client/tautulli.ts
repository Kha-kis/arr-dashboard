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

export const fetchTautulliStats = (
	timeRange: number,
	options: { includeUserStats?: boolean } = {},
): Promise<TautulliStatsResponse> => {
	const query = new URLSearchParams({ timeRange: String(timeRange) });
	if (options.includeUserStats === false) query.set("includeUserStats", "false");
	return apiRequest(`/api/tautulli/stats?${query.toString()}`);
};

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
