const TMDB_BASE_URL = "https://api.themoviedb.org/3";

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
  page = 1,
): Promise<T> {
  const url = `${TMDB_BASE_URL}${endpoint}${endpoint.includes("?") ? "&" : "?"}api_key=${apiKey}&page=${page}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`TMDB API error: ${response.statusText}`);
  }

  return response.json();
}

async function fetchMultiplePages<T extends { results: unknown[] }>(
  endpoint: string,
  apiKey: string,
  pages = 3,
): Promise<T> {
  const requests = Array.from({ length: pages }, (_, i) =>
    tmdbFetch<T>(endpoint, apiKey, i + 1),
  );

  const responses = await Promise.all(requests);

  // Combine all results
  const combinedResults = responses.flatMap((r) => r.results);

  // Return first response with combined results
  return {
    ...responses[0],
    results: combinedResults,
    total_results: responses[0].total_results,
    total_pages: responses[0].total_pages,
  } as T;
}

async function fetchSinglePage<T>(
  endpoint: string,
  apiKey: string,
  page: number,
): Promise<T> {
  return tmdbFetch<T>(endpoint, apiKey, page);
}

export async function getTrendingMovies(
  apiKey: string,
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
        startPage + i,
      ),
    ),
  );

  const allMovies = responses.flatMap((r) => r.results);

  return {
    ...responses[0],
    page,
    results: allMovies,
    total_results: responses[0].total_results,
    total_pages: Math.ceil(responses[0].total_pages / pagesToFetch),
  };
}

export async function getTrendingTV(
  apiKey: string,
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
        startPage + i,
      ),
    ),
  );

  const allShows = responses.flatMap((r) => r.results);

  return {
    ...responses[0],
    page,
    results: allShows,
    total_results: responses[0].total_results,
    total_pages: Math.ceil(responses[0].total_pages / pagesToFetch),
  };
}

export async function getPopularMovies(
  apiKey: string,
  page = 1,
): Promise<TMDBResponse<TMDBMovie>> {
  // Fetch 3 pages at once to account for library filtering
  const pagesToFetch = 3;
  const startPage = (page - 1) * pagesToFetch + 1;

  const responses = await Promise.all(
    Array.from({ length: pagesToFetch }, (_, i) =>
      fetchSinglePage<TMDBResponse<TMDBMovie>>(
        "/movie/popular",
        apiKey,
        startPage + i,
      ),
    ),
  );

  const allMovies = responses.flatMap((r) => r.results);

  return {
    ...responses[0],
    page,
    results: allMovies,
    total_results: responses[0].total_results,
    total_pages: Math.ceil(responses[0].total_pages / pagesToFetch),
  };
}

export async function getPopularTV(
  apiKey: string,
  page = 1,
): Promise<TMDBResponse<TMDBTVShow>> {
  // Fetch 3 pages at once to account for library filtering
  const pagesToFetch = 3;
  const startPage = (page - 1) * pagesToFetch + 1;

  const responses = await Promise.all(
    Array.from({ length: pagesToFetch }, (_, i) =>
      fetchSinglePage<TMDBResponse<TMDBTVShow>>(
        "/tv/popular",
        apiKey,
        startPage + i,
      ),
    ),
  );

  const allShows = responses.flatMap((r) => r.results);

  return {
    ...responses[0],
    page,
    results: allShows,
    total_results: responses[0].total_results,
    total_pages: Math.ceil(responses[0].total_pages / pagesToFetch),
  };
}

export async function getTopRatedMovies(
  apiKey: string,
  page = 1,
): Promise<TMDBResponse<TMDBMovie>> {
  // Fetch 3 pages at once to account for library filtering
  const pagesToFetch = 3;
  const startPage = (page - 1) * pagesToFetch + 1;

  const responses = await Promise.all(
    Array.from({ length: pagesToFetch }, (_, i) =>
      fetchSinglePage<TMDBResponse<TMDBMovie>>(
        "/movie/top_rated",
        apiKey,
        startPage + i,
      ),
    ),
  );

  const allMovies = responses.flatMap((r) => r.results);

  return {
    ...responses[0],
    page,
    results: allMovies,
    total_results: responses[0].total_results,
    total_pages: Math.ceil(responses[0].total_pages / pagesToFetch),
  };
}

export async function getTopRatedTV(
  apiKey: string,
  page = 1,
): Promise<TMDBResponse<TMDBTVShow>> {
  // Fetch 3 pages at once to account for library filtering
  const pagesToFetch = 3;
  const startPage = (page - 1) * pagesToFetch + 1;

  const responses = await Promise.all(
    Array.from({ length: pagesToFetch }, (_, i) =>
      fetchSinglePage<TMDBResponse<TMDBTVShow>>(
        "/tv/top_rated",
        apiKey,
        startPage + i,
      ),
    ),
  );

  const allShows = responses.flatMap((r) => r.results);

  return {
    ...responses[0],
    page,
    results: allShows,
    total_results: responses[0].total_results,
    total_pages: Math.ceil(responses[0].total_pages / pagesToFetch),
  };
}

export async function getUpcomingMovies(
  apiKey: string,
  page = 1,
): Promise<TMDBResponse<TMDBMovie>> {
  // Fetch 5 pages at once to account for date filtering
  const pagesToFetch = 5;
  const startPage = (page - 1) * pagesToFetch + 1;

  const responses = await Promise.all(
    Array.from({ length: pagesToFetch }, (_, i) =>
      fetchSinglePage<TMDBResponse<TMDBMovie>>(
        "/movie/upcoming",
        apiKey,
        startPage + i,
      ),
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

  return {
    ...responses[0],
    page,
    results: futureMovies,
    total_results: responses[0].total_results,
    total_pages: Math.ceil(responses[0].total_pages / pagesToFetch),
  };
}

export async function getAiringTodayTV(
  apiKey: string,
  page = 1,
): Promise<TMDBResponse<TMDBTVShow>> {
  // Fetch 3 pages at once to account for library filtering
  const pagesToFetch = 3;
  const startPage = (page - 1) * pagesToFetch + 1;

  const responses = await Promise.all(
    Array.from({ length: pagesToFetch }, (_, i) =>
      fetchSinglePage<TMDBResponse<TMDBTVShow>>(
        "/tv/airing_today",
        apiKey,
        startPage + i,
      ),
    ),
  );

  const allShows = responses.flatMap((r) => r.results);

  return {
    ...responses[0],
    page,
    results: allShows,
    total_results: responses[0].total_results,
    total_pages: Math.ceil(responses[0].total_pages / pagesToFetch),
  };
}

export function getTMDBImageUrl(
  path: string | null,
  size: "w500" | "original" = "w500",
): string | null {
  if (!path) return null;
  return `https://image.tmdb.org/t/p/${size}${path}`;
}
