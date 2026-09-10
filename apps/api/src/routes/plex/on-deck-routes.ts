/**
 * Plex On-Deck Routes
 *
 * Serves "Continue Watching" items from PlexCache (onDeck flag).
 * No live API calls — reads exclusively from cached data.
 */

import type { PlexOnDeckResponse } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import {
	listDisplayableSelectedPlexEvidence,
	PlexAuthorityService,
	summarizePlexEvidence,
} from "../../lib/plex/plex-authority-service.js";
import { mapToOnDeckItems } from "./lib/on-deck-helpers.js";

export async function registerOnDeckRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * GET /api/plex/on-deck
	 *
	 * Returns items from PlexCache where onDeck = true.
	 */
	app.get("/", async (request, reply) => {
		const userId = request.currentUser!.id;

		const evidence = await new PlexAuthorityService({
			prisma: app.prisma,
			encryptor: app.encryptor,
			log: request.log,
		}).readUserSelectedDisplay({
			userId,
			selection: { kind: "on-deck", limit: 50 },
			domains: ["membership", "display", "on-deck"],
		});
		const summary = summarizePlexEvidence(evidence);
		const displayableEvidence = listDisplayableSelectedPlexEvidence(evidence);
		if (displayableEvidence.length === 0) {
			return reply.status(503).send({
				error: "Plex cache evidence is unavailable",
				evidence: summary,
			});
		}
		const instanceMap = new Map(
			displayableEvidence.map((entry) => [entry.instanceId, entry.instanceName] as const),
		);
		const cacheEntries = displayableEvidence.flatMap((entry) => entry.rows).slice(0, 50);

		const items = mapToOnDeckItems(cacheEntries, instanceMap);

		const response: PlexOnDeckResponse = { items, evidence: summary };
		return reply.send(response);
	});
}
