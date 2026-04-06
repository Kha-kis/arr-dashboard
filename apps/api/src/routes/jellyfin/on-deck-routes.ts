/**
 * Jellyfin On-Deck Routes
 *
 * Serves "Continue Watching" items from JellyfinCache (onDeck flag).
 * No live API calls — reads exclusively from cached data.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";

export async function registerOnDeckRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * GET /api/jellyfin/on-deck
	 *
	 * Returns items from JellyfinCache where onDeck = true.
	 */
	app.get("/", async (request, reply) => {
		const userId = request.currentUser!.id;

		const jellyfinInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: { in: ["JELLYFIN", "EMBY"] }, enabled: true },
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
				onDeck: true,
			},
			take: 50,
		});

		const items = cacheEntries.map((entry) => ({
			tmdbId: entry.tmdbId,
			title: entry.title,
			mediaType: entry.mediaType,
			libraryName: entry.libraryName,
			instanceId: entry.instanceId,
			instanceName: instanceMap.get(entry.instanceId) ?? entry.instanceId,
			jellyfinId: entry.jellyfinId,
			thumb: entry.thumb,
		}));

		return reply.send({ items });
	});
}
