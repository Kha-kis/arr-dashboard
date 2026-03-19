/**
 * Plex Server Identity Routes
 *
 * Returns server identity info (version, platform, friendly name) from live Plex API.
 * Aggregates across all user's Plex instances.
 */

import type { PlexIdentityResponse, PlexServerIdentity } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { executeOnPlexInstances } from "../../lib/plex/plex-helpers.js";

export async function registerIdentityRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * GET /api/plex/identity
	 *
	 * Returns server identity for each of the user's Plex instances.
	 */
	app.get("/", async (request, reply) => {
		const userId = request.currentUser!.id;

		const result = await executeOnPlexInstances(app, userId, async (client, instance) => {
			const identity = await client.getServerInfo();
			return {
				instanceId: instance.id,
				instanceName: instance.label,
				machineId: identity.machineIdentifier,
				version: identity.version,
				friendlyName: identity.friendlyName,
				platform: identity.platform,
			} satisfies PlexServerIdentity;
		});

		const servers: PlexServerIdentity[] = result.aggregated;
		const response: PlexIdentityResponse = { servers };
		return reply.send(response);
	});
}
