import {
	type LibraryService,
	libraryEpisodeSearchRequestSchema,
	libraryMovieSearchRequestSchema,
	librarySeasonSearchRequestSchema,
	librarySeriesSearchRequestSchema,
} from "@arr/shared";
import type { ServiceInstance } from "@prisma/client";
import type { FastifyPluginCallback } from "fastify";
import { createInstanceFetcher } from "../../lib/arr/arr-fetcher.js";

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

		const instance = await app.prisma.serviceInstance.findFirst({
			where: {
				id: payload.instanceId,
				enabled: true,
				userId: request.currentUser?.id,
			},
		});

		if (!instance) {
			reply.status(404);
			return reply.send({ message: "Instance not found" });
		}

		const service = instance.service.toLowerCase() as LibraryService;
		if (service !== "sonarr") {
			reply.status(400);
			return reply.send({
				message: "Season search is only supported for Sonarr instances",
			});
		}

		const seriesId = Number(payload.seriesId);
		if (!Number.isFinite(seriesId)) {
			reply.status(400);
			return reply.send({ message: "Invalid series identifier" });
		}

		const seasonNumber = Number(payload.seasonNumber);
		if (!Number.isFinite(seasonNumber)) {
			reply.status(400);
			return reply.send({ message: "Invalid season number" });
		}

		const fetcher = createInstanceFetcher(app, instance as ServiceInstance);

		try {
			await fetcher("/api/v3/command", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "SeasonSearch",
					seriesId,
					seasonNumber,
				}),
			});

			reply.status(202);
			return reply.send({ message: "Season search queued" });
		} catch (error) {
			request.log.error(
				{ err: error, instance: instance.id, seriesId, seasonNumber },
				"failed to queue season search",
			);
			reply.status(502);
			return reply.send({ message: "Failed to queue season search" });
		}
	});

	/**
	 * POST /library/series/search
	 * Queues a series search in Sonarr
	 */
	app.post("/library/series/search", async (request, reply) => {
		const payload = librarySeriesSearchRequestSchema.parse(request.body ?? {});

		const instance = await app.prisma.serviceInstance.findFirst({
			where: {
				id: payload.instanceId,
				enabled: true,
				userId: request.currentUser?.id,
			},
		});

		if (!instance) {
			reply.status(404);
			return reply.send({ message: "Instance not found" });
		}

		const service = instance.service.toLowerCase() as LibraryService;
		if (service !== "sonarr") {
			reply.status(400);
			return reply.send({
				message: "Series search is only supported for Sonarr instances",
			});
		}

		const seriesId = Number(payload.seriesId);
		if (!Number.isFinite(seriesId)) {
			reply.status(400);
			return reply.send({ message: "Invalid series identifier" });
		}

		const fetcher = createInstanceFetcher(app, instance as ServiceInstance);

		try {
			await fetcher("/api/v3/command", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "SeriesSearch",
					seriesId,
				}),
			});

			reply.status(202);
			return reply.send({ message: "Series search queued" });
		} catch (error) {
			request.log.error(
				{ err: error, instance: instance.id, seriesId },
				"failed to queue series search",
			);
			reply.status(502);
			return reply.send({ message: "Failed to queue series search" });
		}
	});

	/**
	 * POST /library/movie/search
	 * Queues a movie search in Radarr
	 */
	app.post("/library/movie/search", async (request, reply) => {
		const payload = libraryMovieSearchRequestSchema.parse(request.body ?? {});

		const instance = await app.prisma.serviceInstance.findFirst({
			where: {
				id: payload.instanceId,
				enabled: true,
				userId: request.currentUser?.id,
			},
		});

		if (!instance) {
			reply.status(404);
			return reply.send({ message: "Instance not found" });
		}

		const service = instance.service.toLowerCase() as LibraryService;
		if (service !== "radarr") {
			reply.status(400);
			return reply.send({
				message: "Movie search is only supported for Radarr instances",
			});
		}

		const movieId = Number(payload.movieId);
		if (!Number.isFinite(movieId)) {
			reply.status(400);
			return reply.send({ message: "Invalid movie identifier" });
		}

		const fetcher = createInstanceFetcher(app, instance as ServiceInstance);

		try {
			await fetcher("/api/v3/command", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "MoviesSearch",
					movieIds: [movieId],
				}),
			});

			reply.status(202);
			return reply.send({ message: "Movie search queued" });
		} catch (error) {
			request.log.error(
				{ err: error, instance: instance.id, movieId },
				"failed to queue movie search",
			);
			reply.status(502);
			return reply.send({ message: "Failed to queue movie search" });
		}
	});

	/**
	 * POST /library/episode/search
	 * Queues an episode search in Sonarr
	 */
	app.post("/library/episode/search", async (request, reply) => {
		const payload = libraryEpisodeSearchRequestSchema.parse(request.body ?? {});

		const instance = await app.prisma.serviceInstance.findFirst({
			where: {
				id: payload.instanceId,
				enabled: true,
				userId: request.currentUser?.id,
			},
		});

		if (!instance) {
			reply.status(404);
			return reply.send({ message: "Instance not found" });
		}

		const service = instance.service.toLowerCase() as LibraryService;
		if (service !== "sonarr") {
			reply.status(400);
			return reply.send({
				message: "Episode search is only supported for Sonarr instances",
			});
		}

		if (!payload.episodeIds || payload.episodeIds.length === 0) {
			reply.status(400);
			return reply.send({ message: "No episode IDs provided" });
		}

		const fetcher = createInstanceFetcher(app, instance as ServiceInstance);

		try {
			await fetcher("/api/v3/command", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "EpisodeSearch",
					episodeIds: payload.episodeIds,
				}),
			});

			reply.status(202);
			return reply.send({ message: "Episode search queued" });
		} catch (error) {
			request.log.error(
				{ err: error, instance: instance.id, episodeIds: payload.episodeIds },
				"failed to queue episode search",
			);
			reply.status(502);
			return reply.send({ message: "Failed to queue episode search" });
		}
	});

	done();
};
