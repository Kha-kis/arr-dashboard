/**
 * Plex On-Deck Routes
 *
 * Serves "Continue Watching" items from PlexCache (onDeck flag).
 * No live API calls — reads exclusively from cached data.
 */

import type { PlexOnDeckResponse } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import {
	hasAuthoritativeSelectedPlexEvidence,
	loadUserSelectedEvidence,
	summarizePlexEvidence,
} from "../../lib/plex/plex-evidence-repository.js";
import { mapToOnDeckItems } from "./lib/on-deck-helpers.js";

export async function registerOnDeckRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * GET /api/plex/on-deck
	 *
	 * Returns items from PlexCache where onDeck = true.
	 */
	app.get("/", async (request, reply) => {
		const userId = request.currentUser!.id;

		const evidence = await loadUserSelectedEvidence(app.prisma, {
			userId,
			selection: { kind: "on-deck", limit: 50 },
		});
		const summary = summarizePlexEvidence(evidence);
		if (!hasAuthoritativeSelectedPlexEvidence(evidence)) {
			return reply.status(503).send({
				error: "Plex cache evidence is unavailable",
				evidence: summary,
			});
		}
		const instanceMap = new Map(
			evidence.flatMap((entry) =>
				entry.available ? [[entry.instanceId, entry.instanceName] as const] : [],
			),
		);
		const cacheEntries = evidence.flatMap((entry) => entry.rows).slice(0, 50);

		const items = mapToOnDeckItems(cacheEntries, instanceMap);

		const response: PlexOnDeckResponse = { items, evidence: summary };
		return reply.send(response);
	});
}
