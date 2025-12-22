/**
 * TMDB API Client
 *
 * Provides methods for interacting with The Movie Database (TMDB) API.
 * Includes in-memory caching for frequently accessed data.
 */

/**
 * Configuration for the TMDB client
 */
export interface TMDBClientConfig {
	/** Base URL for TMDB API requests */
	baseUrl: string;
	/** Base URL for TMDB image assets */
	imageBaseUrl: string;
}

// ============================================================================
// In-Memory Cache Implementation
// ============================================================================

interface CacheEntry<T> {
	data: T;
	timestamp: number;
	ttl: number;
}

// Cache for list responses (trending, popular, etc.) - 10 minute TTL
const listCache = new Map<string, CacheEntry<unknown>>();
const LIST_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Cache for external IDs - 24 hour TTL (these rarely change)
const externalIdsCache = new Map<string, CacheEntry<TMDBExternalIds>>();
const EXTERNAL_IDS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Generate a cache key from type and arguments
 * @param type - Cache type identifier (e.g., 'trending', 'popular')
 * @param args - Additional key components
 */
function getCacheKey(type: string, ...args: (string | number)[]): string {
	return `${type}:${args.join(":")}`;
}

/**
 * Retrieve data from cache if not expired
 * @param cache - The cache map to read from
 * @param key - Cache key to look up
 * @returns Cached data or null if not found/expired
 */
function getFromCache<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
	const entry = cache.get(key);
	if (!entry) return null;

	const now = Date.now();
	if (now - entry.timestamp > entry.ttl) {
		cache.delete(key);
		return null;
	}

	return entry.data;
}

/**
 * Store data in cache with TTL
 * @param cache - The cache map to write to
 * @param key - Cache key for storage
 * @param data - Data to cache
 * @param ttl - Time-to-live in milliseconds
 */
function setInCache<T>(cache: Map<string, CacheEntry<T>>, key: string, data: T, ttl: number): void {
	cache.set(key, { data, timestamp: Date.now(), ttl });
}

// Periodic cache cleanup to prevent memory leaks (runs every 5 minutes)
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Remove expired entries from a cache map
 * @param cache - The cache map to clean up
 */
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

/**
 * Initialize periodic cache cleanup to prevent memory leaks
 * Runs every 5 minutes to remove expired entries
 */
function startCacheCleanup(): void {
	if (cleanupInterval) return;

	cleanupInterval = setInterval(
		() => {
			cleanupCache(listCache as Map<string, CacheEntry<unknown>>);
			cleanupCache(externalIdsCache);
		},
		5 * 60 * 1000,
	); // Every 5 minutes
}

// Start cleanup on module load
startCacheCleanup();

export interface TMDBMovie {
	id: number;
	title: string;
	original_title: string;
	overview: string;
	poster_path: string | null;
	backdrop_path: string | null;
	release_date: string;
	genre_ids: number[];
	vote_average: number;
	vote_count: number;
	popularity: number;
}

export interface TMDBTVShow {
	id: number;
	name: string;
	original_name: string;
	overview: string;
	poster_path: string | null;
	backdrop_path: string | null;
	first_air_date: string;
	genre_ids: number[];
	vote_average: number;
	vote_count: number;
	popularity: number;
}

export interface TMDBResponse<T> {
	page: number;
	results: T[];
	total_pages: number;
	total_results: number;
}

async function tmdbFetch<T>(
	endpoint: string,
	apiKey: string,
	config: TMDBClientConfig,
	page = 1,
): Promise<T> {
	const url = `${config.baseUrl}${endpoint}${endpoint.includes("?") ? "&" : "?"}api_key=${apiKey}&page=${page}`;
	const response = await fetch(url);

	if (!response.ok) {
		throw new Error(`TMDB API error: ${response.statusText}`);
	}

	return response.json();
}

async function fetchSinglePage<T>(
	endpoint: string,
	apiKey: string,
	config: TMDBClientConfig,
	page: number,
): Promise<T> {
	return tmdbFetch<T>(endpoint, apiKey, config, page);
}

