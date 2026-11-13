/**
 * Plex Transcode Analytics Routes
 *
 * Aggregates SessionSnapshot data into transcode decision breakdowns.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { readSessionSnapshotPages } from "../../lib/statistics/session-snapshot-pages.js";
import { validateRequest } from "../../lib/utils/validate.js";
import { analyticsQuery } from "./analytics-schemas.js";
import { createTranscodeAnalyticsAccumulator } from "./lib/transcode-analytics-helpers.js";

export async function registerTranscodeAnalyticsRoutes(
	app: FastifyInstance,
	_opts: FastifyPluginOptions,
) {
	/**
	 * GET /api/plex/analytics/transcode?days=30
	 *
	 * Aggregates session snapshots for transcode/direct play/direct stream breakdown.
	 */
	app.get("/", async (request, reply) => {
		const { days } = validateRequest(analyticsQuery, request.query);
		const userId = request.currentUser!.id;
		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const accumulator = createTranscodeAnalyticsAccumulator();
		const read = await readSessionSnapshotPages(app.prisma, {
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
				{ parseFailures, totalSnapshots, route: "transcode-analytics" },
				"Session snapshot parse failures detected",
			);
		}
		return reply.send({
			...analytics,
			measurement: { ...analytics.measurement, configuredSources: read.instanceCount },
		});
	});
}
