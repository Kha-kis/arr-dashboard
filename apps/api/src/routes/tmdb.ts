/**
 * TMDB API Routes
 *
 * Provides endpoints for TMDB data that isn't part of the recommendations flow:
 * - Genres list
 * - Similar content
 * - Direct TMDB search
 */

import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { TMDBClient } from "../lib/tmdb/index.js";

// ============================================================================
// Request/Response Schemas
// ============================================================================

const genresRequestSchema = z.object({
	mediaType: z.enum(["movie", "tv"]),
});

const genresResponseSchema = z.object({
	genres: z.array(
		z.object({
			id: z.number(),
			name: z.string(),
		}),
	),
});

const similarRequestSchema = z.object({
	mediaType: z.enum(["movie", "tv"]),
	tmdbId: z.coerce.number().int().positive(),
	page: z.coerce.number().int().positive().default(1),
});

const tmdbSearchRequestSchema = z.object({
	mediaType: z.enum(["movie", "tv"]),
	query: z.string().min(1),
	page: z.coerce.number().int().positive().default(1),
	year: z.coerce.number().int().positive().optional(),
});

const searchResultSchema = z.object({
	id: z.number(),
	tmdbId: z.number(),
	title: z.string(),
	overview: z.string(),
	posterUrl: z.string().optional(),
	backdropUrl: z.string().optional(),
	releaseDate: z.string().optional(),
	rating: z.number(),
	voteCount: z.number(),
	popularity: z.number(),
	genreIds: z.array(z.number()),
});

const paginatedResponseSchema = z.object({
	results: z.array(searchResultSchema),
	page: z.number(),
	totalPages: z.number(),
	totalResults: z.number(),
});

// ============================================================================
// Helper to get TMDB client
// ============================================================================

async function getTMDBClient(
	app: Parameters<FastifyPluginCallback>[0],
	userId: string,
): Promise<{ client: TMDBClient } | { error: string }> {
	const user = await app.prisma.user.findUnique({
		where: { id: userId },
		select: { encryptedTmdbApiKey: true, tmdbEncryptionIv: true },
	});

	if (!user?.encryptedTmdbApiKey || !user?.tmdbEncryptionIv) {
		return { error: "TMDB API key not configured. Please add your TMDB API key in Settings." };
	}

	const tmdbApiKey = app.encryptor.decrypt({
		value: user.encryptedTmdbApiKey,
		iv: user.tmdbEncryptionIv,
	});

	return {
		client: new TMDBClient(tmdbApiKey, {
			imageBaseUrl: app.config.TMDB_IMAGE_BASE_URL,
		}),
	};
}

// ============================================================================
// Routes
// ============================================================================