export async function getTrendingMovies(
	apiKey: string,
	config: TMDBClientConfig,
	timeWindow: "day" | "week" = "week",
	page = 1,
): Promise<TMDBResponse<TMDBMovie>> {
	// Check cache first
	const cacheKey = getCacheKey("trending_movies", timeWindow, page);
	const cached = getFromCache<TMDBResponse<TMDBMovie>>(
		listCache as Map<string, CacheEntry<TMDBResponse<TMDBMovie>>>,
		cacheKey,
	);
	if (cached) return cached;

	// Fetch 2 pages at once (reduced from 3 to minimize API calls)
	const pagesToFetch = 2;
	const startPage = (page - 1) * pagesToFetch + 1;

	const responses = await Promise.all(
		Array.from({ length: pagesToFetch }, (_, i) =>
			fetchSinglePage<TMDBResponse<TMDBMovie>>(
				`/trending/movie/${timeWindow}`,
				apiKey,
				config,
				startPage + i,
			),
		),
	);

	const allMovies = responses.flatMap((r) => r.results);

	const data = responses[0];
	const result: TMDBResponse<TMDBMovie> = {
		...data,
		page,
		results: allMovies,
		total_results: data?.total_results ?? 0,
		total_pages: Math.ceil((data?.total_pages ?? 0) / pagesToFetch),
	};

	// Cache the result
	setInCache(
		listCache as Map<string, CacheEntry<TMDBResponse<TMDBMovie>>>,
		cacheKey,
		result,
		LIST_CACHE_TTL_MS,
	);
	return result;
}

export async function getTrendingTV(
	apiKey: string,
	config: TMDBClientConfig,
	timeWindow: "day" | "week" = "week",
	page = 1,
): Promise<TMDBResponse<TMDBTVShow>> {
	// Check cache first
	const cacheKey = getCacheKey("trending_tv", timeWindow, page);
	const cached = getFromCache<TMDBResponse<TMDBTVShow>>(
		listCache as Map<string, CacheEntry<TMDBResponse<TMDBTVShow>>>,
		cacheKey,
	);
	if (cached) return cached;

	// Fetch 2 pages at once (reduced from 3 to minimize API calls)
	const pagesToFetch = 2;
	const startPage = (page - 1) * pagesToFetch + 1;

	const responses = await Promise.all(
		Array.from({ length: pagesToFetch }, (_, i) =>
			fetchSinglePage<TMDBResponse<TMDBTVShow>>(
				`/trending/tv/${timeWindow}`,
				apiKey,
				config,
				startPage + i,
			),
		),
	);

	const allShows = responses.flatMap((r) => r.results);

	const data = responses[0];
	const result: TMDBResponse<TMDBTVShow> = {
		...data,
		page,
		results: allShows,
		total_results: data?.total_results ?? 0,
		total_pages: Math.ceil((data?.total_pages ?? 0) / pagesToFetch),
	};

	// Cache the result
	setInCache(
		listCache as Map<string, CacheEntry<TMDBResponse<TMDBTVShow>>>,
		cacheKey,
		result,
		LIST_CACHE_TTL_MS,
	);
	return result;
}

export async function getPopularMovies(
	apiKey: string,
	config: TMDBClientConfig,
	page = 1,
): Promise<TMDBResponse<TMDBMovie>> {
	// Check cache first
	const cacheKey = getCacheKey("popular_movies", page);
	const cached = getFromCache<TMDBResponse<TMDBMovie>>(
		listCache as Map<string, CacheEntry<TMDBResponse<TMDBMovie>>>,
		cacheKey,
	);
	if (cached) return cached;

	// Fetch 2 pages at once (reduced from 3 to minimize API calls)
	const pagesToFetch = 2;
	const startPage = (page - 1) * pagesToFetch + 1;

	const responses = await Promise.all(
		Array.from({ length: pagesToFetch }, (_, i) =>
			fetchSinglePage<TMDBResponse<TMDBMovie>>("/movie/popular", apiKey, config, startPage + i),
		),
	);

	const allMovies = responses.flatMap((r) => r.results);

	const data = responses[0];
	const result: TMDBResponse<TMDBMovie> = {
		...data,
		page,
		results: allMovies,
		total_results: data?.total_results ?? 0,
		total_pages: Math.ceil((data?.total_pages ?? 0) / pagesToFetch),
	};

	// Cache the result
	setInCache(
		listCache as Map<string, CacheEntry<TMDBResponse<TMDBMovie>>>,
		cacheKey,
		result,
		LIST_CACHE_TTL_MS,
	);
	return result;
}

