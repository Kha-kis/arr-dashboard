/**
 * Plex Plays By Date Routes
 *
 * Aggregates SessionSnapshot rows into per-day play counts segmented by
 * media type. Replaces Tautulli's pre-aggregated `cmd=get_plays_by_date`.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { readSessionSnapshotPages } from "../../lib/statistics/session-snapshot-pages.js";
import { validateRequest } from "../../lib/utils/validate.js";
import { projectDailyActivityCollection } from "./lib/activity-collection-helpers.js";
import { createPlaysByDateAccumulator } from "./lib/plays-by-date-helpers.js";

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

		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const accumulator = createPlaysByDateAccumulator({ days });
		const read = await readSessionSnapshotPages(app.prisma, {
			userId,
			services: ["PLEX"],
			cutoff,
			onPage: (page) => accumulator.addBatch(page),
			includeCollectionByDate: true,
		});
		return reply.send(projectDailyActivityCollection(accumulator.getResult(), read));
	});
}
