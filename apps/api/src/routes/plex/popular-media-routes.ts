/**
 * Plex Popular Media Routes
 *
 * Aggregates SessionSnapshot rows into a leaderboard of titles ranked by
 * distinct watcher count. Replaces Tautulli's pre-aggregated home-stats
 * popular_movies / popular_tv / popular_music.
 */

import type { TopMediaResponse } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { validateRequest } from "../../lib/utils/validate.js";
import { aggregatePopularMedia } from "../../lib/media-stats/top-media-helpers.js";

const popularMediaQuery = z.object({
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

export async function registerPopularMediaRoutes(
	app: FastifyInstance,
	_opts: FastifyPluginOptions,
) {
	/**
	 * GET /api/plex/analytics/popular-media?mediaType=movie&days=30&limit=10
	 *
	 * Returns the top-N titles of the given media type ranked by distinct
	 * watcher count from SessionSnapshot rows for this user's Plex instances.
	 */
	app.get("/", async (request, reply) => {
		const { mediaType, days, limit } = validateRequest(popularMediaQuery, request.query);
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
			take: 20000,
		});

		const { parseFailures, totalSnapshots, failedPreviews, ...response } = aggregatePopularMedia(
			snapshots,
			{ mediaType, limit },
		);
		if (parseFailures > 0) {
			request.log.warn(
				{ parseFailures, totalSnapshots, failedPreviews, route: "popular-media", mediaType },
				"Session snapshot JSON parse failures detected",
			);
		}
		return reply.send(response);
	});
}
