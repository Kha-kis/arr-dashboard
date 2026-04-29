/**
 * Plex Top Media Routes
 *
 * Aggregates SessionSnapshot rows into a leaderboard of most-watched titles
 * for a given media type (movie / series / music). Replaces Tautulli's
 * pre-aggregated home-stats top_movies / top_tv / top_music.
 */

import type { TopMediaResponse } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { validateRequest } from "../../lib/utils/validate.js";
import { aggregateTopMedia } from "./lib/top-media-helpers.js";

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

		const plexInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: "PLEX", enabled: true },
			select: { id: true },
		});

		if (plexInstances.length === 0) {
			const empty: TopMediaResponse = { items: [] };
			return reply.send(empty);
		}

		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const snapshots = await app.prisma.sessionSnapshot.findMany({
			where: {
				instanceId: { in: plexInstances.map((i) => i.id) },
				capturedAt: { gte: cutoff },
			},
			select: { capturedAt: true, sessionsJson: true },
			orderBy: { capturedAt: "asc" },
			take: 50000,
		});

		const { parseFailures, totalSnapshots, failedPreviews, ...response } = aggregateTopMedia(
			snapshots,
			{ mediaType, limit },
		);
		if (parseFailures > 0) {
			request.log.warn(
				{ parseFailures, totalSnapshots, failedPreviews, route: "top-media", mediaType },
				"Session snapshot JSON parse failures detected",
			);
		}
		return reply.send(response);
	});
}
