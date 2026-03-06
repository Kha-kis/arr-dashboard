/**
 * Plex Watch History Routes
 *
 * Returns a deduplicated timeline of recent watch events from SessionSnapshot data.
 */

import type { WatchHistoryResponse } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { validateRequest } from "../../lib/utils/validate.js";
import { deduplicateWatchEvents } from "./lib/watch-history-helpers.js";

const watchHistoryQuery = z.object({
	days: z
		.string()
		.optional()
		.transform((val) => {
			const n = val ? Number.parseInt(val, 10) : 7;
			return Number.isFinite(n) && n > 0 ? Math.min(n, 90) : 7;
		}),
	limit: z
		.string()
		.optional()
		.transform((val) => {
			const n = val ? Number.parseInt(val, 10) : 50;
			return Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 50;
		}),
});

export async function registerWatchHistoryRoutes(
	app: FastifyInstance,
	_opts: FastifyPluginOptions,
) {
	app.get("/", async (request, reply) => {
		const { days, limit } = validateRequest(watchHistoryQuery, request.query);
		const userId = request.currentUser!.id;

		const plexInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: "PLEX", enabled: true },
			select: { id: true },
		});

		if (plexInstances.length === 0) {
			const response: WatchHistoryResponse = { events: [] };
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
			orderBy: { capturedAt: "desc" },
			take: 50000,
		});

		const { events, parseFailures, totalSnapshots, failedPreviews } = deduplicateWatchEvents(snapshots, limit);
		if (parseFailures > 0) {
			request.log.warn({ parseFailures, totalSnapshots, failedPreviews, route: "watch-history" }, "Session snapshot JSON parse failures detected");
		}
		return reply.send({ events });
	});
}
