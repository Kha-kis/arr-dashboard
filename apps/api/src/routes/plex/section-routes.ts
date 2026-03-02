/**
 * Plex Section Routes
 *
 * Returns distinct library sections from PlexCache for use in cleanup rule filtering.
 */

import type { PlexSection, PlexSectionsResponse } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";

export async function registerSectionRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * GET /api/plex/sections
	 *
	 * Returns distinct (sectionId, sectionTitle, mediaType) tuples from PlexCache,
	 * scoped to the current user's Plex instances.
	 */
	app.get("/", async (request, reply) => {
		const userId = request.currentUser!.id;

		const plexInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: "PLEX", enabled: true },
			select: { id: true, label: true },
		});

		if (plexInstances.length === 0) {
			return reply.send({ sections: [] } satisfies PlexSectionsResponse);
		}

		const instanceMap = new Map(plexInstances.map((i) => [i.id, i.label]));

		// Get distinct sections from cache using groupBy
		const groupedSections = await app.prisma.plexCache.groupBy({
			by: ["instanceId", "sectionId", "sectionTitle", "mediaType"],
			where: {
				instanceId: { in: plexInstances.map((i) => i.id) },
			},
		});

		const sections: PlexSection[] = groupedSections.map((group) => ({
			sectionId: group.sectionId,
			sectionTitle: group.sectionTitle,
			mediaType: group.mediaType,
			instanceId: group.instanceId,
			instanceName: instanceMap.get(group.instanceId) ?? "Unknown",
		}));

		return reply.send({ sections } satisfies PlexSectionsResponse);
	});
}
