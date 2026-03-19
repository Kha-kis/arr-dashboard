/**
 * Plex Account Routes
 *
 * Returns deduplicated list of Plex user accounts across all instances.
 * Used for the "Watched by" filter in the library view.
 */

import type { PlexAccountsResponse } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { executeOnPlexInstances } from "../../lib/plex/plex-helpers.js";
import { deduplicateAccounts } from "./lib/account-helpers.js";

export async function registerAccountRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * GET /api/plex/accounts
	 *
	 * Returns all unique Plex user names across the user's instances.
	 */
	app.get("/", async (request, reply) => {
		const userId = request.currentUser!.id;

		const result = await executeOnPlexInstances(app, userId, async (client) => {
			const accounts = await client.getAccounts();
			return accounts.map((a) => a.name);
		});

		const users = deduplicateAccounts(result.aggregated);
		const response: PlexAccountsResponse = { users };
		return reply.send(response);
	});
}
