/**
 * Seerr Status Routes
 *
 * Endpoint for health check and version info.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { requireSeerrClient } from "../../lib/seerr/seerr-client.js";
import { validateRequest } from "../../lib/utils/validate.js";

const instanceIdParams = z.object({ instanceId: z.string().min(1) });

export async function registerStatusRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	// GET /api/seerr/status/:instanceId — Health + version + stats
	app.get("/:instanceId", async (request) => {
		const { instanceId } = validateRequest(instanceIdParams, request.params);
		const client = await requireSeerrClient(app, request.currentUser!.id, instanceId);
		return client.getStatus();
	});
}
