/**
 * Plex Collection/Label Statistics Routes
 *
 * Aggregates collection and label item counts with watched percentages from PlexCache.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import {
	hasAuthoritativePlexEvidence,
	listObservedRows,
	loadUserEvidence,
	summarizePlexEvidence,
} from "../../lib/plex/plex-evidence-repository.js";
import { aggregateCollectionStats } from "./lib/collection-stats-helpers.js";

export async function registerCollectionStatsRoutes(
	app: FastifyInstance,
	_opts: FastifyPluginOptions,
) {
	app.get("/", async (request, reply) => {
		const userId = request.currentUser!.id;

		const evidence = await loadUserEvidence(app.prisma, { userId });
		const summary = summarizePlexEvidence(evidence);
		if (!hasAuthoritativePlexEvidence(evidence)) {
			return reply
				.status(503)
				.send({ error: "Plex cache evidence is unavailable", evidence: summary });
		}
		const entries = listObservedRows(evidence);

		const { parseFailures, totalEntries, failedPreviews, ...stats } =
			aggregateCollectionStats(entries);
		if (parseFailures > 0) {
			request.log.warn(
				{ parseFailures, totalEntries, failedPreviews, route: "collection-stats" },
				"PlexCache JSON parse failures detected",
			);
		}
		return reply.send({ ...stats, evidence: summary });
	});
}
