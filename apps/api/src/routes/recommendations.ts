import {
	type RecommendationItem,
	recommendationsRequestSchema,
	recommendationsResponseSchema,
} from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import { TMDBClient, type TMDBMovie, type TMDBTVShow } from "../lib/tmdb/index.js";

const recommendationsRoute: FastifyPluginCallback = (app, _opts, done) => {
	// Add authentication preHandler for all routes in this plugin
	app.addHook("preHandler", async (request, reply) => {
		if (!request.currentUser!.id) {
			return reply.status(401).send({
				success: false,
				error: "Authentication required",
			});
		}
	});

	app.get("/recommendations", async (request, reply) => {
		// Get user with TMDB API key
		const user = await app.prisma.user.findUnique({
			where: { id: request.currentUser!.id },
			select: { encryptedTmdbApiKey: true, tmdbEncryptionIv: true },
		});

		request.log.info(
			{
				userId: request.currentUser!.id,
				hasKey: !!user?.encryptedTmdbApiKey,
				hasIv: !!user?.tmdbEncryptionIv,
			},
			"TMDB key check",
		);

		if (!user?.encryptedTmdbApiKey || !user?.tmdbEncryptionIv) {
			reply.status(400);
			return reply.send({
				message: "TMDB API key not configured. Please add your TMDB API key in Settings.",
			});
		}

		// Decrypt the API key
		const tmdbApiKey = app.encryptor.decrypt({
			value: user.encryptedTmdbApiKey,
			iv: user.tmdbEncryptionIv,
		});

		const parsed = recommendationsRequestSchema.parse(request.query ?? {});

		// Create TMDB client instance
		const tmdb = new TMDBClient(tmdbApiKey, {
			imageBaseUrl: app.config.TMDB_IMAGE_BASE_URL,
		});

		try {
			if (parsed.mediaType === "movie") {
				// Fetch movies based on type
				let tmdbData: {
					results: TMDBMovie[];
					total_results: number;
					page: number;
					total_pages: number;
				};

				switch (parsed.type) {
					case "trending":
						tmdbData = await tmdb.trending.movies("week", parsed.page);
						break;
					case "popular":
						tmdbData = await tmdb.movies.popular(parsed.page);
						break;
					case "top_rated":
						tmdbData = await tmdb.movies.topRated(parsed.page);
						break;
					case "upcoming":
						tmdbData = await tmdb.movies.upcoming(parsed.page);
						break;
					default:
						tmdbData = await tmdb.trending.movies("week", parsed.page);
				}

				// Map results directly - external IDs fetched on-demand when adding to library
				const items: RecommendationItem[] = tmdbData.results.map((movie) => ({
					id: movie.id,
					tmdbId: movie.id,
					title: movie.title,
					overview: movie.overview,
					posterUrl: tmdb.getImageUrl(movie.poster_path) ?? undefined,
					backdropUrl: tmdb.getImageUrl(movie.backdrop_path, "original") ?? undefined,
					releaseDate: movie.release_date,
					rating: movie.vote_average,
					voteCount: movie.vote_count,
					popularity: movie.popularity,
				}));

				return recommendationsResponseSchema.parse({
					type: parsed.type,
					mediaType: parsed.mediaType,
					items,
					totalResults: tmdbData.total_results,
					page: tmdbData.page,
					totalPages: tmdbData.total_pages,
				});
			}

			// TV Shows
			let tmdbData: {
				results: TMDBTVShow[];
				total_results: number;
				page: number;
				total_pages: number;
			};

			switch (parsed.type) {
				case "trending":
					tmdbData = await tmdb.trending.tv("week", parsed.page);
					break;
				case "popular":
					tmdbData = await tmdb.tv.popular(parsed.page);
					break;
				case "top_rated":
					tmdbData = await tmdb.tv.topRated(parsed.page);
					break;
				case "airing_today":
					tmdbData = await tmdb.tv.airingToday(parsed.page);
					break;
				default:
					tmdbData = await tmdb.trending.tv("week", parsed.page);
			}

			// Map results directly - external IDs fetched on-demand when adding to library
			const items: RecommendationItem[] = tmdbData.results.map((show) => ({
				id: show.id,
				tmdbId: show.id,
				title: show.name,
				overview: show.overview,
				posterUrl: tmdb.getImageUrl(show.poster_path) ?? undefined,
				backdropUrl: tmdb.getImageUrl(show.backdrop_path, "original") ?? undefined,
				releaseDate: show.first_air_date,
				rating: show.vote_average,
				voteCount: show.vote_count,
				popularity: show.popularity,
			}));

			return recommendationsResponseSchema.parse({
				type: parsed.type,
				mediaType: parsed.mediaType,
				items,
				totalResults: tmdbData.total_results,
				page: tmdbData.page,
				totalPages: tmdbData.total_pages,
			});
		} catch (error) {
			request.log.error({ err: error }, "recommendations fetch failed");

			// Extract TMDB error message if available
			let tmdbError = "";
			if (error && typeof error === "object" && "status_message" in error) {
				tmdbError = String((error as { status_message: unknown }).status_message);
			}

			reply.status(502);
			return reply.send({
				message: tmdbError
					? `TMDB API error: ${tmdbError}`
					: "Failed to fetch recommendations from TMDB. Please check your API key.",
			});
		}
	});

	done();
};

export const registerRecommendationsRoutes = recommendationsRoute;
