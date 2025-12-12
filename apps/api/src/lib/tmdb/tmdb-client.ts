export interface TMDBClientConfig {
	baseUrl: string;
	imageBaseUrl: string;
}

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
	// Fetch 3 pages at once to account for library filtering
	const pagesToFetch = 3;
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
	return {
		...data,
		page,
		results: allMovies,
		total_results: data?.total_results ?? 0,
		total_pages: Math.ceil((data?.total_pages ?? 0) / pagesToFetch),
	};
}

export async function getTrendingTV(
	apiKey: string,
	config: TMDBClientConfig,
	timeWindow: "day" | "week" = "week",
	page = 1,
): Promise<TMDBResponse<TMDBTVShow>> {
	// Fetch 3 pages at once to account for library filtering
	const pagesToFetch = 3;
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
	return {
		...data,
		page,
		results: allShows,
		total_results: data?.total_results ?? 0,
		total_pages: Math.ceil((data?.total_pages ?? 0) / pagesToFetch),
	};
}

export async function getPopularMovies(
	apiKey: string,
	config: TMDBClientConfig,
	page = 1,
): Promise<TMDBResponse<TMDBMovie>> {
	// Fetch 3 pages at once to account for library filtering
	const pagesToFetch = 3;
	const startPage = (page - 1) * pagesToFetch + 1;

	const responses = await Promise.all(
		Array.from({ length: pagesToFetch }, (_, i) =>
			fetchSinglePage<TMDBResponse<TMDBMovie>>("/movie/popular", apiKey, config, startPage + i),
		),
	);

	const allMovies = responses.flatMap((r) => r.results);

	const data = responses[0];
	return {
		...data,
		page,
		results: allMovies,
		total_results: data?.total_results ?? 0,
		total_pages: Math.ceil((data?.total_pages ?? 0) / pagesToFetch),
	};
}

export async function getPopularTV(
	apiKey: string,
	config: TMDBClientConfig,
	page = 1,
): Promise<TMDBResponse<TMDBTVShow>> {
	// Fetch 3 pages at once to account for library filtering
	const pagesToFetch = 3;
	const startPage = (page - 1) * pagesToFetch + 1;

	const responses = await Promise.all(
		Array.from({ length: pagesToFetch }, (_, i) =>
			fetchSinglePage<TMDBResponse<TMDBTVShow>>("/tv/popular", apiKey, config, startPage + i),
		),
	);

	const allShows = responses.flatMap((r) => r.results);

	const data = responses[0];
	return {
		...data,
		page,
		results: allShows,
		total_results: data?.total_results ?? 0,
		total_pages: Math.ceil((data?.total_pages ?? 0) / pagesToFetch),
	};
}

export async function getTopRatedMovies(
	apiKey: string,
	config: TMDBClientConfig,
	page = 1,
): Promise<TMDBResponse<TMDBMovie>> {
	// Fetch 3 pages at once to account for library filtering
	const pagesToFetch = 3;
	const startPage = (page - 1) * pagesToFetch + 1;

	const responses = await Promise.all(
		Array.from({ length: pagesToFetch }, (_, i) =>
			fetchSinglePage<TMDBResponse<TMDBMovie>>("/movie/top_rated", apiKey, config, startPage + i),
		),
	);

	const allMovies = responses.flatMap((r) => r.results);

	const data = responses[0];
	return {
		...data,
		page,
		results: allMovies,
		total_results: data?.total_results ?? 0,
		total_pages: Math.ceil((data?.total_pages ?? 0) / pagesToFetch),
	};
}

export async function getTopRatedTV(
	apiKey: string,
	config: TMDBClientConfig,
	page = 1,
): Promise<TMDBResponse<TMDBTVShow>> {
	// Fetch 3 pages at once to account for library filtering
	const pagesToFetch = 3;
	const startPage = (page - 1) * pagesToFetch + 1;

	const responses = await Promise.all(
		Array.from({ length: pagesToFetch }, (_, i) =>
			fetchSinglePage<TMDBResponse<TMDBTVShow>>("/tv/top_rated", apiKey, config, startPage + i),
		),
	);

	const allShows = responses.flatMap((r) => r.results);

	const data = responses[0];
	return {
		...data,
		page,
		results: allShows,
		total_results: data?.total_results ?? 0,
		total_pages: Math.ceil((data?.total_pages ?? 0) / pagesToFetch),
	};
}

export async function getUpcomingMovies(
	apiKey: string,
	config: TMDBClientConfig,
	page = 1,
): Promise<TMDBResponse<TMDBMovie>> {
	// Fetch 5 pages at once to account for date filtering
	const pagesToFetch = 5;
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
	return {
		...data,
		page,
		results: futureMovies,
		total_results: data?.total_results ?? 0,
		total_pages: Math.ceil((data?.total_pages ?? 0) / pagesToFetch),
	};
}

export async function getAiringTodayTV(
	apiKey: string,
	config: TMDBClientConfig,
	page = 1,
): Promise<TMDBResponse<TMDBTVShow>> {
	// Fetch 3 pages at once to account for library filtering
	const pagesToFetch = 3;
	const startPage = (page - 1) * pagesToFetch + 1;

	const responses = await Promise.all(
		Array.from({ length: pagesToFetch }, (_, i) =>
			fetchSinglePage<TMDBResponse<TMDBTVShow>>("/tv/airing_today", apiKey, config, startPage + i),
		),
	);

	const allShows = responses.flatMap((r) => r.results);

	const data = responses[0];
	return {
		...data,
		page,
		results: allShows,
		total_results: data?.total_results ?? 0,
		total_pages: Math.ceil((data?.total_pages ?? 0) / pagesToFetch),
	};
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
 */
export async function getExternalIds(
	apiKey: string,
	config: TMDBClientConfig,
	tmdbId: number,
	mediaType: "movie" | "tv",
): Promise<TMDBExternalIds> {
	const url = `${config.baseUrl}/${mediaType}/${tmdbId}/external_ids?api_key=${apiKey}`;
	const response = await fetch(url);

	if (!response.ok) {
		return {};
	}

	return response.json();
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
