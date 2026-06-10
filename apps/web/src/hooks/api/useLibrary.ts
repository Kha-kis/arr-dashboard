"use client";

import type {
	LibraryAlbumMonitorRequest,
	LibraryAlbumSearchRequest,
	LibraryAlbumsResponse,
	LibraryArtistSearchRequest,
	LibraryAuthorSearchRequest,
	LibraryBookMonitorRequest,
	LibraryBookSearchRequest,
	LibraryBooksResponse,
	LibraryEpisodeMonitorRequest,
	LibraryEpisodeSearchRequest,
	LibraryEpisodesResponse,
	LibraryMovieFileResponse,
	LibraryMovieSearchRequest,
	LibrarySeasonSearchRequest,
	LibrarySeriesSearchRequest,
	LibraryToggleMonitorRequest,
	LibraryTracksResponse,
	PaginatedLibraryResponse,
} from "@arr/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
	type FetchAlbumsParams,
	type FetchBooksParams,
	type FetchTracksParams,
	fetchAlbums,
	fetchBooks,
	fetchEpisodes,
	fetchLibrary,
	fetchLibrarySyncStatus,
	fetchMovieFile,
	fetchTracks,
	type LibraryQueryParams,
	type LibrarySyncSettings,
	type LibrarySyncStatusResponse,
	searchLibraryAlbum,
	searchLibraryArtist,
	searchLibraryAuthor,
	searchLibraryBook,
	searchLibraryEpisode,
	searchLibraryMovie,
	searchLibrarySeason,
	searchLibrarySeries,
	toggleAlbumMonitoring,
	toggleBookMonitoring,
	toggleEpisodeMonitoring,
	toggleLibraryMonitoring,
	triggerLibrarySync,
	updateLibrarySyncSettings,
} from "../../lib/api-client/library";
import { POLLING_BACKGROUND, POLLING_STANDARD } from "../../lib/polling-intervals";
import { discoverKeys, libraryKeys, QUEUE_QUERY_KEY } from "../../lib/query-keys";

// ============================================================================
// Library Query Hook (with pagination, search, filters)
// ============================================================================

export interface UseLibraryQueryOptions extends LibraryQueryParams {
	enabled?: boolean;
}

export const useLibraryQuery = (options: UseLibraryQueryOptions = {}) => {
	const { enabled, ...queryParams } = options;

	return useQuery<PaginatedLibraryResponse>({
		queryKey: libraryKeys.list(queryParams),
		queryFn: () => fetchLibrary(queryParams),
		enabled: enabled ?? true,
		staleTime: 60 * 1000,
		gcTime: 3 * 60 * 1000, // 3 minutes - cleanup old filter/page combinations
		refetchInterval: POLLING_BACKGROUND,
	});
};

// ============================================================================
// Library Sync Hooks
// ============================================================================

export const useLibrarySyncStatus = (options: { enabled?: boolean } = {}) =>
	useQuery<LibrarySyncStatusResponse>({
		queryKey: libraryKeys.syncStatus,
		queryFn: fetchLibrarySyncStatus,
		enabled: options.enabled ?? true,
		staleTime: 30 * 1000,
		refetchInterval: POLLING_STANDARD,
	});

export const useTriggerLibrarySyncMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<{ success: boolean; message: string; instanceId: string }, unknown, string>({
		mutationFn: triggerLibrarySync,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: libraryKeys.syncStatus });
			// Invalidate library queries after a short delay to allow sync to start
			setTimeout(() => {
				void queryClient.invalidateQueries({ queryKey: libraryKeys.all });
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
			void queryClient.invalidateQueries({ queryKey: libraryKeys.syncStatus });
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
			void queryClient.invalidateQueries({ queryKey: libraryKeys.all });
			void queryClient.invalidateQueries({ queryKey: discoverKeys.searchAll });
		},
	});
};

export const useLibrarySeasonSearchMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<void, unknown, LibrarySeasonSearchRequest>({
		mutationFn: searchLibrarySeason,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: libraryKeys.all });
			void queryClient.invalidateQueries({ queryKey: QUEUE_QUERY_KEY });
		},
	});
};

export const useLibraryMovieSearchMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<void, unknown, LibraryMovieSearchRequest>({
		mutationFn: searchLibraryMovie,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: libraryKeys.all });
			void queryClient.invalidateQueries({ queryKey: QUEUE_QUERY_KEY });
		},
	});
};

export const useLibrarySeriesSearchMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<void, unknown, LibrarySeriesSearchRequest>({
		mutationFn: searchLibrarySeries,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: libraryKeys.all });
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

// ============================================================================
// Movie File Detail Query (live fetch from Radarr, not cached)
// ============================================================================

