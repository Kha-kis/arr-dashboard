/**
 * Plex Quality Score Routes
 *
 * Computes a stream quality score (0-100) based on direct play rate,
 * resolution distribution, and transcode percentage.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { readSessionSnapshotPages } from "../../lib/statistics/session-snapshot-pages.js";
import { validateRequest } from "../../lib/utils/validate.js";
import { analyticsQuery } from "./analytics-schemas.js";
import { createQualityScoreAccumulator } from "./lib/quality-score-helpers.js";

export async function registerQualityScoreRoutes(
	app: FastifyInstance,
	_opts: FastifyPluginOptions,
) {
	app.get("/", async (request, reply) => {
		const { days } = validateRequest(analyticsQuery, request.query);
		const userId = request.currentUser!.id;

		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const accumulator = createQualityScoreAccumulator();
		const read = await readSessionSnapshotPages(app.prisma, {
			userId,
			services: ["PLEX"],
			cutoff,
			includeCollectionByDate: true,
			onPage: (page) => accumulator.addBatch(page),
		});
		const { parseFailures, totalSnapshots, ...analytics } = accumulator.getResult(
			read.collection,
			read.collectionByDate,
		);
		if (parseFailures > 0) {
			request.log.warn(
				{ parseFailures, totalSnapshots, route: "quality-score" },
				"Session snapshot JSON parse failures detected",
			);
		}
		return reply.send({
			...analytics,
			measurement: { ...analytics.measurement, configuredSources: read.instanceCount },
		});
	});
}
