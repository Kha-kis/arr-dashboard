"use client";

import type {
	CacheValidationHealth,
	GitHubRateLimitResponse,
	SyncMetricsSnapshot,
	TrashCacheEntry,
	TrashConfigType,
} from "@arr/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
	RefreshCachePayload,
	TrashCacheStatusResponse,
} from "../../lib/api-client/trash-guides";
import {
	deleteCacheEntry,
	fetchCacheEntries,
	fetchCacheHealth,
	fetchCacheStatus,
	fetchGitHubRateLimit,
	fetchSyncMetrics,
	refreshCache,
} from "../../lib/api-client/trash-guides";
import { POLLING_STANDARD } from "../../lib/polling-intervals";
import { trashCacheKeys, trashGuidesKeys } from "../../lib/query-keys";

/**
 * Hook to fetch TRaSH Guides cache status
 */
export const useTrashCacheStatus = (serviceType?: "RADARR" | "SONARR") =>
	useQuery<TrashCacheStatusResponse>({
		queryKey: trashCacheKeys.status(serviceType),
		queryFn: () => fetchCacheStatus(serviceType),
		staleTime: 5 * 60 * 1000, // 5 minutes
		refetchOnMount: true,
	});

/**
 * Hook to fetch TRaSH Guides cache entries with data
 */
export const useTrashCacheEntries = (serviceType: "RADARR" | "SONARR") =>
	useQuery<TrashCacheEntry[]>({
		queryKey: trashCacheKeys.entries(serviceType),
		queryFn: () => fetchCacheEntries(serviceType),
		staleTime: 5 * 60 * 1000, // 5 minutes
	});

/**
 * Hook to refresh TRaSH Guides cache
 */
export const useRefreshTrashCache = () => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (payload: RefreshCachePayload) => refreshCache(payload),
		onSuccess: (_data, variables) => {
			// Invalidate cache status and entries queries to refetch fresh data
			void queryClient.invalidateQueries({ queryKey: trashCacheKeys.allStatus });
			void queryClient.invalidateQueries({ queryKey: trashCacheKeys.allEntries });
			// Also invalidate trash-guides related queries for the specific service type
			void queryClient.invalidateQueries({
				queryKey: trashGuidesKeys.byService(variables.serviceType),
			});
		},
	});
};

/**
 * Payload for deleting a cache entry
 */
export type DeleteCachePayload = {
	serviceType: "RADARR" | "SONARR";
	configType: TrashConfigType;
};

/**
 * Hook to delete a specific cache entry
 */
export const useDeleteTrashCacheEntry = () => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ serviceType, configType }: DeleteCachePayload) =>
			deleteCacheEntry(serviceType, configType),
		onSuccess: () => {
			// Invalidate cache status and entries queries to refetch fresh data
			void queryClient.invalidateQueries({ queryKey: trashCacheKeys.allStatus });
			void queryClient.invalidateQueries({ queryKey: trashCacheKeys.allEntries });
			// Invalidate CF includes list since it may have been deleted
			void queryClient.invalidateQueries({ queryKey: trashCacheKeys.cfIncludes });
		},
	});
};

/**
 * Hook to fetch GitHub API rate limit status.
 * Useful for displaying rate limit warnings in the UI.
 */
export const useGitHubRateLimit = (options?: { enabled?: boolean }) =>
	useQuery<GitHubRateLimitResponse>({
		queryKey: trashCacheKeys.gitHubRateLimit,
		queryFn: fetchGitHubRateLimit,
		staleTime: 30 * 1000, // 30 seconds - rate limits change frequently
		refetchInterval: POLLING_STANDARD,
		enabled: options?.enabled ?? true,
	});

/**
 * Hook to fetch sync operation metrics.
 * Provides observability into sync, deployment, and rollback operations.
 */
export const useSyncMetrics = (options?: { enabled?: boolean }) =>
	useQuery<SyncMetricsSnapshot>({
		queryKey: trashCacheKeys.syncMetrics,
		queryFn: fetchSyncMetrics,
		staleTime: 30 * 1000, // 30 seconds
		refetchInterval: POLLING_STANDARD,
		enabled: options?.enabled ?? true,
	});

/**
 * Hook to fetch cache validation health stats.
 * Shows per-category validation results from the last cache refresh.
 */
export const useCacheHealth = (options?: { enabled?: boolean }) =>
	useQuery<CacheValidationHealth>({
		queryKey: trashCacheKeys.cacheHealth,
		queryFn: fetchCacheHealth,
		staleTime: 5 * 60 * 1000, // 5 minutes — only changes on cache refresh
		enabled: options?.enabled ?? true,
	});
