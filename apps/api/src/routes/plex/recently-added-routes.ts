/**
 * Plex Recently Added Routes
 *
 * Serves recently added content from PlexCache (addedAt field).
 * No live API calls — reads exclusively from cached data.
 */

import type { PlexRecentlyAddedResponse } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import {
	hasAuthoritativeSelectedPlexEvidence,
	loadUserSelectedEvidence,
	summarizePlexEvidence,
} from "../../lib/plex/plex-evidence-repository.js";
import { validateRequest } from "../../lib/utils/validate.js";
import { mapToRecentlyAddedItems } from "./lib/recently-added-helpers.js";

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
	 * GET /api/plex/recently-added?limit=20
	 *
	 * Returns items from PlexCache ordered by addedAt DESC.
	 * Only includes items with a non-null addedAt timestamp.
	 */
	app.get("/", async (request, reply) => {
		const { limit } = validateRequest(recentlyAddedQuery, request.query);
		const userId = request.currentUser!.id;

		const evidence = await loadUserSelectedEvidence(app.prisma, {
			userId,
			selection: { kind: "recently-added", limit },
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
		const cacheEntries = evidence
			.flatMap((entry) => entry.rows)
			.sort((left, right) => right.addedAt!.getTime() - left.addedAt!.getTime())
			.slice(0, limit);

		const items = mapToRecentlyAddedItems(cacheEntries, instanceMap);

		const response: PlexRecentlyAddedResponse = { items, evidence: summary };
		return reply.send(response);
	});
}
