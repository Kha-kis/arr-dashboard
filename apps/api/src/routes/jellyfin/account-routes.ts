/**
 * Jellyfin Account Routes
 *
 * Returns deduplicated list of Jellyfin user accounts across all instances.
 * Used for the "Watched by" filter in the library view.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { executeOnJellyfinInstances } from "../../lib/jellyfin/jellyfin-helpers.js";

export async function registerAccountRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * GET /api/jellyfin/accounts
	 *
	 * Returns all unique Jellyfin usernames across the user's instances.
	 */
	app.get("/", async (request, reply) => {
		const userId = request.currentUser!.id;

		const result = await executeOnJellyfinInstances(app, userId, async (client) => {
			const users = await client.getUsers();
			return users.map((u) => u.name);
		});

		// Deduplicate usernames across instances
		const uniqueUsers = [...new Set(result.aggregated)].sort();
		return reply.send({ users: uniqueUsers });
	});
}
