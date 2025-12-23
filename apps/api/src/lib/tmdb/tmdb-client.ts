/**
 * Cached TMDB Client
 *
 * Wraps tmdb-ts with an in-memory caching layer to reduce API calls.
 * Provides a clean, organized interface for accessing TMDB data.
 */

import {
	TMDB,
	type Movie,
	type ExternalIds,
	type Credits,
	type Videos,
	type WatchProviders,
	type AggregateCredits,
} from "tmdb-ts";

// ============================================================================
// Normalized Types (consistent across all endpoints)
// ============================================================================

/**
 * Normalized TV show type that works across all endpoints
 */
export interface TMDBTVShow {
	id: number;
	name: string;
	original_name: string;
	overview: string;
	poster_path: string | null;
	backdrop_path: string | null;
	first_air_date: string;
	genre_ids: number[];
	origin_country: string[];
	original_language: string;
	vote_average: number;
	vote_count: number;
	popularity: number;
}

/**
 * Normalized movie type (re-export from tmdb-ts for convenience)
 */
export type TMDBMovie = Movie;

/**
 * Genre type
 */
export interface TMDBGenre {
	id: number;
	name: string;
}

/**
 * Paginated response wrapper
 */
export interface PaginatedResponse<T> {
	page: number;
	results: T[];
	total_pages: number;
	total_results: number;
}

// ============================================================================
// Cache Implementation
// ============================================================================

interface CacheEntry<T> {
	data: T;
	timestamp: number;
	ttl: number;
}

// Cache TTLs
const LIST_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes for discovery lists
const EXTERNAL_IDS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours for external IDs
const GENRE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours for genre lists
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes for search results
const SIMILAR_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour for similar content
const CREDITS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours for credits (rarely change)
const VIDEOS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours for videos
const WATCH_PROVIDERS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour for watch providers (can change)

// Shared caches (global to reduce memory when multiple clients exist)
const listCache = new Map<string, CacheEntry<unknown>>();
const externalIdsCache = new Map<string, CacheEntry<ExternalIds>>();
const genreCache = new Map<string, CacheEntry<{ genres: TMDBGenre[] }>>();
const searchCache = new Map<string, CacheEntry<unknown>>();
const similarCache = new Map<string, CacheEntry<unknown>>();
const creditsCache = new Map<string, CacheEntry<Credits | AggregateCredits>>();
const videosCache = new Map<string, CacheEntry<Videos>>();
const watchProvidersCache = new Map<string, CacheEntry<WatchProviders>>();

function getCacheKey(type: string, ...args: (string | number)[]): string {
	return `${type}:${args.join(":")}`;
}

function getFromCache<T>(
	cache: Map<string, CacheEntry<T>>,
	key: string,
): T | null {
	const entry = cache.get(key);
	if (!entry) return null;

	const now = Date.now();
	if (now - entry.timestamp > entry.ttl) {
		cache.delete(key);
		return null;
	}

	return entry.data;
}

function setInCache<T>(
	cache: Map<string, CacheEntry<T>>,
	key: string,
	data: T,
	ttl: number,
): void {
	cache.set(key, { data, timestamp: Date.now(), ttl });
}

// Periodic cache cleanup to prevent memory leaks (runs every 5 minutes)
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

function cleanupCache<T>(cache: Map<string, CacheEntry<T>>): void {
	const now = Date.now();
	const keysToDelete: string[] = [];

	cache.forEach((entry, key) => {
		if (now - entry.timestamp > entry.ttl) {
			keysToDelete.push(key);
		}
	});

	for (const key of keysToDelete) {
		cache.delete(key);
	}
}

function startCacheCleanup(): void {
	if (cleanupInterval) return;

	cleanupInterval = setInterval(
		() => {
			cleanupCache(listCache as Map<string, CacheEntry<unknown>>);
			cleanupCache(externalIdsCache);
			cleanupCache(genreCache);
			cleanupCache(searchCache as Map<string, CacheEntry<unknown>>);
			cleanupCache(similarCache as Map<string, CacheEntry<unknown>>);
			cleanupCache(creditsCache);
			cleanupCache(videosCache);
			cleanupCache(watchProvidersCache);
		},
		5 * 60 * 1000,
	);
}

