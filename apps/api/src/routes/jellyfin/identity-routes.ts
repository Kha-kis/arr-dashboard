/**
 * Jellyfin Server Identity Routes
 *
 * Returns server identity info (version, platform, server name) from live Jellyfin API.
 * Aggregates across all user's Jellyfin instances.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { executeOnJellyfinInstances } from "../../lib/jellyfin/jellyfin-helpers.js";

export async function registerIdentityRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * GET /api/jellyfin/identity
	 *
	 * Returns server identity for each of the user's Jellyfin instances.
	 */
	app.get("/", async (request, reply) => {
		const userId = request.currentUser!.id;

		const result = await executeOnJellyfinInstances(app, userId, async (client, instance) => {
			const info = await client.getServerInfo();
			return {
				instanceId: instance.id,
				instanceName: instance.label,
				serverId: info.id,
				version: info.version,
				serverName: info.serverName,
				operatingSystem: info.operatingSystem,
			};
		});

		return reply.send(result.aggregated);
	});
}
