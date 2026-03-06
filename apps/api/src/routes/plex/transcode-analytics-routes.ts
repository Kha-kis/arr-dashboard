/**
 * Plex Transcode Analytics Routes
 *
 * Aggregates SessionSnapshot data into transcode decision breakdowns.
 */

import type { TranscodeAnalytics } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { validateRequest } from "../../lib/utils/validate.js";
import { analyticsQuery } from "./analytics-schemas.js";
import { aggregateTranscodeAnalytics } from "./lib/transcode-analytics-helpers.js";

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

		// Get user's Plex instances
		const plexInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: "PLEX", enabled: true },
			select: { id: true },
		});

		if (plexInstances.length === 0) {
			const response: TranscodeAnalytics = {
				directPlay: 0,
				transcode: 0,
				directStream: 0,
				totalSessions: 0,
				dailyBreakdown: [],
			};
			return reply.send(response);
		}

		const instanceIds = plexInstances.map((i) => i.id);
		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

		const snapshots = await app.prisma.sessionSnapshot.findMany({
			where: {
				instanceId: { in: instanceIds },
				capturedAt: { gte: cutoff },
			},
			select: {
				capturedAt: true,
				directPlayCount: true,
				transcodeCount: true,
				directStreamCount: true,
			},
			orderBy: { capturedAt: "asc" },
			take: 50000,
		});

		const { parseFailures, totalSnapshots, ...analytics } = aggregateTranscodeAnalytics(snapshots);
		if (parseFailures > 0) {
			request.log.warn({ parseFailures, totalSnapshots, route: "transcode-analytics" }, "Session snapshot parse failures detected");
		}
		return reply.send(analytics);
	});
}
