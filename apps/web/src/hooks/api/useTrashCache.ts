"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { TrashCacheEntry, TrashConfigType, GitHubRateLimitResponse, SyncMetricsSnapshot } from "@arr/shared";
import type { TrashCacheStatusResponse, RefreshCachePayload } from "../../lib/api-client/trash-guides";
import { fetchCacheStatus, fetchCacheEntries, refreshCache, deleteCacheEntry, fetchGitHubRateLimit, fetchSyncMetrics } from "../../lib/api-client/trash-guides";

/**
 * Hook to fetch TRaSH Guides cache status
 */
export const useTrashCacheStatus = (serviceType?: "RADARR" | "SONARR") =>
	useQuery<TrashCacheStatusResponse>({
		queryKey: ["trash-cache-status", serviceType],
		queryFn: () => fetchCacheStatus(serviceType),
		staleTime: 5 * 60 * 1000, // 5 minutes
		refetchOnMount: true,
	});

/**
 * Hook to fetch TRaSH Guides cache entries with data
 */
export const useTrashCacheEntries = (serviceType: "RADARR" | "SONARR") =>
	useQuery<TrashCacheEntry[]>({
		queryKey: ["trash-cache-entries", serviceType],
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
			void queryClient.invalidateQueries({ queryKey: ["trash-cache-status"] });
			void queryClient.invalidateQueries({ queryKey: ["trash-cache-entries"] });
			// Also invalidate trash-guides related queries for the specific service type
			void queryClient.invalidateQueries({
				queryKey: ["trash-guides", variables.serviceType],
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
			void queryClient.invalidateQueries({ queryKey: ["trash-cache-status"] });
			void queryClient.invalidateQueries({ queryKey: ["trash-cache-entries"] });
			// Invalidate CF includes list since it may have been deleted
			void queryClient.invalidateQueries({ queryKey: ["cf-includes"] });
		},
	});
};

/**
 * Hook to fetch GitHub API rate limit status.
 * Useful for displaying rate limit warnings in the UI.
 */
export const useGitHubRateLimit = (options?: { enabled?: boolean }) =>
	useQuery<GitHubRateLimitResponse>({
		queryKey: ["github-rate-limit"],
		queryFn: fetchGitHubRateLimit,
		staleTime: 30 * 1000, // 30 seconds - rate limits change frequently
		refetchInterval: 60 * 1000, // Refetch every minute when visible
		enabled: options?.enabled ?? true,
	});

/**
 * Hook to fetch sync operation metrics.
 * Provides observability into sync, deployment, and rollback operations.
 */
export const useSyncMetrics = (options?: { enabled?: boolean }) =>
	useQuery<SyncMetricsSnapshot>({
		queryKey: ["sync-metrics"],
		queryFn: fetchSyncMetrics,
		staleTime: 30 * 1000, // 30 seconds
		refetchInterval: 60 * 1000, // Refetch every minute when visible
		enabled: options?.enabled ?? true,
	});
