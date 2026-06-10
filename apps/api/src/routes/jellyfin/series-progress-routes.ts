/**
 * Jellyfin Series Progress Routes
 *
 * Aggregates JellyfinEpisodeCache watch data into per-series progress percentages.
 * Reuses the same helper as Plex since the data shape is identical.
 */

import type { SeriesProgressResponse } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { validateRequest } from "../../lib/utils/validate.js";
import { aggregateSeriesProgress } from "../../lib/media-stats/series-progress-helpers.js";

const progressQuery = z.object({
	tmdbIds: z.string().min(1),
});

const MAX_BATCH_SIZE = 200;

export async function registerSeriesProgressRoutes(
	app: FastifyInstance,
	_opts: FastifyPluginOptions,
) {
	app.get("/", async (request, reply) => {
		const { tmdbIds: tmdbIdsRaw } = validateRequest(progressQuery, request.query);
		const tmdbIds = tmdbIdsRaw
			.split(",")
			.map(Number)
			.filter((id) => Number.isFinite(id) && id > 0);
		const userId = request.currentUser!.id;

		if (tmdbIds.length === 0) {
			const response: SeriesProgressResponse = { progress: {} };
			return reply.send(response);
		}

		if (tmdbIds.length > MAX_BATCH_SIZE) {
			return reply.status(400).send({ error: `Max ${MAX_BATCH_SIZE} items per request` });
		}

		const jellyfinInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: { in: ["JELLYFIN", "EMBY"] }, enabled: true },
			select: { id: true },
		});

		if (jellyfinInstances.length === 0) {
			const response: SeriesProgressResponse = { progress: {} };
			return reply.send(response);
		}

		const instanceIds = jellyfinInstances.map((i) => i.id);

		const episodes = await app.prisma.jellyfinEpisodeCache.findMany({
			where: {
				instanceId: { in: instanceIds },
				showTmdbId: { in: tmdbIds },
			},
			select: {
				showTmdbId: true,
				watched: true,
			},
		});

		const progressMap = aggregateSeriesProgress(episodes);

		const response: SeriesProgressResponse = { progress: progressMap };
		return reply.send(response);
	});
}
