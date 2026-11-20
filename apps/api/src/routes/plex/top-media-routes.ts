/**
 * Plex Top Media Routes
 *
 * Aggregates SessionSnapshot rows into a leaderboard of most-watched titles
 * for a given media type (movie / series / music). Replaces Tautulli's
 * pre-aggregated home-stats top_movies / top_tv / top_music.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { readSessionSnapshotPages } from "../../lib/statistics/session-snapshot-pages.js";
import { validateRequest } from "../../lib/utils/validate.js";
import { activityCollectionMeasurement } from "./lib/activity-collection-helpers.js";
import { createTopMediaAccumulator } from "./lib/top-media-helpers.js";

const topMediaQuery = z.object({
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

export async function registerTopMediaRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * GET /api/plex/analytics/top-media?mediaType=movie&days=30&limit=10
	 *
	 * Returns the top-N most-watched titles of the given media type from
	 * SessionSnapshot rows for this user's Plex instances.
	 */
	app.get("/", async (request, reply) => {
		const { mediaType, days, limit } = validateRequest(topMediaQuery, request.query);
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
			"top",
			limit,
		);
		if (parseFailures > 0) {
			request.log.warn(
				{ parseFailures, totalSnapshots, failedPreviews, route: "top-media", mediaType },
				"Session snapshot JSON parse failures detected",
			);
		}
		return reply.send({ ...response, measurement: activityCollectionMeasurement(read) });
	});
}
