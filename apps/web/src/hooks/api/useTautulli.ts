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

// ============================================================================
// Query Keys
// ============================================================================

export const tautulliKeys = {
	all: ["tautulli"] as const,
	activity: () => ["tautulli", "activity"] as const,
	stats: (timeRange: number) => ["tautulli", "stats", timeRange] as const,
	playsByDate: (timeRange: number) => ["tautulli", "plays-by-date", timeRange] as const,
	history: (length: number, start: number) => ["tautulli", "history", length, start] as const,
};

// ============================================================================
// Activity (F5)
// ============================================================================

export const useTautulliActivity = (enabled = true) => {
	return useQuery<TautulliActivityResponse>({
		queryKey: tautulliKeys.activity(),
		queryFn: fetchTautulliActivity,
		refetchInterval: 15_000,
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
		staleTime: 5 * 60_000,
		enabled,
	});
};

export const useTautulliPlaysByDate = (timeRange = 30, enabled = true) => {
	return useQuery<TautulliPlaysByDateResponse>({
		queryKey: tautulliKeys.playsByDate(timeRange),
		queryFn: () => fetchTautulliPlaysByDate(timeRange),
		staleTime: 5 * 60_000,
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
		staleTime: 60_000,
		enabled,
	});
};
