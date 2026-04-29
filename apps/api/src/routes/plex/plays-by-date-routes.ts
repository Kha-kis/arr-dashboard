/**
 * Plex Plays By Date Routes
 *
 * Aggregates SessionSnapshot rows into per-day play counts segmented by
 * media type. Replaces Tautulli's pre-aggregated `cmd=get_plays_by_date`.
 */

import type { PlaysByDateResponse } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { validateRequest } from "../../lib/utils/validate.js";
import { aggregatePlaysByDate } from "./lib/plays-by-date-helpers.js";

const playsByDateQuery = z.object({
	days: z
		.string()
		.optional()
		.transform((val) => {
			const n = val ? Number.parseInt(val, 10) : 30;
			return Number.isFinite(n) && n > 0 ? Math.min(n, 90) : 30;
		}),
});

export async function registerPlaysByDateRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	app.get("/", async (request, reply) => {
		const { days } = validateRequest(playsByDateQuery, request.query);
		const userId = request.currentUser!.id;

		const plexInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: "PLEX", enabled: true },
			select: { id: true },
		});

		if (plexInstances.length === 0) {
			const empty: PlaysByDateResponse = { categories: [], series: [] };
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

		return reply.send(aggregatePlaysByDate(snapshots, { days }));
	});
}
