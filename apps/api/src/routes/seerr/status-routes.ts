/**
 * Seerr Status Routes
 *
 * Endpoint for health check and version info.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { requireInstance } from "../../lib/arr/instance-helpers.js";
import { createSeerrClient } from "../../lib/seerr/seerr-client.js";
import { validateRequest } from "../../lib/utils/validate.js";

const instanceIdParams = z.object({ instanceId: z.string().min(1) });

export async function registerStatusRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	// GET /api/seerr/status/:instanceId — Health + version + stats
	app.get("/:instanceId", async (request, reply) => {
		const { instanceId } = validateRequest(instanceIdParams, request.params);
		const instance = await requireInstance(app, request.currentUser!.id, instanceId);
		if (instance.service !== "SEERR") {
			return reply.status(400).send({ error: "Instance is not a Seerr service" });
		}
		const client = createSeerrClient(app.arrClientFactory, instance);
		const status = await client.getStatus();
		return reply.send(status);
	});
}
