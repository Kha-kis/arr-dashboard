/**
 * Plex Per-User Episode Completion Routes
 *
 * Returns per-user episode watched/total counts for specified shows.
 */

import type { UserEpisodeCompletion } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import {
	hasCompleteAuthoritativePlexEvidence,
	summarizePlexEvidence,
} from "../../lib/plex/plex-authority-service.js";
import { PlexAuthorityService } from "../../lib/plex/plex-authority-service.js";
import { validateRequest } from "../../lib/utils/validate.js";
import { aggregateUserEpisodeCompletion } from "./lib/user-episode-helpers.js";

const MAX_BATCH_SIZE = 200;

const episodeCompletionQuery = z.object({
	tmdbIds: z.string().transform((val) => [
		...new Set(
			val
				.split(",")
				.map((s) => Number(s.trim()))
				.filter((n) => Number.isSafeInteger(n) && n > 0),
		),
	]),
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

		const evidence = [];
		const authority = new PlexAuthorityService({
			prisma: app.prisma,
			encryptor: app.encryptor,
			log: request.log,
		});
		for (const instance of plexInstances) {
			evidence.push(
				await authority.readInstanceSelectedEpisodes({
					userId,
					instanceId: instance.id,
					showTmdbIds: tmdbIds,
				}),
			);
		}
		const summary = summarizePlexEvidence(evidence);
		if (!hasCompleteAuthoritativePlexEvidence(evidence)) {
			return reply
				.status(503)
				.send({ error: "Plex cache evidence is unavailable", evidence: summary });
		}
		const episodes = evidence.flatMap((entry) => (entry.available ? entry.rows : []));

		const { parseFailures, totalEpisodes, failedPreviews, ...completion } =
			aggregateUserEpisodeCompletion(episodes);
		if (parseFailures > 0) {
			request.log.warn(
				{ parseFailures, totalEpisodes, failedPreviews, route: "user-episode-completion" },
				"Episode cache JSON parse failures detected",
			);
		}
		return reply.send({ ...completion, evidence: summary });
	});
}
