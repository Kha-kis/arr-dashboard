/**
 * Jellyfin Library Scan Routes
 *
 * Triggers a Jellyfin library rescan. Useful after ARR imports to refresh metadata.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { requireJellyfinClient } from "../../lib/jellyfin/jellyfin-helpers.js";
import { validateRequest } from "../../lib/utils/validate.js";

const scanParams = z.object({
	instanceId: z.string().min(1),
});

export async function registerScanRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * POST /api/jellyfin/:instanceId/refresh
	 *
	 * Triggers a full library scan on the specified Jellyfin instance.
	 */
	app.post("/:instanceId/refresh", async (request, reply) => {
		const { instanceId } = validateRequest(scanParams, request.params);
		const userId = request.currentUser!.id;

		const { client } = await requireJellyfinClient(app, userId, instanceId);

		await client.refreshLibrary();

		return reply.send({
			success: true,
			message: "Library scan triggered",
		});
	});
}
