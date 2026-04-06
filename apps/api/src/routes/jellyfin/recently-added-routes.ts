/**
 * Jellyfin Recently Added Routes
 *
 * Serves recently added content from JellyfinCache (addedAt field).
 * No live API calls — reads exclusively from cached data.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { validateRequest } from "../../lib/utils/validate.js";

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
	 * GET /api/jellyfin/recently-added?limit=20
	 *
	 * Returns items from JellyfinCache ordered by addedAt DESC.
	 */
	app.get("/", async (request, reply) => {
		const { limit } = validateRequest(recentlyAddedQuery, request.query);
		const userId = request.currentUser!.id;

		const jellyfinInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: "JELLYFIN", enabled: true },
			select: { id: true, label: true },
		});

		if (jellyfinInstances.length === 0) {
			return reply.send({ items: [] });
		}

		const instanceIds = jellyfinInstances.map((i) => i.id);
		const instanceMap = new Map(jellyfinInstances.map((i) => [i.id, i.label]));

		const cacheEntries = await app.prisma.jellyfinCache.findMany({
			where: {
				instanceId: { in: instanceIds },
				addedAt: { not: null },
			},
			orderBy: { addedAt: "desc" },
			take: limit,
		});

		const items = cacheEntries.map((entry) => ({
			tmdbId: entry.tmdbId,
			title: entry.title,
			mediaType: entry.mediaType,
			libraryName: entry.libraryName,
			addedAt: entry.addedAt?.toISOString() ?? null,
			jellyfinId: entry.jellyfinId,
			thumb: entry.thumb,
			instanceId: entry.instanceId,
			instanceName: instanceMap.get(entry.instanceId) ?? entry.instanceId,
		}));

		return reply.send({ items });
	});
}
