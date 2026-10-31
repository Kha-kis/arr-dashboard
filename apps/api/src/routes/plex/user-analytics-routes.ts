/**
 * Plex User Analytics Routes
 *
 * Per-user session aggregation: total sessions, bandwidth, watch time, daily breakdown.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { readSessionSnapshotPages } from "../../lib/statistics/session-snapshot-pages.js";
import { validateRequest } from "../../lib/utils/validate.js";
import { analyticsQuery } from "./analytics-schemas.js";
import { createUserAnalyticsAccumulator } from "./lib/user-analytics-helpers.js";

export async function registerUserAnalyticsRoutes(
	app: FastifyInstance,
	_opts: FastifyPluginOptions,
) {
	app.get("/", async (request, reply) => {
		const { days } = validateRequest(analyticsQuery, request.query);
		const userId = request.currentUser!.id;
		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const accumulator = createUserAnalyticsAccumulator();
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
				{ parseFailures, totalSnapshots, route: "user-analytics" },
				"Session snapshot JSON parse failures detected",
			);
		}
		return reply.send({
			...analytics,
			measurement: { ...analytics.measurement, configuredSources: read.instanceCount },
		});
	});
}
