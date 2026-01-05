"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
	LibraryEpisodeMonitorRequest,
	LibraryEpisodeSearchRequest,
	LibraryEpisodesResponse,
	LibraryService,
	LibraryToggleMonitorRequest,
	LibrarySeasonSearchRequest,
	LibraryMovieSearchRequest,
	LibrarySeriesSearchRequest,
	PaginatedLibraryResponse,
} from "@arr/shared";

import {
	fetchEpisodes,
	fetchLibrary,
	fetchLibrarySyncStatus,
	triggerLibrarySync,
	updateLibrarySyncSettings,
	searchLibraryEpisode,
	searchLibraryMovie,
	searchLibrarySeason,
	searchLibrarySeries,
	toggleEpisodeMonitoring,
	toggleLibraryMonitoring,
	type LibraryQueryParams,
	type LibrarySyncStatusResponse,
	type LibrarySyncSettings,
} from "../../lib/api-client/library";

const QUEUE_QUERY_KEY = ["dashboard", "queue"] as const;

// ============================================================================
// Library Query Hook (with pagination, search, filters)
// ============================================================================

export interface UseLibraryQueryOptions extends LibraryQueryParams {
	enabled?: boolean;
}

export const useLibraryQuery = (options: UseLibraryQueryOptions = {}) => {
	const { enabled, ...queryParams } = options;

	return useQuery<PaginatedLibraryResponse>({
		queryKey: ["library", queryParams],
		queryFn: () => fetchLibrary(queryParams),
		enabled: enabled ?? true,
		staleTime: 60 * 1000,
		gcTime: 3 * 60 * 1000, // 3 minutes - cleanup old filter/page combinations
		refetchInterval: 5 * 60 * 1000,
	});
};

// ============================================================================
// Library Query Hook for Filtering (fetches ALL items)
// Used by discover page to filter out items already in library
// ============================================================================

export const useLibraryForFiltering = (options: { enabled?: boolean } = {}) => {
	return useQuery<PaginatedLibraryResponse>({
		queryKey: ["library", "all-for-filtering"],
		queryFn: () => fetchLibrary({ limit: 0 }), // limit=0 means fetch all
		enabled: options.enabled ?? true,
		staleTime: 2 * 60 * 1000, // 2 minutes - slightly longer since it's expensive
		gcTime: 3 * 60 * 1000, // 3 minutes - cleanup when leaving discover page
		refetchInterval: 5 * 60 * 1000,
	});
};

// ============================================================================
// Library Sync Hooks
// ============================================================================

export const useLibrarySyncStatus = (options: { enabled?: boolean } = {}) =>
	useQuery<LibrarySyncStatusResponse>({
		queryKey: ["library", "sync", "status"],
		queryFn: fetchLibrarySyncStatus,
		enabled: options.enabled ?? true,
		staleTime: 30 * 1000,
		refetchInterval: 60 * 1000,
	});

export const useTriggerLibrarySyncMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<
		{ success: boolean; message: string; instanceId: string },
		unknown,
		string
	>({
		mutationFn: triggerLibrarySync,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["library", "sync", "status"] });
			// Invalidate library queries after a short delay to allow sync to start
			setTimeout(() => {
				void queryClient.invalidateQueries({ queryKey: ["library"] });
			}, 2000);
		},
	});
};

export const useUpdateLibrarySyncSettingsMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<
		{ success: boolean; settings: LibrarySyncSettings },
		unknown,
		{ instanceId: string; settings: LibrarySyncSettings }
	>({
		mutationFn: ({ instanceId, settings }) => updateLibrarySyncSettings(instanceId, settings),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["library", "sync", "status"] });
		},
	});
};

// ============================================================================
// Library Monitoring Mutations
// ============================================================================

export const useLibraryMonitorMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<void, unknown, LibraryToggleMonitorRequest>({
		mutationFn: toggleLibraryMonitoring,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["library"] });
			void queryClient.invalidateQueries({ queryKey: ["discover", "search"] });
		},
	});
};

export const useLibrarySeasonSearchMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<void, unknown, LibrarySeasonSearchRequest>({
		mutationFn: searchLibrarySeason,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["library"] });
			void queryClient.invalidateQueries({ queryKey: QUEUE_QUERY_KEY });
		},
	});
};

export const useLibraryMovieSearchMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<void, unknown, LibraryMovieSearchRequest>({
		mutationFn: searchLibraryMovie,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["library"] });
			void queryClient.invalidateQueries({ queryKey: QUEUE_QUERY_KEY });
		},
	});
};

export const useLibrarySeriesSearchMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<void, unknown, LibrarySeriesSearchRequest>({
		mutationFn: searchLibrarySeries,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["library"] });
			void queryClient.invalidateQueries({ queryKey: QUEUE_QUERY_KEY });
		},
	});
};

// ============================================================================
// Episode Hooks
// ============================================================================

interface EpisodesQueryOptions {
	instanceId: string;
	seriesId: number | string;
	seasonNumber?: number;
	enabled?: boolean;
}

export const useEpisodesQuery = (options: EpisodesQueryOptions) =>
	useQuery<LibraryEpisodesResponse>({
		queryKey: [
			"library",
			"episodes",
			{
				instanceId: options.instanceId,
				seriesId: options.seriesId,
				seasonNumber: options.seasonNumber,
			},
		],
		queryFn: () =>
			fetchEpisodes({
				instanceId: options.instanceId,
				seriesId: options.seriesId,
				seasonNumber: options.seasonNumber,
			}),
		enabled: options.enabled ?? true,
		staleTime: 60 * 1000,
	});

export const useLibraryEpisodeSearchMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<void, unknown, LibraryEpisodeSearchRequest>({
		mutationFn: searchLibraryEpisode,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["library"] });
			void queryClient.invalidateQueries({ queryKey: ["library", "episodes"] });
			void queryClient.invalidateQueries({ queryKey: QUEUE_QUERY_KEY });
		},
	});
};

export const useLibraryEpisodeMonitorMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<void, unknown, LibraryEpisodeMonitorRequest>({
		mutationFn: toggleEpisodeMonitoring,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["library"] });
			void queryClient.invalidateQueries({ queryKey: ["library", "episodes"] });
		},
	});
};