// Start cleanup on module load
startCacheCleanup();

// ============================================================================
// Helper to normalize TV show responses
// ============================================================================

interface RawTVShowResult {
	id: number;
	name: string;
	original_name: string;
	overview: string;
	poster_path: string | null;
	backdrop_path: string | null;
	first_air_date: string;
	genre_ids: number[];
	origin_country: string[];
	original_language: string;
	vote_average: number;
	vote_count: number;
	popularity: number;
}

function normalizeTVShow(raw: RawTVShowResult): TMDBTVShow {
	return {
		id: raw.id,
		name: raw.name,
		original_name: raw.original_name,
		overview: raw.overview,
		poster_path: raw.poster_path,
		backdrop_path: raw.backdrop_path,
		first_air_date: raw.first_air_date,
		genre_ids: raw.genre_ids,
		origin_country: raw.origin_country,
		original_language: raw.original_language,
		vote_average: raw.vote_average,
		vote_count: raw.vote_count,
		popularity: raw.popularity,
	};
}

// ============================================================================
// Client Options
// ============================================================================

export interface TMDBClientOptions {
	/** Base URL for TMDB images (e.g., "https://image.tmdb.org/t/p") */
	imageBaseUrl: string;
}

// ============================================================================
// TMDB Client
// ============================================================================

export class TMDBClient {
	private readonly client: TMDB;
	private readonly imageBaseUrl: string;

	constructor(apiKey: string, options: TMDBClientOptions) {
		this.client = new TMDB(apiKey);
		this.imageBaseUrl = options.imageBaseUrl;
	}

	// ==========================================================================
	// Image URL Helper
	// ==========================================================================

	/**
	 * Get full image URL from a TMDB path
	 */
	getImageUrl(
		path: string | null | undefined,
		size: "w185" | "w342" | "w500" | "w780" | "original" = "w500",
	): string | null {
		if (!path) return null;
		return `${this.imageBaseUrl}/${size}${path}`;
	}

	// ==========================================================================
	// Trending Endpoints
	// ==========================================================================

	readonly trending = {
		/**
		 * Get trending movies
		 */
		movies: async (
			timeWindow: "day" | "week" = "week",
			page = 1,
		): Promise<PaginatedResponse<TMDBMovie>> => {
			const cacheKey = getCacheKey("trending_movies", timeWindow, page);
			const cached = getFromCache<PaginatedResponse<TMDBMovie>>(
				listCache as Map<string, CacheEntry<PaginatedResponse<TMDBMovie>>>,
				cacheKey,
			);
			if (cached) return cached;

			const response = await this.client.trending.trending("movie", timeWindow, { page });

			const result: PaginatedResponse<TMDBMovie> = {
				page: response.page,
				results: response.results as TMDBMovie[],
				total_results: response.total_results,
				total_pages: response.total_pages,
			};

			setInCache(
				listCache as Map<string, CacheEntry<PaginatedResponse<TMDBMovie>>>,
				cacheKey,
				result,
				LIST_CACHE_TTL_MS,
			);
			return result;
		},

		/**
		 * Get trending TV shows
		 */
		tv: async (
			timeWindow: "day" | "week" = "week",
			page = 1,
		): Promise<PaginatedResponse<TMDBTVShow>> => {
			const cacheKey = getCacheKey("trending_tv", timeWindow, page);
			const cached = getFromCache<PaginatedResponse<TMDBTVShow>>(
				listCache as Map<string, CacheEntry<PaginatedResponse<TMDBTVShow>>>,
				cacheKey,
			);
			if (cached) return cached;

			const response = await this.client.trending.trending("tv", timeWindow, { page });

			const result: PaginatedResponse<TMDBTVShow> = {
				page: response.page,
				results: (response.results as RawTVShowResult[]).map(normalizeTVShow),
				total_results: response.total_results,
				total_pages: response.total_pages,
			};

			setInCache(
				listCache as Map<string, CacheEntry<PaginatedResponse<TMDBTVShow>>>,
				cacheKey,
				result,
				LIST_CACHE_TTL_MS,
			);
			return result;
		},
	};

	// ==========================================================================
	// Movies Endpoints
	// ==========================================================================

