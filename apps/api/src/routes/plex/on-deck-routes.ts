/**
 * Plex On-Deck Routes
 *
 * Serves "Continue Watching" items from PlexCache (onDeck flag).
 * No live API calls — reads exclusively from cached data.
 */

import type { PlexOnDeckResponse } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { mapToOnDeckItems } from "./lib/on-deck-helpers.js";

export async function registerOnDeckRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * GET /api/plex/on-deck
	 *
	 * Returns items from PlexCache where onDeck = true.
	 */
	app.get("/", async (request, reply) => {
		const userId = request.currentUser!.id;

		// Get user's enabled Plex instances
		const plexInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: "PLEX", enabled: true },
			select: { id: true, label: true },
		});

		if (plexInstances.length === 0) {
			const response: PlexOnDeckResponse = { items: [] };
			return reply.send(response);
		}

		const instanceIds = plexInstances.map((i) => i.id);
		const instanceMap = new Map(plexInstances.map((i) => [i.id, i.label]));

		const cacheEntries = await app.prisma.plexCache.findMany({
			where: {
				instanceId: { in: instanceIds },
				onDeck: true,
			},
			take: 50,
		});

		const items = mapToOnDeckItems(cacheEntries, instanceMap);

		const response: PlexOnDeckResponse = { items };
		return reply.send(response);
	});
}
