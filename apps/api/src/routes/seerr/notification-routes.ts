/**
 * Seerr Notification Routes
 *
 * Endpoints for viewing, updating, and testing notification agents.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { requireSeerrClient, KNOWN_NOTIFICATION_AGENT_IDS } from "../../lib/seerr/seerr-client.js";
import { validateRequest } from "../../lib/utils/validate.js";

const instanceIdParams = z.object({ instanceId: z.string().min(1) });
const agentParams = z.object({
	instanceId: z.string().min(1),
	agentId: z.enum(KNOWN_NOTIFICATION_AGENT_IDS),
});

const updateNotificationBody = z.object({
	enabled: z.boolean().optional(),
	types: z.number().int().optional(),
	options: z.record(z.string(), z.unknown()).optional(),
});

export async function registerNotificationRoutes(
	app: FastifyInstance,
	_opts: FastifyPluginOptions,
) {
	// GET /api/seerr/notifications/:instanceId — All notification agents
	app.get("/:instanceId", async (request) => {
		const { instanceId } = validateRequest(instanceIdParams, request.params);
		const client = await requireSeerrClient(app, request.currentUser!.id, instanceId);
		const agents = await client.getNotificationAgents();
		return { agents };
	});

	// POST /api/seerr/notifications/:instanceId/:agentId — Update notification config
	app.post("/:instanceId/:agentId", async (request) => {
		const { instanceId, agentId } = validateRequest(agentParams, request.params);
		const body = validateRequest(updateNotificationBody, request.body);
		const client = await requireSeerrClient(app, request.currentUser!.id, instanceId);
		return client.updateNotificationAgent(agentId, body);
	});

	// POST /api/seerr/notifications/:instanceId/:agentId/test — Test notification
	app.post("/:instanceId/:agentId/test", async (request, reply) => {
		const { instanceId, agentId } = validateRequest(agentParams, request.params);
		const client = await requireSeerrClient(app, request.currentUser!.id, instanceId);
		await client.testNotificationAgent(agentId);
		return reply.status(204).send();
	});
}
