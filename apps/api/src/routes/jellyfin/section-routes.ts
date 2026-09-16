/**
 * Jellyfin Section Routes
 *
 * Returns distinct libraries from owned Jellyfin/Emby observations for use in filtering.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import {
	type JellyfinDisplayInstance,
	readOwnedJellyfinLibraryDisplaySources,
} from "../../lib/jellyfin/jellyfin-display-evidence.js";

function compareStrings(left: string, right: string): number {
	return left === right ? 0 : left < right ? -1 : 1;
}

export async function registerSectionRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * GET /api/jellyfin/sections
	 *
	 * Returns distinct (libraryId, libraryName, mediaType) tuples from owned observations,
	 * scoped to the current user's Jellyfin instances.
	 */
	app.get("/", async (request, reply) => {
		const userId = request.currentUser!.id;

		const jellyfinInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: { in: ["JELLYFIN", "EMBY"] }, enabled: true },
			select: { id: true, label: true, service: true },
		});

		if (jellyfinInstances.length === 0) {
			return reply.send({ sections: [] });
		}

		const displayEvidence = await readOwnedJellyfinLibraryDisplaySources({
			prisma: app.prisma,
			userId,
			instances: jellyfinInstances as JellyfinDisplayInstance[],
		});

		const sectionsByKey = new Map<
			string,
			{
				libraryId: string;
				libraryName: string;
				mediaType: string;
				instanceId: string;
				instanceName: string;
			}
		>();
		for (const source of displayEvidence.sources) {
			for (const row of source.rows) {
				const key = `${source.instanceId}\u0000${row.libraryId}\u0000${row.libraryName}\u0000${row.mediaType}`;
				if (!sectionsByKey.has(key)) {
					sectionsByKey.set(key, {
						libraryId: row.libraryId,
						libraryName: row.libraryName,
						mediaType: row.mediaType,
						instanceId: source.instanceId,
						instanceName: source.instanceName,
					});
				}
			}
		}
		const sections = [...sectionsByKey.values()].sort(
			(left, right) =>
				compareStrings(left.instanceId, right.instanceId) ||
				compareStrings(left.libraryId, right.libraryId) ||
				compareStrings(left.mediaType, right.mediaType) ||
				compareStrings(left.libraryName, right.libraryName),
		);

		return reply.send({ sections, providerStatus: displayEvidence.providerStatus });
	});
}
