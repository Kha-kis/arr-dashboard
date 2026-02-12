/**
 * TMDB API Client
 *
 * Provides functions for accessing TMDB data through the backend API:
 * - Genres (movie/TV)
 * - Similar content
 * - Direct search
 * - Credits (cast/crew)
 * - Videos (trailers)
 * - Watch providers (streaming services)
 */

import { apiRequest, BadRequestError, UnauthorizedError } from "../base";
import type {
	TMDBCreditsResponse,
	TMDBExternalIdsResponse,
	TMDBGenresResponse,
	TMDBPaginatedResponse,
	TMDBVideosResponse,
	TMDBWatchProvidersResponse,
} from "./types";

export type {
	TMDBCastMember,
	TMDBCreditsResponse,
	TMDBCrewMember,
	TMDBExternalIdsResponse,
	TMDBGenre,
	TMDBGenresResponse,
	TMDBPaginatedResponse,
	TMDBSearchResult,
	TMDBVideo,
	TMDBVideosResponse,
	TMDBWatchProvider,
	TMDBWatchProvidersResponse,
} from "./types";

/**
 * Fetch genres for movies or TV shows
 */
export async function fetchTMDBGenres(mediaType: "movie" | "tv"): Promise<TMDBGenresResponse> {
	const params = new URLSearchParams({ mediaType });

	try {
		return await apiRequest<TMDBGenresResponse>(`/api/tmdb/genres?${params.toString()}`);
	} catch (error) {
		if (error instanceof UnauthorizedError || error instanceof BadRequestError) {
			return { genres: [] };
		}
		throw error;
	}
}

/**
 * Fetch similar movies or TV shows
 */
export async function fetchTMDBSimilar(
	mediaType: "movie" | "tv",
	tmdbId: number,
	page = 1,
): Promise<TMDBPaginatedResponse> {
	const params = new URLSearchParams({
		mediaType,
		tmdbId: tmdbId.toString(),
		page: page.toString(),
	});

	try {
		return await apiRequest<TMDBPaginatedResponse>(`/api/tmdb/similar?${params.toString()}`);
	} catch (error) {
		if (error instanceof UnauthorizedError || error instanceof BadRequestError) {
			return { results: [], page: 1, totalPages: 0, totalResults: 0 };
		}
		throw error;
	}
}

/**
 * Search TMDB directly for movies or TV shows
 */
export async function fetchTMDBSearch(
	mediaType: "movie" | "tv",
	query: string,
	options?: { page?: number; year?: number },
): Promise<TMDBPaginatedResponse> {
	const params = new URLSearchParams({
		mediaType,
		query,
		page: (options?.page ?? 1).toString(),
	});
	if (options?.year) {
		params.set("year", options.year.toString());
	}

	try {
		return await apiRequest<TMDBPaginatedResponse>(`/api/tmdb/search?${params.toString()}`);
	} catch (error) {
		if (error instanceof UnauthorizedError || error instanceof BadRequestError) {
			return { results: [], page: 1, totalPages: 0, totalResults: 0 };
		}
		throw error;
	}
}

/**
 * Fetch credits (cast and crew) for a movie or TV show
 */
export async function fetchTMDBCredits(
	mediaType: "movie" | "tv",
	tmdbId: number,
	options?: { aggregate?: boolean },
): Promise<TMDBCreditsResponse> {
	const params = new URLSearchParams({
		mediaType,
		tmdbId: tmdbId.toString(),
	});
	if (options?.aggregate) {
		params.set("aggregate", "true");
	}

	try {
		return await apiRequest<TMDBCreditsResponse>(`/api/tmdb/credits?${params.toString()}`);
	} catch (error) {
		if (error instanceof UnauthorizedError || error instanceof BadRequestError) {
			return { id: tmdbId, cast: [], crew: [] };
		}
		throw error;
	}
}

/**
 * Fetch videos (trailers, clips) for a movie or TV show
 */
export async function fetchTMDBVideos(
	mediaType: "movie" | "tv",
	tmdbId: number,
): Promise<TMDBVideosResponse> {
	const params = new URLSearchParams({
		mediaType,
		tmdbId: tmdbId.toString(),
	});

	try {
		return await apiRequest<TMDBVideosResponse>(`/api/tmdb/videos?${params.toString()}`);
	} catch (error) {
		if (error instanceof UnauthorizedError || error instanceof BadRequestError) {
			return { id: tmdbId, results: [] };
		}
		throw error;
	}
}

/**
 * Fetch external IDs (IMDB, TVDB) for a movie or TV show
 * Used for on-demand fetching when users hover over recommendation cards
 */
export async function fetchTMDBExternalIds(
	mediaType: "movie" | "tv",
	tmdbId: number,
): Promise<TMDBExternalIdsResponse> {
	const params = new URLSearchParams({
		mediaType,
		tmdbId: tmdbId.toString(),
	});

	try {
		return await apiRequest<TMDBExternalIdsResponse>(`/api/tmdb/external-ids?${params.toString()}`);
	} catch (error) {
		if (error instanceof UnauthorizedError || error instanceof BadRequestError) {
			return { tmdbId, imdbId: null, tvdbId: null };
		}
		throw error;
	}
}

/**
 * Fetch watch providers (streaming services) for a movie or TV show
 */
export async function fetchTMDBWatchProviders(
	mediaType: "movie" | "tv",
	tmdbId: number,
	region = "US",
): Promise<TMDBWatchProvidersResponse> {
	const params = new URLSearchParams({
		mediaType,
		tmdbId: tmdbId.toString(),
		region,
	});

	try {
		return await apiRequest<TMDBWatchProvidersResponse>(`/api/tmdb/watch-providers?${params.toString()}`);
	} catch (error) {
		if (error instanceof UnauthorizedError || error instanceof BadRequestError) {
			return { id: tmdbId, region, link: null, flatrate: [], rent: [], buy: [] };
		}
		throw error;
	}
}
