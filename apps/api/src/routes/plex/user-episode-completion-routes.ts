/**
 * Plex Per-User Episode Completion Routes
 *
 * Returns per-user episode watched/total counts for specified shows.
 */

import type { UserEpisodeCompletion } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { validateRequest } from "../../lib/utils/validate.js";
import { aggregateUserEpisodeCompletion } from "./lib/user-episode-helpers.js";

const MAX_BATCH_SIZE = 200;

const episodeCompletionQuery = z.object({
	tmdbIds: z.string().transform((val) =>
		val
			.split(",")
			.map((s) => Number.parseInt(s.trim(), 10))
			.filter((n) => Number.isFinite(n) && n > 0),
	),
});

export async function registerUserEpisodeCompletionRoutes(
	app: FastifyInstance,
	_opts: FastifyPluginOptions,
) {
	app.get("/", async (request, reply) => {
		const { tmdbIds } = validateRequest(episodeCompletionQuery, request.query);
		const userId = request.currentUser!.id;

		if (tmdbIds.length === 0) {
			const response: UserEpisodeCompletion = { shows: [] };
			return reply.send(response);
		}

		if (tmdbIds.length > MAX_BATCH_SIZE) {
			return reply.status(400).send({ error: `Max ${MAX_BATCH_SIZE} items per request` });
		}

		const plexInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: "PLEX", enabled: true },
			select: { id: true },
		});

		if (plexInstances.length === 0) {
			const response: UserEpisodeCompletion = { shows: [] };
			return reply.send(response);
		}

		const instanceIds = plexInstances.map((i) => i.id);

		const episodes = await app.prisma.plexEpisodeCache.findMany({
			where: {
				instanceId: { in: instanceIds },
				showTmdbId: { in: tmdbIds },
			},
			select: { showTmdbId: true, watched: true, watchedByUsers: true },
		});

		const { parseFailures, totalEpisodes, failedPreviews, ...completion } =
			aggregateUserEpisodeCompletion(episodes);
		if (parseFailures > 0) {
			request.log.warn(
				{ parseFailures, totalEpisodes, failedPreviews, route: "user-episode-completion" },
				"Episode cache JSON parse failures detected",
			);
		}
		return reply.send(completion);
	});
}
