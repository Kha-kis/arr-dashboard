/**
 * Plex Most Concurrent Routes
 *
 * Aggregates SessionSnapshot rows into peak concurrent-stream events.
 * Replaces Tautulli's pre-aggregated home-stats `most_concurrent`.
 */

import type { MostConcurrentResponse } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { readSessionSnapshotMetricsPages } from "../../lib/statistics/session-snapshot-pages.js";
import { validateRequest } from "../../lib/utils/validate.js";
import { createMostConcurrentAccumulator } from "./lib/most-concurrent-helpers.js";

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
		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const accumulator = createMostConcurrentAccumulator({ limit });
		const read = await readSessionSnapshotMetricsPages(
			app.prisma,
			{
				userId,
				services: ["PLEX"],
				cutoff,
				onPage: (page) => accumulator.addSnapshots(page),
			},
			"most-concurrent",
		);

		const result: MostConcurrentResponse = accumulator.getResult(read.collection);
		return reply.send({
			...result,
			measurement: { ...result.measurement, configuredSources: read.instanceCount },
		});
	});
}
