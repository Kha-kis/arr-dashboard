import {
	type LibraryService,
	libraryEpisodeSearchRequestSchema,
	libraryMovieSearchRequestSchema,
	librarySeasonSearchRequestSchema,
	librarySeriesSearchRequestSchema,
} from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import {
	getClientForInstance,
	isSonarrClient,
	isRadarrClient,
} from "../../lib/arr/client-helpers.js";
import { ArrError, arrErrorToHttpStatus } from "../../lib/arr/client-factory.js";

/**
 * Register search operation routes for library
 * - POST /library/season/search - Search for season
 * - POST /library/series/search - Search for series
 * - POST /library/movie/search - Search for movie
 * - POST /library/episode/search - Search for episodes
 */
export const registerSearchRoutes: FastifyPluginCallback = (app, _opts, done) => {
	// Add authentication preHandler for all routes in this plugin
	app.addHook("preHandler", async (request, reply) => {
		if (!request.currentUser?.id) {
			return reply.status(401).send({
				success: false,
				error: "Authentication required",
			});
		}
	});

	/**
	 * POST /library/season/search
	 * Queues a season search in Sonarr
	 */
	app.post("/library/season/search", async (request, reply) => {
		const payload = librarySeasonSearchRequestSchema.parse(request.body ?? {});

		const clientResult = await getClientForInstance(app, request, payload.instanceId);
		if (!clientResult.success) {
			return reply.status(clientResult.statusCode).send({
				message: clientResult.error,
			});
		}

		const { client, instance } = clientResult;
		const service = instance.service.toLowerCase() as LibraryService;

		if (service !== "sonarr" || !isSonarrClient(client)) {
			return reply.status(400).send({
				message: "Season search is only supported for Sonarr instances",
			});
		}

		const seriesId = Number(payload.seriesId);
		if (!Number.isFinite(seriesId)) {
			return reply.status(400).send({
				message: "Invalid series identifier",
			});
		}

		const seasonNumber = Number(payload.seasonNumber);
		if (!Number.isFinite(seasonNumber)) {
			return reply.status(400).send({
				message: "Invalid season number",
			});
		}

		try {
			await client.command.execute({
				name: "SeasonSearch",
				seriesId,
				seasonNumber,
			});

			return reply.status(202).send({
				message: "Season search queued",
			});
		} catch (error) {
			request.log.error(
				{ err: error, instance: instance.id, seriesId, seasonNumber },
				"failed to queue season search",
			);

			if (error instanceof ArrError) {
				return reply.status(arrErrorToHttpStatus(error)).send({
					message: error.message,
				});
			}

			return reply.status(502).send({
				message: "Failed to queue season search",
			});
		}
	});

	/**
	 * POST /library/series/search
	 * Queues a series search in Sonarr
	 */
	app.post("/library/series/search", async (request, reply) => {
		const payload = librarySeriesSearchRequestSchema.parse(request.body ?? {});

		const clientResult = await getClientForInstance(app, request, payload.instanceId);
		if (!clientResult.success) {
			return reply.status(clientResult.statusCode).send({
				message: clientResult.error,
			});
		}

		const { client, instance } = clientResult;
		const service = instance.service.toLowerCase() as LibraryService;

		if (service !== "sonarr" || !isSonarrClient(client)) {
			return reply.status(400).send({
				message: "Series search is only supported for Sonarr instances",
			});
		}

		const seriesId = Number(payload.seriesId);
		if (!Number.isFinite(seriesId)) {
			return reply.status(400).send({
				message: "Invalid series identifier",
			});
		}

		try {
			await client.command.execute({
				name: "SeriesSearch",
				seriesId,
			});

			return reply.status(202).send({
				message: "Series search queued",
			});
		} catch (error) {
			request.log.error(
				{ err: error, instance: instance.id, seriesId },
				"failed to queue series search",
			);

			if (error instanceof ArrError) {
				return reply.status(arrErrorToHttpStatus(error)).send({
					message: error.message,
				});
			}

			return reply.status(502).send({
				message: "Failed to queue series search",
			});
		}
	});

	/**
	 * POST /library/movie/search
	 * Queues a movie search in Radarr
	 */
	app.post("/library/movie/search", async (request, reply) => {
		const payload = libraryMovieSearchRequestSchema.parse(request.body ?? {});

		const clientResult = await getClientForInstance(app, request, payload.instanceId);
		if (!clientResult.success) {
			return reply.status(clientResult.statusCode).send({
				message: clientResult.error,
			});
		}

		const { client, instance } = clientResult;
		const service = instance.service.toLowerCase() as LibraryService;

		if (service !== "radarr" || !isRadarrClient(client)) {
			return reply.status(400).send({
				message: "Movie search is only supported for Radarr instances",
			});
		}

		const movieId = Number(payload.movieId);
		if (!Number.isFinite(movieId)) {
			return reply.status(400).send({
				message: "Invalid movie identifier",
			});
		}

		try {
			await client.command.execute({
				name: "MoviesSearch",
				movieIds: [movieId],
			});

			return reply.status(202).send({
				message: "Movie search queued",
			});
		} catch (error) {
			request.log.error(
				{ err: error, instance: instance.id, movieId },
				"failed to queue movie search",
			);

			if (error instanceof ArrError) {
				return reply.status(arrErrorToHttpStatus(error)).send({
					message: error.message,
				});
			}

			return reply.status(502).send({
				message: "Failed to queue movie search",
			});
		}
	});

	/**
	 * POST /library/episode/search
	 * Queues an episode search in Sonarr
	 */
	app.post("/library/episode/search", async (request, reply) => {
		const payload = libraryEpisodeSearchRequestSchema.parse(request.body ?? {});

		const clientResult = await getClientForInstance(app, request, payload.instanceId);
		if (!clientResult.success) {
			return reply.status(clientResult.statusCode).send({
				message: clientResult.error,
			});
		}

		const { client, instance } = clientResult;
		const service = instance.service.toLowerCase() as LibraryService;

		if (service !== "sonarr" || !isSonarrClient(client)) {
			return reply.status(400).send({
				message: "Episode search is only supported for Sonarr instances",
			});
		}

		if (!payload.episodeIds || payload.episodeIds.length === 0) {
			return reply.status(400).send({
				message: "No episode IDs provided",
			});
		}

		try {
			await client.command.execute({
				name: "EpisodeSearch",
				episodeIds: payload.episodeIds,
			});

			return reply.status(202).send({
				message: "Episode search queued",
			});
		} catch (error) {
			request.log.error(
				{ err: error, instance: instance.id, episodeIds: payload.episodeIds },
				"failed to queue episode search",
			);

			if (error instanceof ArrError) {
				return reply.status(arrErrorToHttpStatus(error)).send({
					message: error.message,
				});
			}

			return reply.status(502).send({
				message: "Failed to queue episode search",
			});
		}
	});

	done();
};
