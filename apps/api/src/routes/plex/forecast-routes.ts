/**
 * Plex Bandwidth Forecast Routes
 *
 * Projects future bandwidth usage via linear regression on historical peaks,
 * and identifies peak usage hours.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { readSessionSnapshotMetricsPages } from "../../lib/statistics/session-snapshot-pages.js";
import { validateRequest } from "../../lib/utils/validate.js";
import { analyticsQuery } from "./analytics-schemas.js";
import { createForecastAccumulator } from "./lib/forecast-helpers.js";

export async function registerForecastRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	app.get("/", async (request, reply) => {
		const { days } = validateRequest(analyticsQuery, request.query);
		const userId = request.currentUser!.id;
		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const accumulator = createForecastAccumulator();
		const read = await readSessionSnapshotMetricsPages(app.prisma, {
			userId,
			services: ["PLEX"],
			cutoff,
			includeCollectionByDate: true,
			onPage: (page) => accumulator.addSnapshots(page),
		});

		const result = accumulator.getResult(7, read.collection, read.collectionByDate);
		return reply.send({
			...result,
			measurement: { ...result.measurement, configuredSources: read.instanceCount },
		});
	});
}
