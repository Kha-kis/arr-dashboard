import {
	type RecommendationItem,
	recommendationsRequestSchema,
	recommendationsResponseSchema,
} from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import {
	type TMDBClientConfig,
	type TMDBMovie,
	type TMDBTVShow,
	getAiringTodayTV,
	getPopularMovies,
	getPopularTV,
	getTMDBImageUrl,
	getTopRatedMovies,
	getTopRatedTV,
	getTrendingMovies,
	getTrendingTV,
	getUpcomingMovies,
} from "../lib/tmdb/tmdb-client.js";

const recommendationsRoute: FastifyPluginCallback = (app, _opts, done) => {
	app.get("/recommendations", async (request, reply) => {
		if (!request.currentUser) {
			reply.status(401);
			return reply.send({ message: "Unauthorized" });
		}

		// Get user with TMDB API key
		const user = await app.prisma.user.findUnique({
			where: { id: request.currentUser.id },
			select: { encryptedTmdbApiKey: true, tmdbEncryptionIv: true },
		});

		request.log.info(
			{
				userId: request.currentUser.id,
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

		const tmdbConfig: TMDBClientConfig = {
			baseUrl: app.config.TMDB_BASE_URL,
			imageBaseUrl: app.config.TMDB_IMAGE_BASE_URL,
		};

		try {
			let tmdbData: TMDBResponse<TMDBMovie> | TMDBResponse<TMDBTVShow> | undefined;

			if (parsed.mediaType === "movie") {
				switch (parsed.type) {
					case "trending":
						tmdbData = await getTrendingMovies(tmdbApiKey, tmdbConfig, "week", parsed.page);
						break;
					case "popular":
						tmdbData = await getPopularMovies(tmdbApiKey, tmdbConfig, parsed.page);
						break;
					case "top_rated":
						tmdbData = await getTopRatedMovies(tmdbApiKey, tmdbConfig, parsed.page);
						break;
					case "upcoming":
						tmdbData = await getUpcomingMovies(tmdbApiKey, tmdbConfig, parsed.page);
						break;
					default:
						tmdbData = await getTrendingMovies(tmdbApiKey, tmdbConfig, "week", parsed.page);
				}

				const items: RecommendationItem[] = (tmdbData.results as TMDBMovie[]).map((movie) => ({
					id: movie.id,
					tmdbId: movie.id,
					title: movie.title,
					overview: movie.overview,
					posterUrl: getTMDBImageUrl(movie.poster_path, tmdbConfig) || undefined,
					backdropUrl: getTMDBImageUrl(movie.backdrop_path, tmdbConfig, "original") || undefined,
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
			switch (parsed.type) {
				case "trending":
					tmdbData = await getTrendingTV(tmdbApiKey, tmdbConfig, "week", parsed.page);
					break;
				case "popular":
					tmdbData = await getPopularTV(tmdbApiKey, tmdbConfig, parsed.page);
					break;
				case "top_rated":
					tmdbData = await getTopRatedTV(tmdbApiKey, tmdbConfig, parsed.page);
					break;
				case "airing_today":
					tmdbData = await getAiringTodayTV(tmdbApiKey, tmdbConfig, parsed.page);
					break;
				default:
					tmdbData = await getTrendingTV(tmdbApiKey, tmdbConfig, "week", parsed.page);
			}

			const items: RecommendationItem[] = (tmdbData.results as TMDBTVShow[]).map((show) => ({
				id: show.id,
				tmdbId: show.id,
				title: show.name,
				overview: show.overview,
				posterUrl: getTMDBImageUrl(show.poster_path, tmdbConfig) || undefined,
				backdropUrl: getTMDBImageUrl(show.backdrop_path, tmdbConfig, "original") || undefined,
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
			reply.status(502);
			return reply.send({
				message: "Failed to fetch recommendations from TMDB",
			});
		}
	});

	done();
};

export const registerRecommendationsRoutes = recommendationsRoute;
