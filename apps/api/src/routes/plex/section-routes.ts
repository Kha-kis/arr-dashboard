/**
 * Plex Section Routes
 *
 * Returns the independently verified published section catalog for display.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { withIsolatedRuntimePrismaBulkReadClient } from "../../lib/backup/restore-runtime-client.js";
import { loadPlexSectionCatalog } from "../../lib/plex/plex-section-catalog.js";

export async function registerSectionRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * GET /api/plex/sections
	 *
	 * Cache-only read scoped to the current user's enabled Plex instances.
	 * Canonical watch/mapping evidence remains separate from catalog availability.
	 */
	app.get("/", async (request, reply) => {
		const userId = request.currentUser!.id;

		const catalog = await withIsolatedRuntimePrismaBulkReadClient(
			app.prisma,
			(prisma) => loadPlexSectionCatalog(prisma, { userId }),
			{ lease: "phase" },
		);
		if (!catalog.available) {
			return reply.status(503).send({
				error: "Plex cache evidence is unavailable",
				...catalog.response,
			});
		}
		return reply.send(catalog.response);
	});
}