	readonly movies = {
		/**
		 * Get popular movies
		 */
		popular: async (page = 1): Promise<PaginatedResponse<TMDBMovie>> => {
			const cacheKey = getCacheKey("popular_movies", page);
			const cached = getFromCache<PaginatedResponse<TMDBMovie>>(
				listCache as Map<string, CacheEntry<PaginatedResponse<TMDBMovie>>>,
				cacheKey,
			);
			if (cached) return cached;

			const response = await this.client.movies.popular({ page });

			const result: PaginatedResponse<TMDBMovie> = {
				page: response.page,
				results: response.results,
				total_results: response.total_results,
				total_pages: response.total_pages,
			};

			setInCache(
				listCache as Map<string, CacheEntry<PaginatedResponse<TMDBMovie>>>,
				cacheKey,
				result,
				LIST_CACHE_TTL_MS,
			);
			return result;
		},

		/**
		 * Get top rated movies
		 */
		topRated: async (page = 1): Promise<PaginatedResponse<TMDBMovie>> => {
			const cacheKey = getCacheKey("top_rated_movies", page);
			const cached = getFromCache<PaginatedResponse<TMDBMovie>>(
				listCache as Map<string, CacheEntry<PaginatedResponse<TMDBMovie>>>,
				cacheKey,
			);
			if (cached) return cached;

			const response = await this.client.movies.topRated({ page });

			const result: PaginatedResponse<TMDBMovie> = {
				page: response.page,
				results: response.results,
				total_results: response.total_results,
				total_pages: response.total_pages,
			};

			setInCache(
				listCache as Map<string, CacheEntry<PaginatedResponse<TMDBMovie>>>,
				cacheKey,
				result,
				LIST_CACHE_TTL_MS,
			);
			return result;
		},

		/**
		 * Get upcoming movies
		 */
		upcoming: async (page = 1): Promise<PaginatedResponse<TMDBMovie>> => {
			const cacheKey = getCacheKey("upcoming_movies", page);
			const cached = getFromCache<PaginatedResponse<TMDBMovie>>(
				listCache as Map<string, CacheEntry<PaginatedResponse<TMDBMovie>>>,
				cacheKey,
			);
			if (cached) return cached;

			const response = await this.client.movies.upcoming({ page });

			// Filter to only include movies with future release dates
			const today = new Date();
			today.setHours(0, 0, 0, 0);

			const futureMovies = response.results.filter((movie) => {
				if (!movie.release_date) return false;
				const releaseDate = new Date(movie.release_date);
				return releaseDate >= today;
			});

			const result: PaginatedResponse<TMDBMovie> = {
				page: response.page,
				results: futureMovies,
				total_results: response.total_results,
				total_pages: response.total_pages,
			};

			setInCache(
				listCache as Map<string, CacheEntry<PaginatedResponse<TMDBMovie>>>,
				cacheKey,
				result,
				LIST_CACHE_TTL_MS,
			);
			return result;
		},

		/**
		 * Get similar movies
		 */
		similar: async (
			movieId: number,
			page = 1,
		): Promise<PaginatedResponse<TMDBMovie>> => {
			const cacheKey = getCacheKey("similar_movies", movieId, page);
			const cached = getFromCache<PaginatedResponse<TMDBMovie>>(
				similarCache as Map<string, CacheEntry<PaginatedResponse<TMDBMovie>>>,
				cacheKey,
			);
			if (cached) return cached;

			const response = await this.client.movies.similar(movieId, { page });

			const result: PaginatedResponse<TMDBMovie> = {
				page: response.page,
				results: response.results,
				total_pages: response.total_pages,
				total_results: response.total_results,
			};

			setInCache(
				similarCache as Map<string, CacheEntry<PaginatedResponse<TMDBMovie>>>,
				cacheKey,
				result,
				SIMILAR_CACHE_TTL_MS,
			);
			return result;
		},

		/**
		 * Get external IDs for a movie (IMDB, etc.)
		 */
		externalIds: async (movieId: number): Promise<ExternalIds> => {
			const cacheKey = getCacheKey("movie_external_ids", movieId);
			const cached = getFromCache(externalIdsCache, cacheKey);
			if (cached) return cached;

			const result = await this.client.movies.externalIds(movieId);

			setInCache(externalIdsCache, cacheKey, result, EXTERNAL_IDS_CACHE_TTL_MS);
			return result;
		},

		/**
		 * Get credits (cast and crew) for a movie
		 */
		credits: async (movieId: number): Promise<Credits> => {
			const cacheKey = getCacheKey("movie_credits", movieId);
			const cached = getFromCache(creditsCache, cacheKey);
			if (cached) return cached as Credits;

			const result = await this.client.movies.credits(movieId);

			setInCache(creditsCache, cacheKey, result, CREDITS_CACHE_TTL_MS);
			return result;
		},

		/**
		 * Get videos (trailers, clips, etc.) for a movie
		 */
		videos: async (movieId: number): Promise<Videos> => {
			const cacheKey = getCacheKey("movie_videos", movieId);
			const cached = getFromCache(videosCache, cacheKey);
			if (cached) return cached;

			const result = await this.client.movies.videos(movieId);

			setInCache(videosCache, cacheKey, result, VIDEOS_CACHE_TTL_MS);
			return result;
		},

		/**
		 * Get watch providers (streaming services) for a movie
		 * Powered by JustWatch
		 */
		watchProviders: async (movieId: number): Promise<WatchProviders> => {
			const cacheKey = getCacheKey("movie_watch_providers", movieId);
			const cached = getFromCache(watchProvidersCache, cacheKey);
			if (cached) return cached;

			const result = await this.client.movies.watchProviders(movieId);

			setInCache(watchProvidersCache, cacheKey, result, WATCH_PROVIDERS_CACHE_TTL_MS);
			return result;
		},
	};

