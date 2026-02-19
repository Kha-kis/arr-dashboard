/**
 * Seerr Notification Routes
 *
 * Endpoints for viewing, updating, and testing notification agents.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { requireInstance } from "../../lib/arr/instance-helpers.js";
import { createSeerrClient } from "../../lib/seerr/seerr-client.js";
import { validateRequest } from "../../lib/utils/validate.js";

const instanceIdParams = z.object({ instanceId: z.string().min(1) });
const agentParams = z.object({ instanceId: z.string().min(1), agentId: z.string().min(1) });

const updateNotificationBody = z.object({
	enabled: z.boolean().optional(),
	types: z.number().int().optional(),
	options: z.record(z.string(), z.unknown()).optional(),
});

export async function registerNotificationRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	// GET /api/seerr/notifications/:instanceId — All notification agents
	app.get("/:instanceId", async (request, reply) => {
		const { instanceId } = validateRequest(instanceIdParams, request.params);
		const instance = await requireInstance(app, request.currentUser!.id, instanceId);
		if (instance.service !== "SEERR") {
			return reply.status(400).send({ error: "Instance is not a Seerr service" });
		}
		const client = createSeerrClient(app.arrClientFactory, instance);
		const agents = await client.getNotificationAgents();
		return reply.send({ agents });
	});

	// POST /api/seerr/notifications/:instanceId/:agentId — Update notification config
	app.post("/:instanceId/:agentId", async (request, reply) => {
		const { instanceId, agentId } = validateRequest(agentParams, request.params);
		const body = validateRequest(updateNotificationBody, request.body);
		const instance = await requireInstance(app, request.currentUser!.id, instanceId);
		if (instance.service !== "SEERR") {
			return reply.status(400).send({ error: "Instance is not a Seerr service" });
		}
		const client = createSeerrClient(app.arrClientFactory, instance);
		const agent = await client.updateNotificationAgent(agentId, body);
		return reply.send(agent);
	});

	// POST /api/seerr/notifications/:instanceId/:agentId/test — Test notification
	app.post("/:instanceId/:agentId/test", async (request, reply) => {
		const { instanceId, agentId } = validateRequest(agentParams, request.params);
		const instance = await requireInstance(app, request.currentUser!.id, instanceId);
		if (instance.service !== "SEERR") {
			return reply.status(400).send({ error: "Instance is not a Seerr service" });
		}
		const client = createSeerrClient(app.arrClientFactory, instance);
		const result = await client.testNotificationAgent(agentId);
		return reply.send(result);
	});
}
