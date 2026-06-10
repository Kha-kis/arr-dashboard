/**
 * Plex Most Concurrent Routes
 *
 * Aggregates SessionSnapshot rows into peak concurrent-stream events.
 * Replaces Tautulli's pre-aggregated home-stats `most_concurrent`.
 */

import type { MostConcurrentResponse } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { validateRequest } from "../../lib/utils/validate.js";
import { aggregateMostConcurrent } from "../../lib/media-stats/most-concurrent-helpers.js";

const mostConcurrentQuery = z.object({
	days: z
		.string()
		.optional()
		.transform((val) => {
			const n = val ? Number.parseInt(val, 10) : 30;
			return Number.isFinite(n) && n > 0 ? Math.min(n, 90) : 30;
		}),
	limit: z
		.string()
		.optional()
		.transform((val) => {
			const n = val ? Number.parseInt(val, 10) : 5;
			return Number.isFinite(n) && n > 0 ? Math.min(n, 25) : 5;
		}),
});

export async function registerMostConcurrentRoutes(
	app: FastifyInstance,
	_opts: FastifyPluginOptions,
) {
	app.get("/", async (request, reply) => {
		const { days, limit } = validateRequest(mostConcurrentQuery, request.query);
		const userId = request.currentUser!.id;

		const plexInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: "PLEX", enabled: true },
			select: { id: true },
		});

		if (plexInstances.length === 0) {
			const empty: MostConcurrentResponse = { peakConcurrent: 0, events: [] };
			return reply.send(empty);
		}

		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const snapshots = await app.prisma.sessionSnapshot.findMany({
			where: {
				instanceId: { in: plexInstances.map((i) => i.id) },
				capturedAt: { gte: cutoff },
			},
			select: { capturedAt: true, concurrentStreams: true, totalBandwidth: true },
			orderBy: { capturedAt: "asc" },
			take: 50000,
		});

		return reply.send(aggregateMostConcurrent(snapshots, { limit }));
	});
}
