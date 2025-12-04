import {
	type LibraryService,
	libraryEpisodeMonitorRequestSchema,
	libraryToggleMonitorRequestSchema,
} from "@arr/shared";
import type { ServiceInstance } from "@prisma/client";
import type { FastifyPluginCallback } from "fastify";
import { createInstanceFetcher } from "../../lib/arr/arr-fetcher.js";
import { toNumber } from "../../lib/library/type-converters.js";

/**
 * Register monitoring control routes for library
 * - POST /library/monitor - Toggle monitoring for movies/series/seasons
 * - POST /library/episode/monitor - Toggle monitoring for episodes
 */
export const registerMonitorRoutes: FastifyPluginCallback = (app, _opts, done) => {
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
	 * POST /library/monitor
	 * Toggles monitoring status for movies, series, or specific seasons
	 */
	app.post("/library/monitor", async (request, reply) => {
		const payload = libraryToggleMonitorRequestSchema.parse(request.body ?? {});

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
		if (service !== payload.service) {
			reply.status(400);
			return reply.send({ message: "Instance service mismatch" });
		}

		const fetcher = createInstanceFetcher(app, instance as ServiceInstance);
		const itemId = encodeURIComponent(String(payload.itemId));

		try {
			if (service === "radarr") {
				const response = await fetcher(`/api/v3/movie/${itemId}`);
				const movie = await response.json();
				movie.monitored = payload.monitored;
				await fetcher(`/api/v3/movie/${itemId}`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(movie),
				});
				reply.status(204);
				return reply.send();
			}

			const response = await fetcher(`/api/v3/series/${itemId}`);
			const series = await response.json();
			series.monitored = payload.monitored;
			if (Array.isArray(series.seasons)) {
				const seasonNumbers = payload.seasonNumbers
					?.map((number) => Number(number))
					.filter((value) => Number.isFinite(value));
				series.seasons = series.seasons.map((season: unknown) => {
					const seasonObj = season as Record<string, unknown>;
					const seasonNumber = toNumber(seasonObj?.seasonNumber) ?? 0;
					const hasSelections = Array.isArray(seasonNumbers) && seasonNumbers.length > 0;

					let nextMonitored = !!seasonObj?.monitored;

					if (hasSelections) {
						if (seasonNumbers?.includes(seasonNumber)) {
							nextMonitored = payload.monitored;
						}
					} else {
						nextMonitored = seasonNumber === 0 ? false : payload.monitored;
					}

					return {
						...seasonObj,
						monitored: nextMonitored,
					};
				});
			}
			await fetcher(`/api/v3/series/${itemId}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(series),
			});
			reply.status(204);
			return reply.send();
		} catch (error) {
			request.log.error(
				{ err: error, instance: instance.id, itemId: payload.itemId },
				"failed to update monitoring",
			);
			reply.status(502);
			return reply.send({ message: "Failed to update monitoring" });
		}
	});

	/**
	 * POST /library/episode/monitor
	 * Toggles monitoring status for specific episodes
	 */
	app.post("/library/episode/monitor", async (request, reply) => {
		const payload = libraryEpisodeMonitorRequestSchema.parse(request.body ?? {});

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
				message: "Episode monitoring is only supported for Sonarr instances",
			});
		}

		const seriesId = Number(payload.seriesId);
		if (!Number.isFinite(seriesId)) {
			reply.status(400);
			return reply.send({ message: "Invalid series identifier" });
		}

		if (!payload.episodeIds || payload.episodeIds.length === 0) {
			reply.status(400);
			return reply.send({ message: "No episode IDs provided" });
		}

		const fetcher = createInstanceFetcher(app, instance as ServiceInstance);

		try {
			// Fetch all episodes for the series
			const params = new URLSearchParams({ seriesId: seriesId.toString() });
			const response = await fetcher(`/api/v3/episode?${params.toString()}`);
			const allEpisodes = await response.json();

			if (!Array.isArray(allEpisodes)) {
				throw new Error("Invalid response from Sonarr");
			}

			// Update the monitored status for the specified episodes
			const updates = allEpisodes
				.filter((ep: unknown) => payload.episodeIds.includes(toNumber((ep as Record<string, unknown>)?.id) ?? -1))
				.map((ep: unknown) => {
					const epObj = ep as Record<string, unknown>;
					return {
						...epObj,
						monitored: payload.monitored,
					};
				});

			// Send bulk update to Sonarr
			await fetcher("/api/v3/episode/monitor", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					episodeIds: payload.episodeIds,
					monitored: payload.monitored,
				}),
			});

			reply.status(204);
			return reply.send();
		} catch (error) {
			request.log.error(
				{ err: error, instance: instance.id, episodeIds: payload.episodeIds },
				"failed to update episode monitoring",
			);
			reply.status(502);
			return reply.send({ message: "Failed to update episode monitoring" });
		}
	});

	done();
};
