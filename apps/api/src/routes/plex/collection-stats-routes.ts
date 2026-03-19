/**
 * Plex Collection/Label Statistics Routes
 *
 * Aggregates collection and label item counts with watched percentages from PlexCache.
 */

import type { CollectionStats } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { aggregateCollectionStats } from "./lib/collection-stats-helpers.js";

export async function registerCollectionStatsRoutes(
	app: FastifyInstance,
	_opts: FastifyPluginOptions,
) {
	app.get("/", async (request, reply) => {
		const userId = request.currentUser!.id;

		const plexInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: "PLEX", enabled: true },
			select: { id: true },
		});

		if (plexInstances.length === 0) {
			const response: CollectionStats = { collections: [], labels: [] };
			return reply.send(response);
		}

		const instanceIds = plexInstances.map((i) => i.id);

		const entries = await app.prisma.plexCache.findMany({
			where: { instanceId: { in: instanceIds } },
			select: { collections: true, labels: true, watchCount: true },
			take: 10000,
		});

		const { parseFailures, totalEntries, failedPreviews, ...stats } =
			aggregateCollectionStats(entries);
		if (parseFailures > 0) {
			request.log.warn(
				{ parseFailures, totalEntries, failedPreviews, route: "collection-stats" },
				"PlexCache JSON parse failures detected",
			);
		}
		return reply.send(stats);
	});
}
