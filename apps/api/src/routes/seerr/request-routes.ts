/**
 * Seerr Request Routes
 *
 * Endpoints for managing media requests: list, approve, decline, delete, retry.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { requireSeerrClient } from "../../lib/seerr/seerr-client.js";
import { validateRequest } from "../../lib/utils/validate.js";

const instanceIdParams = z.object({ instanceId: z.string().min(1) });
const requestIdParams = z.object({
	instanceId: z.string().min(1),
	requestId: z.coerce.number().int().positive(),
});

const listRequestsQuery = z.object({
	take: z.coerce.number().int().min(1).max(100).default(20),
	skip: z.coerce.number().int().min(0).default(0),
	filter: z
		.enum(["all", "approved", "available", "pending", "processing", "unavailable", "failed"])
		.default("all"),
	sort: z.enum(["added", "modified"]).default("added"),
	requestedBy: z.coerce.number().int().positive().optional(),
});

export async function registerRequestRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	// GET /api/seerr/requests/:instanceId — List requests (paginated)
	app.get("/:instanceId", async (request) => {
		const { instanceId } = validateRequest(instanceIdParams, request.params);
		const query = validateRequest(listRequestsQuery, request.query);
		const client = await requireSeerrClient(app, request.currentUser!.id, instanceId);
		const result = await client.getRequests(query);
		return client.enrichRequestsWithMedia(result);
	});

	// GET /api/seerr/requests/:instanceId/count — Aggregated counts
	app.get("/:instanceId/count", async (request) => {
		const { instanceId } = validateRequest(instanceIdParams, request.params);
		const client = await requireSeerrClient(app, request.currentUser!.id, instanceId);
		return client.getRequestCount();
	});

	// POST /api/seerr/requests/:instanceId/:requestId/approve
	app.post("/:instanceId/:requestId/approve", async (request) => {
		const { instanceId, requestId } = validateRequest(requestIdParams, request.params);
		const client = await requireSeerrClient(app, request.currentUser!.id, instanceId);
		return client.approveRequest(requestId);
	});

	// POST /api/seerr/requests/:instanceId/:requestId/decline
	app.post("/:instanceId/:requestId/decline", async (request) => {
		const { instanceId, requestId } = validateRequest(requestIdParams, request.params);
		const client = await requireSeerrClient(app, request.currentUser!.id, instanceId);
		return client.declineRequest(requestId);
	});

	// DELETE /api/seerr/requests/:instanceId/:requestId
	app.delete("/:instanceId/:requestId", async (request, reply) => {
		const { instanceId, requestId } = validateRequest(requestIdParams, request.params);
		const client = await requireSeerrClient(app, request.currentUser!.id, instanceId);
		await client.deleteRequest(requestId);
		return reply.status(204).send();
	});

	// POST /api/seerr/requests/:instanceId/:requestId/retry
	app.post("/:instanceId/:requestId/retry", async (request) => {
		const { instanceId, requestId } = validateRequest(requestIdParams, request.params);
		const client = await requireSeerrClient(app, request.currentUser!.id, instanceId);
		return client.retryRequest(requestId);
	});
}
