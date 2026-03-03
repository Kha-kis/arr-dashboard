/**
 * Plex Codec/Resolution Analytics Routes
 *
 * Aggregates video/audio codec and resolution distributions from SessionSnapshot data.
 */

import type { CodecAnalytics } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { validateRequest } from "../../lib/utils/validate.js";
import { analyticsQuery } from "./analytics-schemas.js";
import { aggregateCodecAnalytics } from "./lib/codec-analytics-helpers.js";

export async function registerCodecAnalyticsRoutes(
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
			const response: CodecAnalytics = { videoCodecs: [], audioCodecs: [], resolutions: [], totalSessions: 0 };
			return reply.send(response);
		}

		const instanceIds = plexInstances.map((i) => i.id);
		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

		const snapshots = await app.prisma.sessionSnapshot.findMany({
			where: {
				instanceId: { in: instanceIds },
				capturedAt: { gte: cutoff },
			},
			select: { sessionsJson: true },
			orderBy: { capturedAt: "asc" },
			take: 50000,
		});

		const { parseFailures, totalSnapshots, failedPreviews, ...analytics } = aggregateCodecAnalytics(snapshots);
		if (parseFailures > 0) {
			request.log.warn({ parseFailures, totalSnapshots, failedPreviews, route: "codec-analytics" }, "Session snapshot JSON parse failures detected");
		}
		return reply.send(analytics);
	});
}
