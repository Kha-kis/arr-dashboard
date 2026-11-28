/**
 * Plex Last Watched Routes
 *
 * Aggregates SessionSnapshot rows into a feed of recently-watched titles
 * (deduped by title). Replaces Tautulli's pre-aggregated home-stats
 * `last_watched`. Distinct from /analytics/history, which is event-level.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { readSessionSnapshotPages } from "../../lib/statistics/session-snapshot-pages.js";
import { validateRequest } from "../../lib/utils/validate.js";
import { activityCollectionMeasurement } from "./lib/activity-collection-helpers.js";
import { createTopMediaAccumulator } from "./lib/top-media-helpers.js";

const lastWatchedQuery = z.object({
	mediaType: z.enum(["movie", "series", "music"]),
	days: z
		.string()
		.optional()
		.transform((val) => {
			const n = val ? Number.parseInt(val, 10) : 30;
			return Number.isFinite(n) && n > 0 ? Math.min(n, 90) : 30;
		}),
	limit: z
		.string()
		.optional()
		.transform((val) => {
			const n = val ? Number.parseInt(val, 10) : 10;
			return Number.isFinite(n) && n > 0 ? Math.min(n, 50) : 10;
		}),
});

export async function registerLastWatchedRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	app.get("/", async (request, reply) => {
		const { mediaType, days, limit } = validateRequest(lastWatchedQuery, request.query);
		const userId = request.currentUser!.id;

		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const accumulator = createTopMediaAccumulator(mediaType);
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

		const { parseFailures, totalSnapshots, failedPreviews, ...response } = accumulator.getResult(
			"last-watched",
			limit,
		);
		if (parseFailures > 0) {
			request.log.warn(
				{ parseFailures, totalSnapshots, failedPreviews, route: "last-watched", mediaType },
				"Session snapshot JSON parse failures detected",
			);
		}
		return reply.send({ ...response, measurement: activityCollectionMeasurement(read) });
	});
}
