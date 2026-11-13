/**
 * Plex Bandwidth Analytics Routes
 *
 * Aggregates SessionSnapshot data into bandwidth and concurrency trends.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { readSessionSnapshotMetricsPages } from "../../lib/statistics/session-snapshot-pages.js";
import { validateRequest } from "../../lib/utils/validate.js";
import { analyticsQuery } from "./analytics-schemas.js";
import { createBandwidthAnalyticsAccumulator } from "./lib/bandwidth-analytics-helpers.js";

export async function registerBandwidthAnalyticsRoutes(
	app: FastifyInstance,
	_opts: FastifyPluginOptions,
) {
	/**
	 * GET /api/plex/analytics/bandwidth?days=30
	 *
	 * Returns known native bandwidth trends with measurement/collection coverage.
	 */
	app.get("/", async (request, reply) => {
		const { days } = validateRequest(analyticsQuery, request.query);
		const userId = request.currentUser!.id;
		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const accumulator = createBandwidthAnalyticsAccumulator();
		const read = await readSessionSnapshotMetricsPages(app.prisma, {
			userId,
			services: ["PLEX"],
			cutoff,
			includeCollectionByDate: true,
			onPage: (page) => accumulator.addSnapshots(page),
		});

		const { parseFailures, totalSnapshots, ...analytics } = accumulator.getResult(
			read.collection,
			read.collectionByDate,
		);
		if (parseFailures > 0) {
			request.log.warn(
				{ parseFailures, totalSnapshots, route: "bandwidth-analytics" },
				"Session snapshot parse failures detected",
			);
		}
		return reply.send({
			...analytics,
			measurement: { ...analytics.measurement, configuredSources: read.instanceCount },
		});
	});
}
