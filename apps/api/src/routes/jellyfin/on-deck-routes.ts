/**
 * Jellyfin On-Deck Routes
 *
 * Serves "Continue Watching" items from owned Jellyfin/Emby observations.
 * No live API calls — reads exclusively from cached data.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { withIsolatedRuntimePrismaBulkReadClient } from "../../lib/backup/restore-runtime-client.js";
import {
	type JellyfinDisplayInstance,
	readOwnedJellyfinLibraryDisplaySources,
} from "../../lib/jellyfin/jellyfin-display-evidence.js";

function compareStrings(left: string, right: string): number {
	return left === right ? 0 : left < right ? -1 : 1;
}

export async function registerOnDeckRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * GET /api/jellyfin/on-deck
	 *
	 * Returns observed items where onDeck = true.
	 */
	app.get("/", async (request, reply) => {
		const userId = request.currentUser!.id;

		const displayEvidence = await withIsolatedRuntimePrismaBulkReadClient(
			app.prisma,
			async (prisma) => {
				const jellyfinInstances = await prisma.serviceInstance.findMany({
					where: { userId, service: { in: ["JELLYFIN", "EMBY"] }, enabled: true },
					select: { id: true, label: true, service: true },
				});
				if (jellyfinInstances.length === 0) return null;
				return readOwnedJellyfinLibraryDisplaySources({
					prisma,
					userId,
					instances: jellyfinInstances as JellyfinDisplayInstance[],
				});
			},
			{ lease: "phase" },
		);
		if (displayEvidence === null) return reply.send({ items: [] });

		const items = displayEvidence.sources
			.flatMap((source) =>
				source.rows
					.filter((entry) => entry.onDeck)
					.map((entry) => ({ entry, instanceName: source.instanceName })),
			)
			.sort(
				(left, right) =>
					compareStrings(left.entry.instanceId, right.entry.instanceId) ||
					compareStrings(left.entry.id, right.entry.id),
			)
			.slice(0, 50)
			.map(({ entry, instanceName }) => ({
				tmdbId: entry.tmdbId,
				title: entry.title,
				mediaType: entry.mediaType,
				libraryName: entry.libraryName,
				instanceId: entry.instanceId,
				instanceName,
				jellyfinId: entry.jellyfinId,
				thumb: entry.thumb,
			}));

		return reply.send({ items, providerStatus: displayEvidence.providerStatus });
	});
}
