import type { FastifyPluginCallback } from "fastify";
import {
  recommendationsRequestSchema,
  recommendationsResponseSchema,
  type RecommendationItem,
} from "@arr/shared";
import {
  getTrendingMovies,
  getTrendingTV,
  getPopularMovies,
  getPopularTV,
  getTopRatedMovies,
  getTopRatedTV,
  getUpcomingMovies,
  getAiringTodayTV,
  getTMDBImageUrl,
  type TMDBMovie,
  type TMDBTVShow,
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

    request.log.info({
      userId: request.currentUser.id,
      hasKey: !!user?.encryptedTmdbApiKey,
      hasIv: !!user?.tmdbEncryptionIv
    }, "TMDB key check");

    if (!user?.encryptedTmdbApiKey || !user?.tmdbEncryptionIv) {
      reply.status(400);
      return reply.send({ message: "TMDB API key not configured. Please add your TMDB API key in Settings." });
    }

    // Decrypt the API key
    const tmdbApiKey = app.encryptor.decrypt({
      value: user.encryptedTmdbApiKey,
      iv: user.tmdbEncryptionIv,
    });

    const parsed = recommendationsRequestSchema.parse(request.query ?? {});

    try {
      let tmdbData;

      if (parsed.mediaType === "movie") {
        switch (parsed.type) {
          case "trending":
            tmdbData = await getTrendingMovies(tmdbApiKey);
            break;
          case "popular":
            tmdbData = await getPopularMovies(tmdbApiKey);
            break;
          case "top_rated":
            tmdbData = await getTopRatedMovies(tmdbApiKey);
            break;
          case "upcoming":
            tmdbData = await getUpcomingMovies(tmdbApiKey);
            break;
          default:
            tmdbData = await getTrendingMovies(tmdbApiKey);
        }

        const items: RecommendationItem[] = (tmdbData.results as TMDBMovie[]).map((movie) => ({
          id: movie.id,
          tmdbId: movie.id,
          title: movie.title,
          overview: movie.overview,
          posterUrl: getTMDBImageUrl(movie.poster_path) || undefined,
          backdropUrl: getTMDBImageUrl(movie.backdrop_path, 'original') || undefined,
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
        });
      } else {
        // TV Shows
        switch (parsed.type) {
          case "trending":
            tmdbData = await getTrendingTV(tmdbApiKey);
            break;
          case "popular":
            tmdbData = await getPopularTV(tmdbApiKey);
            break;
          case "top_rated":
            tmdbData = await getTopRatedTV(tmdbApiKey);
            break;
          case "airing_today":
            tmdbData = await getAiringTodayTV(tmdbApiKey);
            break;
          default:
            tmdbData = await getTrendingTV(tmdbApiKey);
        }

        const items: RecommendationItem[] = (tmdbData.results as TMDBTVShow[]).map((show) => ({
          id: show.id,
          tmdbId: show.id,
          title: show.name,
          overview: show.overview,
          posterUrl: getTMDBImageUrl(show.poster_path) || undefined,
          backdropUrl: getTMDBImageUrl(show.backdrop_path, 'original') || undefined,
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
        });
      }
    } catch (error) {
      request.log.error({ err: error }, "recommendations fetch failed");
      reply.status(502);
      return reply.send({ message: "Failed to fetch recommendations from TMDB" });
    }
  });

  done();
};

export const registerRecommendationsRoutes = recommendationsRoute;
