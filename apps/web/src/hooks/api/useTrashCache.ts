"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { TrashCacheEntry } from "@arr/shared";
import type { TrashCacheStatusResponse, RefreshCachePayload } from "../../lib/api-client/trash-guides";
import { fetchCacheStatus, fetchCacheEntries, refreshCache } from "../../lib/api-client/trash-guides";

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
		onSuccess: () => {
			// Invalidate cache status queries to refetch fresh data
			void queryClient.invalidateQueries({ queryKey: ["trash-cache-status"] });
		},
	});
};
