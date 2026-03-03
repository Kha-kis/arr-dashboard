/**
 * Plex Series Progress Routes
 *
 * Aggregates PlexEpisodeCache watch data into per-series progress percentages.
 * Used for showing "15/24 (63%)" progress bars on library cards.
 */

import type { SeriesProgressResponse } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { validateRequest } from "../../lib/utils/validate.js";
import { aggregateSeriesProgress } from "./lib/series-progress-helpers.js";

const progressQuery = z.object({
	tmdbIds: z.string().min(1),
});

const MAX_BATCH_SIZE = 200;

export async function registerSeriesProgressRoutes(
	app: FastifyInstance,
	_opts: FastifyPluginOptions,
) {
	/**
	 * GET /api/plex/series-progress?tmdbIds=123,456
	 *
	 * Returns watched/total episode counts for each series TMDB ID.
	 */
	app.get("/", async (request, reply) => {
		const { tmdbIds: tmdbIdsRaw } = validateRequest(progressQuery, request.query);
		const tmdbIds = tmdbIdsRaw.split(",").map(Number).filter((id) => Number.isFinite(id) && id > 0);
		const userId = request.currentUser!.id;

		if (tmdbIds.length === 0) {
			const response: SeriesProgressResponse = { progress: {} };
			return reply.send(response);
		}

		if (tmdbIds.length > MAX_BATCH_SIZE) {
			return reply.status(400).send({ error: `Max ${MAX_BATCH_SIZE} items per request` });
		}

		// Get user's Plex instances
		const plexInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: "PLEX", enabled: true },
			select: { id: true },
		});

		if (plexInstances.length === 0) {
			const response: SeriesProgressResponse = { progress: {} };
			return reply.send(response);
		}

		const instanceIds = plexInstances.map((i) => i.id);

		// Fetch all episode cache entries for these shows
		const episodes = await app.prisma.plexEpisodeCache.findMany({
			where: {
				instanceId: { in: instanceIds },
				showTmdbId: { in: tmdbIds },
			},
			select: {
				showTmdbId: true,
				watched: true,
			},
		});

		// Aggregate per show using extracted pure helper
		const progressMap = aggregateSeriesProgress(episodes);

		const response: SeriesProgressResponse = { progress: progressMap };
		return reply.send(response);
	});
}
