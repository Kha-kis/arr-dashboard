/**
 * Plex Library Scan Routes
 *
 * Triggers a Plex library section rescan. Useful after ARR imports to refresh Plex metadata.
 */

import type { PlexScanResponse } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { requirePlexClient } from "../../lib/plex/plex-helpers.js";
import { validateRequest } from "../../lib/utils/validate.js";

const scanParams = z.object({
	instanceId: z.string().min(1),
	sectionId: z.string().min(1).regex(/^\d+$/, "sectionId must be numeric"),
});

export async function registerScanRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * POST /api/plex/:instanceId/sections/:sectionId/refresh
	 *
	 * Triggers a library section scan on the specified Plex instance.
	 */
	app.post("/:instanceId/sections/:sectionId/refresh", async (request, reply) => {
		const { instanceId, sectionId } = validateRequest(scanParams, request.params);
		const userId = request.currentUser!.id;

		const { client } = await requirePlexClient(app, userId, instanceId);

		await client.request(`/library/sections/${encodeURIComponent(sectionId)}/refresh`, {
			method: "POST",
		});

		const response: PlexScanResponse = {
			success: true,
			message: `Library scan triggered for section ${sectionId}`,
		};
		return reply.send(response);
	});
}
