/**
 * Plex Collection/Label Statistics Routes
 *
 * Aggregates collection and label item counts with watched percentages from PlexCache.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import {
	hasAuthoritativePlexEvidence,
	summarizePlexEvidence,
} from "../../lib/plex/plex-authority-service.js";
import { PlexAuthorityService } from "../../lib/plex/plex-authority-service.js";
import { createCollectionStatsAccumulator } from "./lib/collection-stats-helpers.js";

export async function registerCollectionStatsRoutes(
	app: FastifyInstance,
	_opts: FastifyPluginOptions,
) {
	app.get("/", async (request, reply) => {
		const userId = request.currentUser!.id;

		const accumulator = createCollectionStatsAccumulator();
		const evidence = await new PlexAuthorityService({
			prisma: app.prisma,
			encryptor: app.encryptor,
			log: request.log,
		}).scanUserPolicy({
			userId,
			domains: ["membership", "collections"],
			onBatch: ({ rows }) => accumulator.add(rows),
		});
		const summary = summarizePlexEvidence(evidence);
		if (!hasAuthoritativePlexEvidence(evidence)) {
			return reply
				.status(503)
				.send({ error: "Plex cache evidence is unavailable", evidence: summary });
		}
		const { parseFailures, totalEntries, failedPreviews, ...stats } = accumulator.finish();
		if (parseFailures > 0) {
			request.log.warn(
				{ parseFailures, totalEntries, failedPreviews, route: "collection-stats" },
				"PlexCache JSON parse failures detected",
			);
		}
		return reply.send({ ...stats, evidence: summary });
	});
}
