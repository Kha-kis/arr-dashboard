"use client";

import type {
	TautulliActivityResponse,
	TautulliCacheHealthResponse,
	TautulliCacheRefreshResponse,
	TautulliCacheStatusResponse,
	TautulliPlaysByDateResponse,
	TautulliStatsResponse,
	TautulliWatchHistoryResponse,
} from "@arr/shared";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	fetchTautulliActivity,
	fetchTautulliCacheHealth,
	fetchTautulliCacheStatus,
	fetchTautulliHistory,
	fetchTautulliPlaysByDate,
	fetchTautulliStats,
	refreshTautulliCache,
} from "../../lib/api-client/tautulli";
import { POLLING_REALTIME, POLLING_STATS, POLLING_STANDARD } from "../../lib/polling-intervals";
import { tautulliKeys } from "../../lib/query-keys";

export const useTautulliActivity = (enabled = true) =>
	useQuery<TautulliActivityResponse>({
		queryKey: tautulliKeys.activity(),
		queryFn: fetchTautulliActivity,
		enabled,
		refetchInterval: POLLING_REALTIME,
		staleTime: POLLING_REALTIME,
	});

export const useTautulliStats = (timeRange = 30, enabled = true) =>
	useQuery<TautulliStatsResponse>({
		queryKey: tautulliKeys.stats(timeRange),
		queryFn: () => fetchTautulliStats(timeRange),
		enabled,
		staleTime: POLLING_STATS,
	});

export const useTautulliPlaysByDate = (timeRange = 30, enabled = true) =>
	useQuery<TautulliPlaysByDateResponse>({
		queryKey: tautulliKeys.playsByDate(timeRange),
		queryFn: () => fetchTautulliPlaysByDate(timeRange),
		enabled,
		staleTime: POLLING_STATS,
	});

export const useTautulliHistory = (offset = 0, limit = 25, enabled = true) =>
	useQuery<TautulliWatchHistoryResponse>({
		queryKey: tautulliKeys.history(offset, limit),
		queryFn: () => fetchTautulliHistory(offset, limit),
		enabled,
		staleTime: POLLING_STANDARD,
		placeholderData: keepPreviousData,
	});

export const useTautulliCacheStatus = (instanceId: string | null | undefined) =>
	useQuery<TautulliCacheStatusResponse>({
		queryKey: tautulliKeys.cacheStatus(instanceId ?? ""),
		queryFn: () => fetchTautulliCacheStatus(instanceId!),
		enabled: Boolean(instanceId),
		staleTime: POLLING_STANDARD,
	});

export const useTautulliCacheHealth = (enabled = true) =>
	useQuery<TautulliCacheHealthResponse>({
		queryKey: tautulliKeys.cacheHealth(),
		queryFn: fetchTautulliCacheHealth,
		enabled,
		staleTime: POLLING_STANDARD,
	});

export const useTautulliCacheRefresh = () => {
	const queryClient = useQueryClient();
	return useMutation<TautulliCacheRefreshResponse, Error, string>({
		mutationFn: refreshTautulliCache,
		onSuccess: () => queryClient.invalidateQueries({ queryKey: tautulliKeys.all }),
	});
};
