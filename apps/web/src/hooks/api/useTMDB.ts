"use client";

import { useQuery, useInfiniteQuery } from "@tanstack/react-query";
import {
	fetchTMDBGenres,
	fetchTMDBSimilar,
	fetchTMDBSearch,
	fetchTMDBCredits,
	fetchTMDBVideos,
	fetchTMDBWatchProviders,
	type TMDBGenresResponse,
	type TMDBPaginatedResponse,
	type TMDBCreditsResponse,
	type TMDBVideosResponse,
	type TMDBWatchProvidersResponse,
} from "../../lib/api-client/tmdb";

// ============================================================================
// Genres
// ============================================================================

/**
 * Fetch genres for movies or TV shows
 */
export const useTMDBGenresQuery = (mediaType: "movie" | "tv", enabled = true) =>
	useQuery<TMDBGenresResponse>({
		queryKey: ["tmdb", "genres", mediaType],
		queryFn: () => fetchTMDBGenres(mediaType),
		enabled,
		staleTime: 24 * 60 * 60 * 1000, // 24 hours - genres rarely change
	});

// ============================================================================
// Similar Content
// ============================================================================

/**
 * Fetch similar movies or TV shows
 */
export const useTMDBSimilarQuery = (
	mediaType: "movie" | "tv",
	tmdbId: number | null,
	page = 1,
	enabled = true,
) =>
	useQuery<TMDBPaginatedResponse>({
		queryKey: ["tmdb", "similar", mediaType, tmdbId, page],
		queryFn: () => fetchTMDBSimilar(mediaType, tmdbId!, page),
		enabled: enabled && tmdbId !== null,
		staleTime: 60 * 60 * 1000, // 1 hour
	});

/**
 * Infinite query for similar content with pagination
 */
export const useInfiniteTMDBSimilarQuery = (
	mediaType: "movie" | "tv",
	tmdbId: number | null,
	enabled = true,
) =>
	useInfiniteQuery<TMDBPaginatedResponse>({
		queryKey: ["tmdb", "similar", "infinite", mediaType, tmdbId],
		queryFn: ({ pageParam = 1 }) => fetchTMDBSimilar(mediaType, tmdbId!, pageParam as number),
		enabled: enabled && tmdbId !== null,
		staleTime: 60 * 60 * 1000,
		getNextPageParam: (lastPage) => {
			if (lastPage.page < lastPage.totalPages) {
				return lastPage.page + 1;
			}
			return undefined;
		},
		initialPageParam: 1,
	});

// ============================================================================
// Search
// ============================================================================

interface TMDBSearchOptions {
	query: string;
	mediaType: "movie" | "tv";
	page?: number;
	year?: number;
	enabled?: boolean;
}

/**
 * Search TMDB for movies or TV shows
 */
export const useTMDBSearchQuery = ({
	query,
	mediaType,
	page = 1,
	year,
	enabled = true,
}: TMDBSearchOptions) =>
	useQuery<TMDBPaginatedResponse>({
		queryKey: ["tmdb", "search", mediaType, query, page, year],
		queryFn: () => fetchTMDBSearch(mediaType, query, { page, year }),
		enabled: enabled && query.trim().length > 0,
		staleTime: 5 * 60 * 1000, // 5 minutes
	});

/**
 * Infinite search query with pagination
 */
export const useInfiniteTMDBSearchQuery = ({
	query,
	mediaType,
	year,
	enabled = true,
}: Omit<TMDBSearchOptions, "page">) =>
	useInfiniteQuery<TMDBPaginatedResponse>({
		queryKey: ["tmdb", "search", "infinite", mediaType, query, year],
		queryFn: ({ pageParam = 1 }) =>
			fetchTMDBSearch(mediaType, query, { page: pageParam as number, year }),
		enabled: enabled && query.trim().length > 0,
		staleTime: 5 * 60 * 1000,
		getNextPageParam: (lastPage) => {
			if (lastPage.page < lastPage.totalPages) {
				return lastPage.page + 1;
			}
			return undefined;
		},
		initialPageParam: 1,
	});

// ============================================================================
// Credits
// ============================================================================

interface TMDBCreditsOptions {
	mediaType: "movie" | "tv";
	tmdbId: number | null;
	aggregate?: boolean;
	enabled?: boolean;
}

/**
 * Fetch credits (cast and crew) for a movie or TV show
 */
export const useTMDBCreditsQuery = ({
	mediaType,
	tmdbId,
	aggregate = false,
	enabled = true,
}: TMDBCreditsOptions) =>
	useQuery<TMDBCreditsResponse>({
		queryKey: ["tmdb", "credits", mediaType, tmdbId, aggregate],
		queryFn: () => fetchTMDBCredits(mediaType, tmdbId!, { aggregate }),
		enabled: enabled && tmdbId !== null,
		staleTime: 24 * 60 * 60 * 1000, // 24 hours - credits rarely change
	});

// ============================================================================
// Videos
// ============================================================================

/**
 * Fetch videos (trailers, clips) for a movie or TV show
 */
export const useTMDBVideosQuery = (
	mediaType: "movie" | "tv",
	tmdbId: number | null,
	enabled = true,
) =>
	useQuery<TMDBVideosResponse>({
		queryKey: ["tmdb", "videos", mediaType, tmdbId],
		queryFn: () => fetchTMDBVideos(mediaType, tmdbId!),
		enabled: enabled && tmdbId !== null,
		staleTime: 24 * 60 * 60 * 1000, // 24 hours
	});

// ============================================================================
// Watch Providers
// ============================================================================

interface TMDBWatchProvidersOptions {
	mediaType: "movie" | "tv";
	tmdbId: number | null;
	region?: string;
	enabled?: boolean;
}

/**
 * Fetch watch providers (streaming services) for a movie or TV show
 */
export const useTMDBWatchProvidersQuery = ({
	mediaType,
	tmdbId,
	region = "US",
	enabled = true,
}: TMDBWatchProvidersOptions) =>
	useQuery<TMDBWatchProvidersResponse>({
		queryKey: ["tmdb", "watch-providers", mediaType, tmdbId, region],
		queryFn: () => fetchTMDBWatchProviders(mediaType, tmdbId!, region),
		enabled: enabled && tmdbId !== null,
		staleTime: 60 * 60 * 1000, // 1 hour - availability can change
	});