export async function getPopularTV(
	apiKey: string,
	config: TMDBClientConfig,
	page = 1,
): Promise<TMDBResponse<TMDBTVShow>> {
	// Check cache first
	const cacheKey = getCacheKey("popular_tv", page);
	const cached = getFromCache<TMDBResponse<TMDBTVShow>>(
		listCache as Map<string, CacheEntry<TMDBResponse<TMDBTVShow>>>,
		cacheKey,
	);
	if (cached) return cached;

	// Fetch 2 pages at once (reduced from 3 to minimize API calls)
	const pagesToFetch = 2;
	const startPage = (page - 1) * pagesToFetch + 1;

	const responses = await Promise.all(
		Array.from({ length: pagesToFetch }, (_, i) =>
			fetchSinglePage<TMDBResponse<TMDBTVShow>>("/tv/popular", apiKey, config, startPage + i),
		),
	);

	const allShows = responses.flatMap((r) => r.results);

	const data = responses[0];
	const result: TMDBResponse<TMDBTVShow> = {
		...data,
		page,
		results: allShows,
		total_results: data?.total_results ?? 0,
		total_pages: Math.ceil((data?.total_pages ?? 0) / pagesToFetch),
	};

	// Cache the result
	setInCache(
		listCache as Map<string, CacheEntry<TMDBResponse<TMDBTVShow>>>,
		cacheKey,
		result,
		LIST_CACHE_TTL_MS,
	);
	return result;
}

export async function getTopRatedMovies(
	apiKey: string,
	config: TMDBClientConfig,
	page = 1,
): Promise<TMDBResponse<TMDBMovie>> {
	// Check cache first
	const cacheKey = getCacheKey("top_rated_movies", page);
	const cached = getFromCache<TMDBResponse<TMDBMovie>>(
		listCache as Map<string, CacheEntry<TMDBResponse<TMDBMovie>>>,
		cacheKey,
	);
	if (cached) return cached;

	// Fetch 2 pages at once (reduced from 3 to minimize API calls)
	const pagesToFetch = 2;
	const startPage = (page - 1) * pagesToFetch + 1;

	const responses = await Promise.all(
		Array.from({ length: pagesToFetch }, (_, i) =>
			fetchSinglePage<TMDBResponse<TMDBMovie>>("/movie/top_rated", apiKey, config, startPage + i),
		),
	);

	const allMovies = responses.flatMap((r) => r.results);

	const data = responses[0];
	const result: TMDBResponse<TMDBMovie> = {
		...data,
		page,
		results: allMovies,
		total_results: data?.total_results ?? 0,
		total_pages: Math.ceil((data?.total_pages ?? 0) / pagesToFetch),
	};

	// Cache the result
	setInCache(
		listCache as Map<string, CacheEntry<TMDBResponse<TMDBMovie>>>,
		cacheKey,
		result,
		LIST_CACHE_TTL_MS,
	);
	return result;
}

export async function getTopRatedTV(
	apiKey: string,
	config: TMDBClientConfig,
	page = 1,
): Promise<TMDBResponse<TMDBTVShow>> {
	// Check cache first
	const cacheKey = getCacheKey("top_rated_tv", page);
	const cached = getFromCache<TMDBResponse<TMDBTVShow>>(
		listCache as Map<string, CacheEntry<TMDBResponse<TMDBTVShow>>>,
		cacheKey,
	);
	if (cached) return cached;

	// Fetch 2 pages at once (reduced from 3 to minimize API calls)
	const pagesToFetch = 2;
	const startPage = (page - 1) * pagesToFetch + 1;

	const responses = await Promise.all(
		Array.from({ length: pagesToFetch }, (_, i) =>
			fetchSinglePage<TMDBResponse<TMDBTVShow>>("/tv/top_rated", apiKey, config, startPage + i),
		),
	);

	const allShows = responses.flatMap((r) => r.results);

	const data = responses[0];
	const result: TMDBResponse<TMDBTVShow> = {
		...data,
		page,
		results: allShows,
		total_results: data?.total_results ?? 0,
		total_pages: Math.ceil((data?.total_pages ?? 0) / pagesToFetch),
	};

	// Cache the result
	setInCache(
		listCache as Map<string, CacheEntry<TMDBResponse<TMDBTVShow>>>,
		cacheKey,
		result,
		LIST_CACHE_TTL_MS,
	);
	return result;
}

