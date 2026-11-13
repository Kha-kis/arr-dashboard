/**
 * Plex Codec/Resolution Analytics Routes
 *
 * Aggregates video/audio codec and resolution distributions from SessionSnapshot data.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { readSessionSnapshotPages } from "../../lib/statistics/session-snapshot-pages.js";
import { validateRequest } from "../../lib/utils/validate.js";
import { analyticsQuery } from "./analytics-schemas.js";
import { createCodecAnalyticsAccumulator } from "./lib/codec-analytics-helpers.js";

export async function registerCodecAnalyticsRoutes(
	app: FastifyInstance,
	_opts: FastifyPluginOptions,
) {
	app.get("/", async (request, reply) => {
		const { days } = validateRequest(analyticsQuery, request.query);
		const userId = request.currentUser!.id;
		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const accumulator = createCodecAnalyticsAccumulator();
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
				{ parseFailures, totalSnapshots, route: "codec-analytics" },
				"Session snapshot JSON parse failures detected",
			);
		}
		return reply.send({
			...analytics,
			measurement: { ...analytics.measurement, configuredSources: read.instanceCount },
		});
	});
}
