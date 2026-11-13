/**
 * Plex Watch History Routes
 *
 * Returns a deduplicated timeline of recent watch events from SessionSnapshot data.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { readSessionSnapshotPages } from "../../lib/statistics/session-snapshot-pages.js";
import { validateRequest } from "../../lib/utils/validate.js";
import { activityCollectionMeasurement } from "./lib/activity-collection-helpers.js";
import { createWatchHistoryAccumulator } from "./lib/watch-history-helpers.js";

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

		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const accumulator = createWatchHistoryAccumulator(limit);
		const read = await readSessionSnapshotPages(
			app.prisma,
			{
				userId,
				services: ["PLEX"],
				cutoff,
				onPage: (page) => accumulator.addBatch(page),
			},
			"reverse-chronological",
		);

		const { events, parseFailures, totalSnapshots, failedPreviews } = accumulator.getResult();
		if (parseFailures > 0) {
			request.log.warn(
				{ parseFailures, totalSnapshots, failedPreviews, route: "watch-history" },
				"Session snapshot JSON parse failures detected",
			);
		}
		return reply.send({ events, measurement: activityCollectionMeasurement(read) });
	});
}
