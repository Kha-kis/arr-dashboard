/**
 * Jellyfin Section Routes
 *
 * Returns distinct libraries from JellyfinCache for use in filtering.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";

export async function registerSectionRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * GET /api/jellyfin/sections
	 *
	 * Returns distinct (libraryId, libraryName, mediaType) tuples from JellyfinCache,
	 * scoped to the current user's Jellyfin instances.
	 */
	app.get("/", async (request, reply) => {
		const userId = request.currentUser!.id;

		const jellyfinInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: { in: ["JELLYFIN", "EMBY"] }, enabled: true },
			select: { id: true, label: true },
		});

		if (jellyfinInstances.length === 0) {
			return reply.send({ sections: [] });
		}

		const instanceMap = new Map(jellyfinInstances.map((i) => [i.id, i.label]));

		const groupedSections = await app.prisma.jellyfinCache.groupBy({
			by: ["instanceId", "libraryId", "libraryName", "mediaType"],
			where: {
				instanceId: { in: jellyfinInstances.map((i) => i.id) },
			},
		});

		const sections = groupedSections.map((s) => ({
			libraryId: s.libraryId,
			libraryName: s.libraryName,
			mediaType: s.mediaType,
			instanceId: s.instanceId,
			instanceName: instanceMap.get(s.instanceId) ?? s.instanceId,
		}));

		return reply.send({ sections });
	});
}
