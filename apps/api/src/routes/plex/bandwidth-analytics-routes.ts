/**
 * Plex Bandwidth Analytics Routes
 *
 * Aggregates SessionSnapshot data into bandwidth and concurrency trends.
 */

import type { BandwidthAnalytics } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { validateRequest } from "../../lib/utils/validate.js";
import { analyticsQuery } from "./analytics-schemas.js";
import { aggregateBandwidthAnalytics } from "./lib/bandwidth-analytics-helpers.js";

export async function registerBandwidthAnalyticsRoutes(
	app: FastifyInstance,
	_opts: FastifyPluginOptions,
) {
	/**
	 * GET /api/plex/analytics/bandwidth?days=30
	 *
	 * Returns bandwidth trends, peak concurrent streams, and LAN/WAN breakdown.
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
			const response: BandwidthAnalytics = {
				peakConcurrent: 0,
				peakBandwidth: 0,
				avgBandwidth: 0,
				timeSeries: [],
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
				concurrentStreams: true,
				totalBandwidth: true,
				lanBandwidth: true,
				wanBandwidth: true,
			},
			orderBy: { capturedAt: "asc" },
			take: 50000,
		});

		const { parseFailures, totalSnapshots, ...analytics } = aggregateBandwidthAnalytics(snapshots);
		if (parseFailures > 0) {
			request.log.warn({ parseFailures, totalSnapshots, route: "bandwidth-analytics" }, "Session snapshot parse failures detected");
		}
		return reply.send(analytics);
	});
}
