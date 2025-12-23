/**
 * TMDB Client Module
 *
 * Type-safe, cached wrapper around tmdb-ts for accessing The Movie Database API.
 * Provides in-memory caching to reduce API calls and improve performance.
 *
 * @example
 * ```typescript
 * const client = new TMDBClient(apiKey, { imageBaseUrl: config.TMDB_IMAGE_BASE_URL });
 *
 * // Discovery
 * const trending = await client.trending.movies();
 * const popular = await client.movies.popular();
 *
 * // Search
 * const results = await client.search.movies({ query: "Inception" });
 *
 * // Similar content
 * const similar = await client.movies.similar(550);
 *
 * // External IDs for ARR integration
 * const externalIds = await client.movies.externalIds(550);
 * ```
 */

export {
	TMDBClient,
	type TMDBClientOptions,
	type TMDBMovie,
	type TMDBTVShow,
	type TMDBGenre,
	type PaginatedResponse,
} from "./tmdb-client.js";

// Re-export types from tmdb-ts for convenience
export type {
	ExternalIds,
	Credits,
	Videos,
	WatchProviders,
	AggregateCredits,
	Cast,
	Crew,
	Video,
} from "tmdb-ts";
