/**
 * Tautulli React Query Hooks
 *
 * Custom hooks for Tautulli integration: activity (now playing) and statistics.
 */

import type {
	TautulliActivityResponse,
	TautulliPlaysByDateResponse,
	TautulliStatsResponse,
	TautulliWatchHistoryResponse,
} from "@arr/shared";
import { useQuery } from "@tanstack/react-query";
import {
	fetchTautulliActivity,
	fetchTautulliPlaysByDate,
	fetchTautulliStats,
	fetchWatchHistory,
} from "../../lib/api-client/tautulli";
import { tautulliKeys } from "../../lib/query-keys";
import { POLLING_BACKGROUND, POLLING_REALTIME, POLLING_STANDARD } from "../../lib/polling-intervals";

// ============================================================================
// Activity (F5)
// ============================================================================

export const useTautulliActivity = (enabled = true, refetchInterval = POLLING_REALTIME) => {
	return useQuery<TautulliActivityResponse>({
		queryKey: tautulliKeys.activity(),
		queryFn: fetchTautulliActivity,
		refetchInterval,
		enabled,
	});
};

// ============================================================================
// Statistics (F7)
// ============================================================================

export const useTautulliStats = (timeRange = 30, enabled = true) => {
	return useQuery<TautulliStatsResponse>({
		queryKey: tautulliKeys.stats(timeRange),
		queryFn: () => fetchTautulliStats(timeRange),
		staleTime: POLLING_BACKGROUND,
		enabled,
	});
};

export const useTautulliPlaysByDate = (timeRange = 30, enabled = true) => {
	return useQuery<TautulliPlaysByDateResponse>({
		queryKey: tautulliKeys.playsByDate(timeRange),
		queryFn: () => fetchTautulliPlaysByDate(timeRange),
		staleTime: POLLING_BACKGROUND,
		enabled,
	});
};

// ============================================================================
// Watch History
// ============================================================================

export const useWatchHistory = (length = 25, start = 0, enabled = true) => {
	return useQuery<TautulliWatchHistoryResponse>({
		queryKey: tautulliKeys.history(length, start),
		queryFn: () => fetchWatchHistory(length, start),
		staleTime: POLLING_STANDARD,
		enabled,
	});
};
