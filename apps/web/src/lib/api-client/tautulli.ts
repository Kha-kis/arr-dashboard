/**
 * Tautulli API Client
 *
 * Frontend API functions for Tautulli integration endpoints.
 */

import type {
	TautulliActivityResponse,
	TautulliPlaysByDateResponse,
	TautulliStatsResponse,
	TautulliWatchHistoryResponse,
} from "@arr/shared";
import { apiRequest } from "./base";

/**
 * Fetch current Tautulli activity (active sessions).
 */
export async function fetchTautulliActivity(): Promise<TautulliActivityResponse> {
	return apiRequest("/api/tautulli/activity");
}

/**
 * Fetch aggregated Tautulli stats (home stats + user watch time).
 */
export async function fetchTautulliStats(timeRange = 30): Promise<TautulliStatsResponse> {
	return apiRequest(`/api/tautulli/stats?timeRange=${timeRange}`);
}

/**
 * Fetch plays-by-date time series for charts.
 */
export async function fetchTautulliPlaysByDate(
	timeRange = 30,
): Promise<TautulliPlaysByDateResponse> {
	return apiRequest(`/api/tautulli/stats/plays-by-date?timeRange=${timeRange}`);
}

/**
 * Fetch recent watch history.
 */
export async function fetchWatchHistory(
	length = 25,
	start = 0,
): Promise<TautulliWatchHistoryResponse> {
	return apiRequest(`/api/tautulli/history?length=${length}&start=${start}`);
}
