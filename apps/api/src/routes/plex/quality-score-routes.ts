/**
 * Plex Quality Score Routes
 *
 * Computes a stream quality score (0-100) based on direct play rate,
 * resolution distribution, and transcode percentage.
 */

import type { QualityScoreAnalytics } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { validateRequest } from "../../lib/utils/validate.js";
import { analyticsQuery } from "./analytics-schemas.js";
import { computeQualityScore } from "./lib/quality-score-helpers.js";

export async function registerQualityScoreRoutes(
	app: FastifyInstance,
	_opts: FastifyPluginOptions,
) {
	app.get("/", async (request, reply) => {
		const { days } = validateRequest(analyticsQuery, request.query);
		const userId = request.currentUser!.id;

		const plexInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: "PLEX", enabled: true },
			select: { id: true },
		});

		if (plexInstances.length === 0) {
			const response: QualityScoreAnalytics = {
				overallScore: 0,
				breakdown: { directPlayScore: 0, resolutionScore: 0, transcodeScore: 0 },
				trend: [],
				perUser: [],
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
			select: { capturedAt: true, sessionsJson: true },
			orderBy: { capturedAt: "asc" },
			take: 50000,
		});

		const { parseFailures, totalSnapshots, failedPreviews, ...analytics } = computeQualityScore(snapshots);
		if (parseFailures > 0) {
			request.log.warn({ parseFailures, totalSnapshots, failedPreviews, route: "quality-score" }, "Session snapshot JSON parse failures detected");
		}
		return reply.send(analytics);
	});
}
