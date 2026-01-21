import {
	type LibraryService,
	libraryEpisodeMonitorRequestSchema,
	libraryToggleMonitorRequestSchema,
} from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import {
	getClientForInstance,
	isSonarrClient,
	isRadarrClient,
} from "../../lib/arr/client-helpers.js";
import { ArrError, arrErrorToHttpStatus } from "../../lib/arr/client-factory.js";
import { toNumber } from "../../lib/library/type-converters.js";

/**
 * Optimistically update the library cache after a monitoring change
 * Updates both the indexed `monitored` field and the JSON `data` blob
 */
async function updateCacheMonitoredStatus(
	prisma: import("../../lib/prisma.js").PrismaClientInstance,
	instanceId: string,
	arrItemId: number,
	itemType: "movie" | "series",
	monitored: boolean,
): Promise<void> {
	try {
		const cached = await prisma.libraryCache.findUnique({
			where: {
				instanceId_arrItemId_itemType: {
					instanceId,
					arrItemId,
					itemType,
				},
			},
		});

		if (cached) {
			// Parse existing data, update monitored, re-serialize
			const data = JSON.parse(cached.data);
			data.monitored = monitored;

			await prisma.libraryCache.update({
				where: { id: cached.id },
				data: {
					monitored,
					data: JSON.stringify(data),
					updatedAt: new Date(),
				},
			});
		}
	} catch {
		// Cache update is best-effort - don't fail the request if it fails
		// The next sync will correct any inconsistencies
	}
}

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

		const clientResult = await getClientForInstance(app, request, payload.instanceId);
		if (!clientResult.success) {
			return reply.status(clientResult.statusCode).send({
				message: clientResult.error,
			});
		}

		const { client, instance } = clientResult;
		const service = instance.service.toLowerCase() as LibraryService;

		if (service !== payload.service) {
			return reply.status(400).send({
				message: "Instance service mismatch",
			});
		}

		const itemId = Number(payload.itemId);
		if (!Number.isFinite(itemId)) {
			return reply.status(400).send({
				message: "Invalid item identifier",
			});
		}

		try {
			if (service === "radarr" && isRadarrClient(client)) {
				// Fetch current movie, update monitored, then save
				const movie = await client.movie.getById(itemId);
				const updatedMovie = {
					...movie,
					id: itemId,
					monitored: payload.monitored,
				};
				await client.movie.update(itemId, updatedMovie);

				// Optimistically update cache
				await updateCacheMonitoredStatus(
					app.prisma,
					payload.instanceId,
					itemId,
					"movie",
					payload.monitored,
				);

				return reply.status(204).send();
			}

			if (service === "sonarr" && isSonarrClient(client)) {
				// Fetch current series
				const series = await client.series.getById(itemId);

				// Update series monitored status
				const updatedSeries = {
					...series,
					id: itemId,
					monitored: payload.monitored,
				};

				// Update season monitoring if seasons exist
				if (Array.isArray(series.seasons)) {
					const seasonNumbers = payload.seasonNumbers
						?.map((number) => Number(number))
						.filter((value) => Number.isFinite(value));

					updatedSeries.seasons = series.seasons.map((season: Record<string, unknown>) => {
						const seasonObj = season;
						const seasonNumber = toNumber(seasonObj?.seasonNumber) ?? 0;
						const hasSelections = Array.isArray(seasonNumbers) && seasonNumbers.length > 0;

						let nextMonitored = !!seasonObj?.monitored;

						if (hasSelections) {
							if (seasonNumbers?.includes(seasonNumber)) {
								nextMonitored = payload.monitored;
							}
						} else {
							// Don't monitor specials (season 0) by default
							nextMonitored = seasonNumber === 0 ? false : payload.monitored;
						}

						return {
							...seasonObj,
							monitored: nextMonitored,
						};
					});
				}

				await client.series.update(
					itemId,
					updatedSeries as Parameters<typeof client.series.update>[1],
				);

				// Optimistically update cache
				await updateCacheMonitoredStatus(
					app.prisma,
					payload.instanceId,
					itemId,
					"series",
					payload.monitored,
				);

				return reply.status(204).send();
			}

			return reply.status(400).send({
				message: "Unsupported service type",
			});
		} catch (error) {
			request.log.error(
				{ err: error, instance: instance.id, itemId: payload.itemId },
				"failed to update monitoring",
			);

			if (error instanceof ArrError) {
				return reply.status(arrErrorToHttpStatus(error)).send({
					message: error.message,
				});
			}

			return reply.status(502).send({
				message: "Failed to update monitoring",
			});
		}
	});

	/**
	 * POST /library/episode/monitor
	 * Toggles monitoring status for specific episodes
	 */
	app.post("/library/episode/monitor", async (request, reply) => {
		const payload = libraryEpisodeMonitorRequestSchema.parse(request.body ?? {});

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
				message: "Episode monitoring is only supported for Sonarr instances",
			});
		}

		const seriesId = Number(payload.seriesId);
		if (!Number.isFinite(seriesId)) {
			return reply.status(400).send({
				message: "Invalid series identifier",
			});
		}

		if (!payload.episodeIds || payload.episodeIds.length === 0) {
			return reply.status(400).send({
				message: "No episode IDs provided",
			});
		}

		try {
			// Use SDK's episode.setMonitored method for bulk monitoring updates
			await client.episode.setMonitored(payload.episodeIds, payload.monitored);

			return reply.status(204).send();
		} catch (error) {
			request.log.error(
				{ err: error, instance: instance.id, episodeIds: payload.episodeIds },
				"failed to update episode monitoring",
			);

			if (error instanceof ArrError) {
				return reply.status(arrErrorToHttpStatus(error)).send({
					message: error.message,
				});
			}

			return reply.status(502).send({
				message: "Failed to update episode monitoring",
			});
		}
	});

	done();
};