interface MovieFileQueryOptions {
	instanceId: string;
	movieId: number | string;
	enabled?: boolean;
}

export const useMovieFileQuery = (options: MovieFileQueryOptions) =>
	useQuery<LibraryMovieFileResponse>({
		queryKey: [
			"library",
			"movie-file",
			{ instanceId: options.instanceId, movieId: options.movieId },
		],
		queryFn: () =>
			fetchMovieFile({
				instanceId: options.instanceId,
				movieId: options.movieId,
			}),
		enabled: options.enabled ?? true,
		staleTime: 5 * 60 * 1000,
	});

export const useLibraryEpisodeSearchMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<void, unknown, LibraryEpisodeSearchRequest>({
		mutationFn: searchLibraryEpisode,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: libraryKeys.all });
			void queryClient.invalidateQueries({ queryKey: libraryKeys.episodesAll });
			void queryClient.invalidateQueries({ queryKey: QUEUE_QUERY_KEY });
		},
	});
};

export const useLibraryEpisodeMonitorMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<void, unknown, LibraryEpisodeMonitorRequest>({
		mutationFn: toggleEpisodeMonitoring,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: libraryKeys.all });
			void queryClient.invalidateQueries({ queryKey: libraryKeys.episodesAll });
		},
	});
};

// ============================================================================
// Album Hooks (Lidarr)
// ============================================================================

export const useAlbumsQuery = (options: FetchAlbumsParams & { enabled?: boolean }) => {
	const { enabled, ...params } = options;
	return useQuery<LibraryAlbumsResponse>({
		queryKey: libraryKeys.albums(params.instanceId, params.artistId),
		queryFn: () => fetchAlbums(params),
		enabled: enabled ?? true,
		staleTime: 60 * 1000,
	});
};

export const useLibraryArtistSearchMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<void, unknown, LibraryArtistSearchRequest>({
		mutationFn: searchLibraryArtist,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: libraryKeys.all });
			void queryClient.invalidateQueries({ queryKey: QUEUE_QUERY_KEY });
		},
	});
};

export const useLibraryAlbumSearchMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<void, unknown, LibraryAlbumSearchRequest>({
		mutationFn: searchLibraryAlbum,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: libraryKeys.all });
			void queryClient.invalidateQueries({ queryKey: libraryKeys.albumsAll });
			void queryClient.invalidateQueries({ queryKey: QUEUE_QUERY_KEY });
		},
	});
};

export const useLibraryAlbumMonitorMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<void, unknown, LibraryAlbumMonitorRequest>({
		mutationFn: toggleAlbumMonitoring,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: libraryKeys.all });
			void queryClient.invalidateQueries({ queryKey: libraryKeys.albumsAll });
		},
	});
};

// ============================================================================
// Track Hooks (Lidarr - children of albums)
// ============================================================================

export const useTracksQuery = (options: FetchTracksParams & { enabled?: boolean }) => {
	const { enabled, ...params } = options;
	return useQuery<LibraryTracksResponse>({
		queryKey: libraryKeys.tracks(params.instanceId, params.albumId),
		queryFn: () => fetchTracks(params),
		enabled: enabled ?? true,
		staleTime: 60 * 1000,
	});
};

// ============================================================================
// Book Hooks (Readarr)
// ============================================================================

export const useBooksQuery = (options: FetchBooksParams & { enabled?: boolean }) => {
	const { enabled, ...params } = options;
	return useQuery<LibraryBooksResponse>({
		queryKey: libraryKeys.books(params.instanceId, params.authorId),
		queryFn: () => fetchBooks(params),
		enabled: enabled ?? true,
		staleTime: 60 * 1000,
	});
};

export const useLibraryAuthorSearchMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<void, unknown, LibraryAuthorSearchRequest>({
		mutationFn: searchLibraryAuthor,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: libraryKeys.all });
			void queryClient.invalidateQueries({ queryKey: QUEUE_QUERY_KEY });
		},
	});
};

export const useLibraryBookSearchMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<void, unknown, LibraryBookSearchRequest>({
		mutationFn: searchLibraryBook,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: libraryKeys.all });
			void queryClient.invalidateQueries({ queryKey: libraryKeys.booksAll });
			void queryClient.invalidateQueries({ queryKey: QUEUE_QUERY_KEY });
		},
	});
};

export const useLibraryBookMonitorMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<void, unknown, LibraryBookMonitorRequest>({
		mutationFn: toggleBookMonitoring,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: libraryKeys.all });
			void queryClient.invalidateQueries({ queryKey: libraryKeys.booksAll });
		},
	});
};