export async function getUpcomingMovies(
	apiKey: string,
	config: TMDBClientConfig,
	page = 1,
): Promise<TMDBResponse<TMDBMovie>> {
	// Check cache first
	const cacheKey = getCacheKey("upcoming_movies", page);
	const cached = getFromCache<TMDBResponse<TMDBMovie>>(
		listCache as Map<string, CacheEntry<TMDBResponse<TMDBMovie>>>,
		cacheKey,
	);
	if (cached) return cached;

	// Fetch 3 pages at once (reduced from 5, but needs more for date filtering)
	const pagesToFetch = 3;
	const startPage = (page - 1) * pagesToFetch + 1;

	const responses = await Promise.all(
		Array.from({ length: pagesToFetch }, (_, i) =>
			fetchSinglePage<TMDBResponse<TMDBMovie>>("/movie/upcoming", apiKey, config, startPage + i),
		),
	);

	// Filter to only include movies with future release dates
	const today = new Date();
	today.setHours(0, 0, 0, 0); // Start of today

	const allMovies = responses.flatMap((r) => r.results);
	const futureMovies = allMovies.filter((movie) => {
		if (!movie.release_date) return false;
		const releaseDate = new Date(movie.release_date);
		return releaseDate >= today;
	});

	const data = responses[0];
	const result: TMDBResponse<TMDBMovie> = {
		...data,
		page,
		results: futureMovies,
		total_results: data?.total_results ?? 0,
		total_pages: Math.ceil((data?.total_pages ?? 0) / pagesToFetch),
	};

	// Cache the result
	setInCache(
		listCache as Map<string, CacheEntry<TMDBResponse<TMDBMovie>>>,
		cacheKey,
		result,
		LIST_CACHE_TTL_MS,
	);
	return result;
}

export async function getAiringTodayTV(
	apiKey: string,
	config: TMDBClientConfig,
	page = 1,
): Promise<TMDBResponse<TMDBTVShow>> {
	// Check cache first
	const cacheKey = getCacheKey("airing_today_tv", page);
	const cached = getFromCache<TMDBResponse<TMDBTVShow>>(
		listCache as Map<string, CacheEntry<TMDBResponse<TMDBTVShow>>>,
		cacheKey,
	);
	if (cached) return cached;

	// Fetch 2 pages at once (reduced from 3 to minimize API calls)
	const pagesToFetch = 2;
	const startPage = (page - 1) * pagesToFetch + 1;

	const responses = await Promise.all(
		Array.from({ length: pagesToFetch }, (_, i) =>
			fetchSinglePage<TMDBResponse<TMDBTVShow>>("/tv/airing_today", apiKey, config, startPage + i),
		),
	);

	const allShows = responses.flatMap((r) => r.results);

	const data = responses[0];
	const result: TMDBResponse<TMDBTVShow> = {
		...data,
		page,
		results: allShows,
		total_results: data?.total_results ?? 0,
		total_pages: Math.ceil((data?.total_pages ?? 0) / pagesToFetch),
	};

	// Cache the result
	setInCache(
		listCache as Map<string, CacheEntry<TMDBResponse<TMDBTVShow>>>,
		cacheKey,
		result,
		LIST_CACHE_TTL_MS,
	);
	return result;
}

export function getTMDBImageUrl(
	path: string | null,
	config: TMDBClientConfig,
	size: "w500" | "original" = "w500",
): string | null {
	if (!path) return null;
	return `${config.imageBaseUrl}/${size}${path}`;
}

export interface TMDBExternalIds {
	imdb_id?: string | null;
	tvdb_id?: number | null;
	facebook_id?: string | null;
	instagram_id?: string | null;
	twitter_id?: string | null;
}

/**
 * Fetches external IDs (IMDB, TVDB, etc.) for a movie or TV show
 * Results are cached for 24 hours since external IDs rarely change
 */
export async function getExternalIds(
	apiKey: string,
	config: TMDBClientConfig,
	tmdbId: number,
	mediaType: "movie" | "tv",
): Promise<TMDBExternalIds> {
	// Check cache first - external IDs rarely change so use long TTL
	const cacheKey = getCacheKey("external_ids", mediaType, tmdbId);
	const cached = getFromCache(externalIdsCache, cacheKey);
	if (cached) return cached;

	const url = `${config.baseUrl}/${mediaType}/${tmdbId}/external_ids?api_key=${apiKey}`;
	const response = await fetch(url);

	if (!response.ok) {
		return {};
	}

	const result = await response.json();

	// Cache the result with 24 hour TTL
	setInCache(externalIdsCache, cacheKey, result, EXTERNAL_IDS_CACHE_TTL_MS);
	return result;
}

/**
 * Fetches external IDs for multiple items in parallel with error handling
 */
export async function getExternalIdsForItems(
	apiKey: string,
	config: TMDBClientConfig,
	items: Array<{ id: number }>,
	mediaType: "movie" | "tv",
): Promise<Map<number, TMDBExternalIds>> {
	const results = new Map<number, TMDBExternalIds>();

	const promises = items.map(async (item) => {
		try {
			const externalIds = await getExternalIds(apiKey, config, item.id, mediaType);
			results.set(item.id, externalIds);
		} catch {
			// If fetching external IDs fails for an item, continue without them
			results.set(item.id, {});
		}
	});

	await Promise.all(promises);
	return results;
}
