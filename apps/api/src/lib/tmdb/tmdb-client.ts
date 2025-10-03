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

async function tmdbFetch<T>(endpoint: string, apiKey: string): Promise<T> {
  const url = `${TMDB_BASE_URL}${endpoint}${endpoint.includes('?') ? '&' : '?'}api_key=${apiKey}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`TMDB API error: ${response.statusText}`);
  }

  return response.json();
}

export async function getTrendingMovies(apiKey: string, timeWindow: 'day' | 'week' = 'week'): Promise<TMDBResponse<TMDBMovie>> {
  return tmdbFetch<TMDBResponse<TMDBMovie>>(`/trending/movie/${timeWindow}`, apiKey);
}

export async function getTrendingTV(apiKey: string, timeWindow: 'day' | 'week' = 'week'): Promise<TMDBResponse<TMDBTVShow>> {
  return tmdbFetch<TMDBResponse<TMDBTVShow>>(`/trending/tv/${timeWindow}`, apiKey);
}

export async function getPopularMovies(apiKey: string): Promise<TMDBResponse<TMDBMovie>> {
  return tmdbFetch<TMDBResponse<TMDBMovie>>('/movie/popular', apiKey);
}

export async function getPopularTV(apiKey: string): Promise<TMDBResponse<TMDBTVShow>> {
  return tmdbFetch<TMDBResponse<TMDBTVShow>>('/tv/popular', apiKey);
}

export async function getTopRatedMovies(apiKey: string): Promise<TMDBResponse<TMDBMovie>> {
  return tmdbFetch<TMDBResponse<TMDBMovie>>('/movie/top_rated', apiKey);
}

export async function getTopRatedTV(apiKey: string): Promise<TMDBResponse<TMDBTVShow>> {
  return tmdbFetch<TMDBResponse<TMDBTVShow>>('/tv/top_rated', apiKey);
}

export async function getUpcomingMovies(apiKey: string): Promise<TMDBResponse<TMDBMovie>> {
  return tmdbFetch<TMDBResponse<TMDBMovie>>('/movie/upcoming', apiKey);
}

export async function getAiringTodayTV(apiKey: string): Promise<TMDBResponse<TMDBTVShow>> {
  return tmdbFetch<TMDBResponse<TMDBTVShow>>('/tv/airing_today', apiKey);
}

export function getTMDBImageUrl(path: string | null, size: 'w500' | 'original' = 'w500'): string | null {
  if (!path) return null;
  return `https://image.tmdb.org/t/p/${size}${path}`;
}