	// ==========================================================================
	// TV Shows Endpoints
	// ==========================================================================

	readonly tv = {
		/**
		 * Get popular TV shows
		 */
		popular: async (page = 1): Promise<PaginatedResponse<TMDBTVShow>> => {
			const cacheKey = getCacheKey("popular_tv", page);
			const cached = getFromCache<PaginatedResponse<TMDBTVShow>>(
				listCache as Map<string, CacheEntry<PaginatedResponse<TMDBTVShow>>>,
				cacheKey,
			);
			if (cached) return cached;

			const response = await this.client.tvShows.popular({ page });

			const result: PaginatedResponse<TMDBTVShow> = {
				page: response.page,
				results: (response.results as unknown as RawTVShowResult[]).map(normalizeTVShow),
				total_results: response.total_results,
				total_pages: response.total_pages,
			};

			setInCache(
				listCache as Map<string, CacheEntry<PaginatedResponse<TMDBTVShow>>>,
				cacheKey,
				result,
				LIST_CACHE_TTL_MS,
			);
			return result;
		},

		/**
		 * Get top rated TV shows
		 */
		topRated: async (page = 1): Promise<PaginatedResponse<TMDBTVShow>> => {
			const cacheKey = getCacheKey("top_rated_tv", page);
			const cached = getFromCache<PaginatedResponse<TMDBTVShow>>(
				listCache as Map<string, CacheEntry<PaginatedResponse<TMDBTVShow>>>,
				cacheKey,
			);
			if (cached) return cached;

			const response = await this.client.tvShows.topRated({ page });

			const result: PaginatedResponse<TMDBTVShow> = {
				page: response.page,
				results: (response.results as unknown as RawTVShowResult[]).map(normalizeTVShow),
				total_results: response.total_results,
				total_pages: response.total_pages,
			};

			setInCache(
				listCache as Map<string, CacheEntry<PaginatedResponse<TMDBTVShow>>>,
				cacheKey,
				result,
				LIST_CACHE_TTL_MS,
			);
			return result;
		},

		/**
		 * Get TV shows airing today
		 */
		airingToday: async (page = 1): Promise<PaginatedResponse<TMDBTVShow>> => {
			const cacheKey = getCacheKey("airing_today_tv", page);
			const cached = getFromCache<PaginatedResponse<TMDBTVShow>>(
				listCache as Map<string, CacheEntry<PaginatedResponse<TMDBTVShow>>>,
				cacheKey,
			);
			if (cached) return cached;

			const response = await this.client.tvShows.airingToday({ page });

			const result: PaginatedResponse<TMDBTVShow> = {
				page: response.page,
				results: (response.results as unknown as RawTVShowResult[]).map(normalizeTVShow),
				total_results: response.total_results,
				total_pages: response.total_pages,
			};

			setInCache(
				listCache as Map<string, CacheEntry<PaginatedResponse<TMDBTVShow>>>,
				cacheKey,
				result,
				LIST_CACHE_TTL_MS,
			);
			return result;
		},

		/**
		 * Get similar TV shows
		 */
		similar: async (
			tvId: number,
			page = 1,
		): Promise<PaginatedResponse<TMDBTVShow>> => {
			const cacheKey = getCacheKey("similar_tv", tvId, page);
			const cached = getFromCache<PaginatedResponse<TMDBTVShow>>(
				similarCache as Map<string, CacheEntry<PaginatedResponse<TMDBTVShow>>>,
				cacheKey,
			);
			if (cached) return cached;

			const response = await this.client.tvShows.similar(tvId, { page });

			const result: PaginatedResponse<TMDBTVShow> = {
				page: response.page,
				results: (response.results as unknown as RawTVShowResult[]).map(
					normalizeTVShow,
				),
				total_pages: response.total_pages,
				total_results: response.total_results,
			};

			setInCache(
				similarCache as Map<string, CacheEntry<PaginatedResponse<TMDBTVShow>>>,
				cacheKey,
				result,
				SIMILAR_CACHE_TTL_MS,
			);
			return result;
		},

		/**
		 * Get external IDs for a TV show (IMDB, TVDB, etc.)
		 */
		externalIds: async (tvId: number): Promise<ExternalIds> => {
			const cacheKey = getCacheKey("tv_external_ids", tvId);
			const cached = getFromCache(externalIdsCache, cacheKey);
			if (cached) return cached;

			const result = await this.client.tvShows.externalIds(tvId);

			setInCache(externalIdsCache, cacheKey, result, EXTERNAL_IDS_CACHE_TTL_MS);
			return result;
		},

		/**
		 * Get credits (cast and crew) for a TV show
		 * Returns simple credits - use aggregateCredits for role-aggregated data
		 */
		credits: async (tvId: number): Promise<Credits> => {
			const cacheKey = getCacheKey("tv_credits", tvId);
			const cached = getFromCache(creditsCache, cacheKey);
			if (cached) return cached as Credits;

			const result = await this.client.tvShows.credits(tvId);

			setInCache(creditsCache, cacheKey, result, CREDITS_CACHE_TTL_MS);
			return result;
		},

		/**
		 * Get aggregate credits for a TV show (roles/jobs grouped by person)
		 * Better for showing "Character (X episodes)" style credits
		 */
		aggregateCredits: async (tvId: number): Promise<AggregateCredits> => {
			const cacheKey = getCacheKey("tv_aggregate_credits", tvId);
			const cached = getFromCache(creditsCache, cacheKey);
			if (cached) return cached as AggregateCredits;

			const result = await this.client.tvShows.aggregateCredits(tvId);

			setInCache(creditsCache, cacheKey, result, CREDITS_CACHE_TTL_MS);
			return result;
		},

		/**
		 * Get videos (trailers, clips, etc.) for a TV show
		 */
		videos: async (tvId: number): Promise<Videos> => {
			const cacheKey = getCacheKey("tv_videos", tvId);
			const cached = getFromCache(videosCache, cacheKey);
			if (cached) return cached;

			const result = await this.client.tvShows.videos(tvId);

			setInCache(videosCache, cacheKey, result, VIDEOS_CACHE_TTL_MS);
			return result;
		},

		/**
		 * Get watch providers (streaming services) for a TV show
		 * Powered by JustWatch
		 */
		watchProviders: async (tvId: number): Promise<WatchProviders> => {
			const cacheKey = getCacheKey("tv_watch_providers", tvId);
			const cached = getFromCache(watchProvidersCache, cacheKey);
			if (cached) return cached;

			const result = await this.client.tvShows.watchProviders(tvId);

			setInCache(watchProvidersCache, cacheKey, result, WATCH_PROVIDERS_CACHE_TTL_MS);
			return result;
		},
	};