const tmdbRoutes: FastifyPluginCallback = (app, _opts, done) => {
	// Add authentication preHandler for all routes
	app.addHook("preHandler", async (request, reply) => {
		if (!request.currentUser?.id) {
			return reply.status(401).send({
				success: false,
				error: "Authentication required",
			});
		}
	});

	/**
	 * GET /tmdb/genres
	 * Get all genres for movies or TV shows
	 */
	app.get("/tmdb/genres", async (request, reply) => {
		const parsed = genresRequestSchema.parse(request.query ?? {});

		const result = await getTMDBClient(app, request.currentUser!.id);
		if ("error" in result) {
			reply.status(400);
			return reply.send({ message: result.error });
		}

		try {
			const genres =
				parsed.mediaType === "movie"
					? await result.client.genres.movies()
					: await result.client.genres.tv();

			return genresResponseSchema.parse(genres);
		} catch (error) {
			request.log.error({ err: error }, "Failed to fetch genres from TMDB");
			reply.status(502);
			return reply.send({ message: "Failed to fetch genres from TMDB" });
		}
	});

	/**
	 * GET /tmdb/similar
	 * Get similar movies or TV shows
	 */
	app.get("/tmdb/similar", async (request, reply) => {
		const parsed = similarRequestSchema.parse(request.query ?? {});

		const result = await getTMDBClient(app, request.currentUser!.id);
		if ("error" in result) {
			reply.status(400);
			return reply.send({ message: result.error });
		}

		const tmdb = result.client;

		try {
			if (parsed.mediaType === "movie") {
				const data = await tmdb.movies.similar(parsed.tmdbId, parsed.page);

				// Fetch external IDs for IMDB linking
				const externalIdsMap = await tmdb.getExternalIdsForItems(data.results, "movie");

				const results = data.results.map((movie) => {
					const externalIds = externalIdsMap.get(movie.id);
					return {
						id: movie.id,
						tmdbId: movie.id,
						imdbId: externalIds?.imdb_id ?? undefined,
						title: movie.title,
						overview: movie.overview,
						posterUrl: tmdb.getImageUrl(movie.poster_path) ?? undefined,
						backdropUrl: tmdb.getImageUrl(movie.backdrop_path, "original") ?? undefined,
						releaseDate: movie.release_date,
						rating: movie.vote_average,
						voteCount: movie.vote_count,
						popularity: movie.popularity,
						genreIds: movie.genre_ids,
					};
				});

				return paginatedResponseSchema.parse({
					results,
					page: data.page,
					totalPages: data.total_pages,
					totalResults: data.total_results,
				});
			}

			// TV Shows
			const data = await tmdb.tv.similar(parsed.tmdbId, parsed.page);

			// Fetch external IDs for IMDB/TVDB linking
			const externalIdsMap = await tmdb.getExternalIdsForItems(data.results, "tv");

			const results = data.results.map((show) => {
				const externalIds = externalIdsMap.get(show.id);
				return {
					id: show.id,
					tmdbId: show.id,
					imdbId: externalIds?.imdb_id ?? undefined,
					tvdbId: externalIds?.tvdb_id ?? undefined,
					title: show.name,
					overview: show.overview,
					posterUrl: tmdb.getImageUrl(show.poster_path) ?? undefined,
					backdropUrl: tmdb.getImageUrl(show.backdrop_path, "original") ?? undefined,
					releaseDate: show.first_air_date,
					rating: show.vote_average,
					voteCount: show.vote_count,
					popularity: show.popularity,
					genreIds: show.genre_ids,
				};
			});

			return paginatedResponseSchema.parse({
				results,
				page: data.page,
				totalPages: data.total_pages,
				totalResults: data.total_results,
			});
		} catch (error) {
			request.log.error({ err: error }, "Failed to fetch similar content from TMDB");
			reply.status(502);
			return reply.send({ message: "Failed to fetch similar content from TMDB" });
		}
	});

	/**
	 * GET /tmdb/search
	 * Search for movies or TV shows directly on TMDB
	 */
	app.get("/tmdb/search", async (request, reply) => {
		const parsed = tmdbSearchRequestSchema.parse(request.query ?? {});

		const result = await getTMDBClient(app, request.currentUser!.id);
		if ("error" in result) {
			reply.status(400);
			return reply.send({ message: result.error });
		}

		const tmdb = result.client;

		try {
			if (parsed.mediaType === "movie") {
				const data = await tmdb.search.movies({
					query: parsed.query,
					page: parsed.page,
					year: parsed.year,
				});

				// Fetch external IDs for IMDB linking
				const externalIdsMap = await tmdb.getExternalIdsForItems(data.results, "movie");

				const results = data.results.map((movie) => {
					const externalIds = externalIdsMap.get(movie.id);
					return {
						id: movie.id,
						tmdbId: movie.id,
						imdbId: externalIds?.imdb_id ?? undefined,
						title: movie.title,
						overview: movie.overview,
						posterUrl: tmdb.getImageUrl(movie.poster_path) ?? undefined,
						backdropUrl: tmdb.getImageUrl(movie.backdrop_path, "original") ?? undefined,
						releaseDate: movie.release_date,
						rating: movie.vote_average,
						voteCount: movie.vote_count,
						popularity: movie.popularity,
						genreIds: movie.genre_ids,
					};
				});

				return paginatedResponseSchema.parse({
					results,
					page: data.page,
					totalPages: data.total_pages,
					totalResults: data.total_results,
				});
			}

			// TV Shows
			const data = await tmdb.search.tv({
				query: parsed.query,
				page: parsed.page,
				year: parsed.year,
			});

			// Fetch external IDs for IMDB/TVDB linking
			const externalIdsMap = await tmdb.getExternalIdsForItems(data.results, "tv");

			const results = data.results.map((show) => {
				const externalIds = externalIdsMap.get(show.id);
				return {
					id: show.id,
					tmdbId: show.id,
					imdbId: externalIds?.imdb_id ?? undefined,
					tvdbId: externalIds?.tvdb_id ?? undefined,
					title: show.name,
					overview: show.overview,
					posterUrl: tmdb.getImageUrl(show.poster_path) ?? undefined,
					backdropUrl: tmdb.getImageUrl(show.backdrop_path, "original") ?? undefined,
					releaseDate: show.first_air_date,
					rating: show.vote_average,
					voteCount: show.vote_count,
					popularity: show.popularity,
					genreIds: show.genre_ids,
				};
			});

			return paginatedResponseSchema.parse({
				results,
				page: data.page,
				totalPages: data.total_pages,
				totalResults: data.total_results,
			});
		} catch (error) {
			request.log.error({ err: error }, "Failed to search TMDB");
			reply.status(502);
			return reply.send({ message: "Failed to search TMDB" });
		}
	});

	/**
	 * GET /tmdb/credits
	 * Get cast and crew for a movie or TV show
	 */
	app.get("/tmdb/credits", async (request, reply) => {
		const parsed = z
			.object({
				mediaType: z.enum(["movie", "tv"]),
				tmdbId: z.coerce.number().int().positive(),
				aggregate: z.coerce.boolean().optional().default(false),
			})
			.parse(request.query ?? {});

		const result = await getTMDBClient(app, request.currentUser!.id);
		if ("error" in result) {
			reply.status(400);
			return reply.send({ message: result.error });
		}

		const tmdb = result.client;

		try {
			if (parsed.mediaType === "movie") {
				const credits = await tmdb.movies.credits(parsed.tmdbId);
				return {
					id: credits.id,
					cast: credits.cast.slice(0, 20).map((person) => ({
						id: person.id,
						name: person.name,
						character: person.character,
						profileUrl: tmdb.getImageUrl(person.profile_path, "w185") ?? undefined,
						order: person.order,
					})),
					crew: credits.crew
						.filter((person) => ["Director", "Writer", "Producer"].includes(person.job))
						.slice(0, 10)
						.map((person) => ({
							id: person.id,
							name: person.name,
							job: person.job,
							department: person.department,
							profileUrl: tmdb.getImageUrl(person.profile_path, "w185") ?? undefined,
						})),
				};
			}

			// TV Shows - can use aggregate credits for better episode count info
			if (parsed.aggregate) {
				const credits = await tmdb.tv.aggregateCredits(parsed.tmdbId);
				return {
					id: credits.id,
					cast: credits.cast.slice(0, 20).map((person) => ({
						id: person.id,
						name: person.name,
						characters: person.roles.map((r) => r.character),
						episodeCount: person.total_episode_count,
						profileUrl: tmdb.getImageUrl(person.profile_path, "w185") ?? undefined,
						order: person.order,
					})),
					crew: credits.crew
						.filter((person) =>
							person.jobs.some((j) =>
								["Director", "Writer", "Producer", "Creator"].includes(j.job),
							),
						)
						.slice(0, 10)
						.map((person) => ({
							id: person.id,
							name: person.name,
							jobs: person.jobs.map((j) => j.job),
							department: person.department,
							episodeCount: person.total_episode_count,
							profileUrl: tmdb.getImageUrl(person.profile_path, "w185") ?? undefined,
						})),
				};
			}

			const credits = await tmdb.tv.credits(parsed.tmdbId);
			return {
				id: credits.id,
				cast: credits.cast.slice(0, 20).map((person) => ({
					id: person.id,
					name: person.name,
					character: person.character,
					profileUrl: tmdb.getImageUrl(person.profile_path, "w185") ?? undefined,
					order: person.order,
				})),
				crew: credits.crew
					.filter((person) => ["Director", "Writer", "Producer", "Creator"].includes(person.job))
					.slice(0, 10)
					.map((person) => ({
						id: person.id,
						name: person.name,
						job: person.job,
						department: person.department,
						profileUrl: tmdb.getImageUrl(person.profile_path, "w185") ?? undefined,
					})),
			};
		} catch (error) {
			request.log.error({ err: error }, "Failed to fetch credits from TMDB");
			reply.status(502);
			return reply.send({ message: "Failed to fetch credits from TMDB" });
		}
	});

	/**
	 * GET /tmdb/external-ids
	 * Get external IDs (IMDB, TVDB, etc.) for a movie or TV show
	 * Used for on-demand fetching when users hover over recommendation cards
	 */
	app.get("/tmdb/external-ids", async (request, reply) => {
		const parsed = z
			.object({
				mediaType: z.enum(["movie", "tv"]),
				tmdbId: z.coerce.number().int().positive(),
			})
			.parse(request.query ?? {});

		const result = await getTMDBClient(app, request.currentUser!.id);
		if ("error" in result) {
			reply.status(400);
			return reply.send({ message: result.error });
		}

		const tmdb = result.client;

		try {
			const externalIds =
				parsed.mediaType === "movie"
					? await tmdb.movies.externalIds(parsed.tmdbId)
					: await tmdb.tv.externalIds(parsed.tmdbId);

			return {
				tmdbId: parsed.tmdbId,
				imdbId: externalIds.imdb_id ?? null,
				tvdbId: externalIds.tvdb_id ?? null,
			};
		} catch (error) {
			request.log.error({ err: error }, "Failed to fetch external IDs from TMDB");
			reply.status(502);
			return reply.send({ message: "Failed to fetch external IDs from TMDB" });
		}
	});

	/**
	 * GET /tmdb/videos
	 * Get videos (trailers, clips, etc.) for a movie or TV show
	 */
	app.get("/tmdb/videos", async (request, reply) => {
		const parsed = z
			.object({
				mediaType: z.enum(["movie", "tv"]),
				tmdbId: z.coerce.number().int().positive(),
			})
			.parse(request.query ?? {});

		const result = await getTMDBClient(app, request.currentUser!.id);
		if ("error" in result) {
			reply.status(400);
			return reply.send({ message: result.error });
		}

		const tmdb = result.client;

		try {
			const videos =
				parsed.mediaType === "movie"
					? await tmdb.movies.videos(parsed.tmdbId)
					: await tmdb.tv.videos(parsed.tmdbId);

			// Filter and sort: prioritize trailers, then teasers, then featurettes
			const typeOrder = ["Trailer", "Teaser", "Featurette", "Clip", "Behind the Scenes"];
			const sortedVideos = videos.results
				.filter((v) => v.site === "YouTube") // Only YouTube videos for easy embedding
				.sort((a, b) => {
					const aOrder = typeOrder.indexOf(a.type);
					const bOrder = typeOrder.indexOf(b.type);
					return (aOrder === -1 ? 999 : aOrder) - (bOrder === -1 ? 999 : bOrder);
				});

			return {
				id: videos.id,
				results: sortedVideos.slice(0, 10).map((video) => ({
					id: video.id,
					key: video.key,
					name: video.name,
					type: video.type,
					site: video.site,
					size: video.size,
					// Construct YouTube URLs for convenience
					url: `https://www.youtube.com/watch?v=${video.key}`,
					thumbnailUrl: `https://img.youtube.com/vi/${video.key}/hqdefault.jpg`,
				})),
			};
		} catch (error) {
			request.log.error({ err: error }, "Failed to fetch videos from TMDB");
			reply.status(502);
			return reply.send({ message: "Failed to fetch videos from TMDB" });
		}
	});

	/**
	 * GET /tmdb/watch-providers
	 * Get streaming/purchase providers for a movie or TV show
	 * Powered by JustWatch
	 */
	app.get("/tmdb/watch-providers", async (request, reply) => {
		const parsed = z
			.object({
				mediaType: z.enum(["movie", "tv"]),
				tmdbId: z.coerce.number().int().positive(),
				region: z.string().length(2).toUpperCase().optional().default("US"),
			})
			.parse(request.query ?? {});

		const result = await getTMDBClient(app, request.currentUser!.id);
		if ("error" in result) {
			reply.status(400);
			return reply.send({ message: result.error });
		}

		const tmdb = result.client;

		try {
			const providers =
				parsed.mediaType === "movie"
					? await tmdb.movies.watchProviders(parsed.tmdbId)
					: await tmdb.tv.watchProviders(parsed.tmdbId);

			// Get providers for the requested region
			const regionData = providers.results[parsed.region as keyof typeof providers.results];

			if (!regionData) {
				return {
					id: providers.id,
					region: parsed.region,
					link: null,
					flatrate: [],
					rent: [],
					buy: [],
				};
			}

			const mapProvider = (p: {
				provider_id: number;
				provider_name: string;
				logo_path: string;
			}) => ({
				id: p.provider_id,
				name: p.provider_name,
				logoUrl: tmdb.getImageUrl(p.logo_path, "w185") ?? undefined,
			});

			return {
				id: providers.id,
				region: parsed.region,
				link: regionData.link,
				flatrate: (regionData.flatrate ?? []).map(mapProvider),
				rent: (regionData.rent ?? []).map(mapProvider),
				buy: (regionData.buy ?? []).map(mapProvider),
			};
		} catch (error) {
			request.log.error({ err: error }, "Failed to fetch watch providers from TMDB");
			reply.status(502);
			return reply.send({ message: "Failed to fetch watch providers from TMDB" });
		}
	});

	done();
};

export const registerTMDBRoutes = tmdbRoutes;
