/**
 * Plex Last Watched Routes
 *
 * Aggregates SessionSnapshot rows into a feed of recently-watched titles
 * (deduped by title). Replaces Tautulli's pre-aggregated home-stats
 * `last_watched`. Distinct from /analytics/history, which is event-level.
 */

import type { TopMediaResponse } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { validateRequest } from "../../lib/utils/validate.js";
import { aggregateLastWatched } from "./lib/top-media-helpers.js";

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

		const plexInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: "PLEX", enabled: true },
			select: { id: true },
		});

		if (plexInstances.length === 0) {
			const empty: TopMediaResponse = { items: [] };
			return reply.send(empty);
		}

		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		// `last-watched` is a "most recent activity" feed — when the take cap is
		// hit (heavy users with >20k snapshots in the cutoff window), `asc` would
		// silently drop the recent rows the panel exists to surface.
		const snapshots = await app.prisma.sessionSnapshot.findMany({
			where: {
				instanceId: { in: plexInstances.map((i) => i.id) },
				capturedAt: { gte: cutoff },
			},
			select: { capturedAt: true, sessionsJson: true },
			orderBy: { capturedAt: "desc" },
			take: 20000,
		});

		const { parseFailures, totalSnapshots, failedPreviews, ...response } = aggregateLastWatched(
			snapshots,
			{ mediaType, limit },
		);
		if (parseFailures > 0) {
			request.log.warn(
				{ parseFailures, totalSnapshots, failedPreviews, route: "last-watched", mediaType },
				"Session snapshot JSON parse failures detected",
			);
		}
		return reply.send(response);
	});
}