	// ==========================================================================
	// Search Endpoints
	// ==========================================================================

	readonly search = {
		/**
		 * Search for movies
		 */
		movies: async (options: {
			query: string;
			page?: number;
			year?: number;
		}): Promise<PaginatedResponse<TMDBMovie>> => {
			const cacheKey = getCacheKey(
				"search_movies",
				options.query,
				options.page ?? 1,
				options.year ?? 0,
			);
			const cached = getFromCache<PaginatedResponse<TMDBMovie>>(
				searchCache as Map<string, CacheEntry<PaginatedResponse<TMDBMovie>>>,
				cacheKey,
			);
			if (cached) return cached;

			const response = await this.client.search.movies({
				query: options.query,
				page: options.page,
				year: options.year,
			});

			const result: PaginatedResponse<TMDBMovie> = {
				page: response.page,
				results: response.results,
				total_pages: response.total_pages,
				total_results: response.total_results,
			};

			setInCache(
				searchCache as Map<string, CacheEntry<PaginatedResponse<TMDBMovie>>>,
				cacheKey,
				result,
				SEARCH_CACHE_TTL_MS,
			);
			return result;
		},

		/**
		 * Search for TV shows
		 */
		tv: async (options: {
			query: string;
			page?: number;
			year?: number;
		}): Promise<PaginatedResponse<TMDBTVShow>> => {
			const cacheKey = getCacheKey(
				"search_tv",
				options.query,
				options.page ?? 1,
				options.year ?? 0,
			);
			const cached = getFromCache<PaginatedResponse<TMDBTVShow>>(
				searchCache as Map<string, CacheEntry<PaginatedResponse<TMDBTVShow>>>,
				cacheKey,
			);
			if (cached) return cached;

			const response = await this.client.search.tvShows({
				query: options.query,
				page: options.page,
				first_air_date_year: options.year,
			});

			const result: PaginatedResponse<TMDBTVShow> = {
				page: response.page,
				results: (response.results as unknown as RawTVShowResult[]).map(
					normalizeTVShow,
				),
				total_pages: response.total_pages,
				total_results: response.total_results,
			};

			setInCache(
				searchCache as Map<string, CacheEntry<PaginatedResponse<TMDBTVShow>>>,
				cacheKey,
				result,
				SEARCH_CACHE_TTL_MS,
			);
			return result;
		},
	};

