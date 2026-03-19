/**
 * Plex Recently Added Routes
 *
 * Serves recently added content from PlexCache (addedAt field).
 * No live API calls — reads exclusively from cached data.
 */

import type { PlexRecentlyAddedResponse } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { validateRequest } from "../../lib/utils/validate.js";
import { mapToRecentlyAddedItems } from "./lib/recently-added-helpers.js";

const recentlyAddedQuery = z.object({
	limit: z
		.string()
		.optional()
		.transform((val) => {
			const n = val ? Number.parseInt(val, 10) : 20;
			return Number.isFinite(n) && n > 0 ? Math.min(n, 50) : 20;
		}),
});

export async function registerRecentlyAddedRoutes(
	app: FastifyInstance,
	_opts: FastifyPluginOptions,
) {
	/**
	 * GET /api/plex/recently-added?limit=20
	 *
	 * Returns items from PlexCache ordered by addedAt DESC.
	 * Only includes items with a non-null addedAt timestamp.
	 */
	app.get("/", async (request, reply) => {
		const { limit } = validateRequest(recentlyAddedQuery, request.query);
		const userId = request.currentUser!.id;

		// Get user's enabled Plex instances
		const plexInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: "PLEX", enabled: true },
			select: { id: true, label: true },
		});

		if (plexInstances.length === 0) {
			const response: PlexRecentlyAddedResponse = { items: [] };
			return reply.send(response);
		}

		const instanceIds = plexInstances.map((i) => i.id);
		const instanceMap = new Map(plexInstances.map((i) => [i.id, i.label]));

		const cacheEntries = await app.prisma.plexCache.findMany({
			where: {
				instanceId: { in: instanceIds },
				addedAt: { not: null },
			},
			orderBy: { addedAt: "desc" },
			take: limit,
		});

		const items = mapToRecentlyAddedItems(cacheEntries, instanceMap);

		const response: PlexRecentlyAddedResponse = { items };
		return reply.send(response);
	});
}
