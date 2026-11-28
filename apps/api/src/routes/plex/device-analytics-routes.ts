/**
 * Plex Device/Platform Analytics Routes
 *
 * Aggregates platform and player distributions from SessionSnapshot data.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { readSessionSnapshotPages } from "../../lib/statistics/session-snapshot-pages.js";
import { validateRequest } from "../../lib/utils/validate.js";
import { analyticsQuery } from "./analytics-schemas.js";
import { createDeviceAnalyticsAccumulator } from "./lib/device-analytics-helpers.js";

export async function registerDeviceAnalyticsRoutes(
	app: FastifyInstance,
	_opts: FastifyPluginOptions,
) {
	app.get("/", async (request, reply) => {
		const { days } = validateRequest(analyticsQuery, request.query);
		const userId = request.currentUser!.id;
		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const accumulator = createDeviceAnalyticsAccumulator();
		const read = await readSessionSnapshotPages(app.prisma, {
			userId,
			services: ["PLEX"],
			cutoff,
			onPage: (page) => accumulator.addSnapshots(page),
		});
		const {
			parseFailures,
			totalSnapshots,
			failedPreviews: _unusedPreviews,
			...analytics
		} = accumulator.getResult(read.collection);
		if (parseFailures > 0) {
			request.log.warn(
				{ parseFailures, totalSnapshots, route: "device-analytics" },
				"Session snapshot JSON parse failures detected",
			);
		}
		return reply.send({
			...analytics,
			measurement: {
				...analytics.measurement,
				configuredSources: read.instanceCount,
				platformAxis: "platform",
			},
		});
	});
}