	// ==========================================================================
	// Genre Endpoints
	// ==========================================================================

	readonly genres = {
		/**
		 * Get all movie genres
		 */
		movies: async (): Promise<{ genres: TMDBGenre[] }> => {
			const cacheKey = getCacheKey("genres_movies");
			const cached = getFromCache(genreCache, cacheKey);
			if (cached) return cached;

			const result = await this.client.genres.movies();

			setInCache(genreCache, cacheKey, result, GENRE_CACHE_TTL_MS);
			return result;
		},

		/**
		 * Get all TV show genres
		 */
		tv: async (): Promise<{ genres: TMDBGenre[] }> => {
			const cacheKey = getCacheKey("genres_tv");
			const cached = getFromCache(genreCache, cacheKey);
			if (cached) return cached;

			const result = await this.client.genres.tvShows();

			setInCache(genreCache, cacheKey, result, GENRE_CACHE_TTL_MS);
			return result;
		},
	};

	// ==========================================================================
	// Batch External ID Fetching
	// ==========================================================================

	/**
	 * Fetch external IDs for multiple items in parallel
	 * Useful for enriching discovery results with IMDB/TVDB IDs
	 */
	async getExternalIdsForItems(
		items: Array<{ id: number }>,
		mediaType: "movie" | "tv",
	): Promise<Map<number, ExternalIds>> {
		const results = new Map<number, ExternalIds>();
		const fetcher =
			mediaType === "movie" ? this.movies.externalIds : this.tv.externalIds;

		const promises = items.map(async (item) => {
			try {
				const externalIds = await fetcher(item.id);
				results.set(item.id, externalIds);
			} catch {
				// If fetching external IDs fails for an item, continue without them
				results.set(item.id, {} as ExternalIds);
			}
		});

		await Promise.all(promises);
		return results;
	}
}
