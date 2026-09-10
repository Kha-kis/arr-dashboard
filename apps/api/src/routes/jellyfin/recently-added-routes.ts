/**
 * Jellyfin Recently Added Routes
 *
 * Serves recently added content from owned Jellyfin/Emby observations.
 * No live API calls — reads exclusively from cached data.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import {
	type JellyfinDisplayInstance,
	readOwnedJellyfinLibraryDisplaySources,
} from "../../lib/jellyfin/jellyfin-display-evidence.js";
import { validateRequest } from "../../lib/utils/validate.js";

function compareStrings(left: string, right: string): number {
	return left === right ? 0 : left < right ? -1 : 1;
}

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
	 * Returns observed items ordered by addedAt DESC.
	 */
	app.get("/", async (request, reply) => {
		const { limit } = validateRequest(recentlyAddedQuery, request.query);
		const userId = request.currentUser!.id;

		const jellyfinInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: { in: ["JELLYFIN", "EMBY"] }, enabled: true },
			select: { id: true, label: true, service: true },
		});

		if (jellyfinInstances.length === 0) {
			return reply.send({ items: [] });
		}

		const displayEvidence = await readOwnedJellyfinLibraryDisplaySources({
			prisma: app.prisma,
			userId,
			instances: jellyfinInstances as JellyfinDisplayInstance[],
		});

		const items = displayEvidence.sources
			.flatMap((source) =>
				source.rows
					.filter((entry) => entry.addedAt !== null)
					.map((entry) => ({ entry, instanceName: source.instanceName })),
			)
			.sort(
				(left, right) =>
					right.entry.addedAt!.getTime() - left.entry.addedAt!.getTime() ||
					compareStrings(left.entry.instanceId, right.entry.instanceId) ||
					compareStrings(left.entry.id, right.entry.id),
			)
			.slice(0, limit)
			.map(({ entry, instanceName }) => ({
				tmdbId: entry.tmdbId,
				title: entry.title,
				mediaType: entry.mediaType,
				libraryName: entry.libraryName,
				addedAt: entry.addedAt!.toISOString(),
				jellyfinId: entry.jellyfinId,
				thumb: entry.thumb,
				instanceId: entry.instanceId,
				instanceName,
			}));

		return reply.send({ items, providerStatus: displayEvidence.providerStatus });
	});
}
