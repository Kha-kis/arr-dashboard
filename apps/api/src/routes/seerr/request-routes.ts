/**
 * Seerr Request Routes
 *
 * Endpoints for managing media requests: list, approve, decline, delete, retry.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { logSeerrAction } from "../../lib/seerr/seerr-action-logger.js";
import { requireSeerrClient } from "../../lib/seerr/seerr-client.js";
import { getErrorMessage } from "../../lib/utils/error-message.js";
import { validateRequest } from "../../lib/utils/validate.js";

const instanceIdParams = z.object({ instanceId: z.string().min(1) });
const bulkActionBody = z.object({
	action: z.enum(["approve", "decline", "delete"]),
	requestIds: z.array(z.coerce.number().int().positive()).min(1).max(50),
});
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

	// GET /api/seerr/requests/:instanceId/:requestId — Single request (enriched)
	app.get("/:instanceId/:requestId", async (request) => {
		const { instanceId, requestId } = validateRequest(requestIdParams, request.params);
		const client = await requireSeerrClient(app, request.currentUser!.id, instanceId);
		const seerrRequest = await client.getRequest(requestId);
		const enriched = await client.enrichRequestsWithMedia({
			pageInfo: { pages: 1, pageSize: 1, results: 1, page: 1 },
			results: [seerrRequest],
		});
		return enriched.results[0];
	});

	// POST /api/seerr/requests/:instanceId/:requestId/approve
	app.post("/:instanceId/:requestId/approve", async (request) => {
		const { instanceId, requestId } = validateRequest(requestIdParams, request.params);
		const userId = request.currentUser!.id;
		const client = await requireSeerrClient(app, userId, instanceId);
		try {
			const result = await client.approveRequest(requestId);
			logSeerrAction(app, request.log, {
				instanceId, userId, action: "approve_request",
				targetType: "request", targetId: String(requestId),
			});
			return result;
		} catch (err) {
			logSeerrAction(app, request.log, {
				instanceId, userId, action: "approve_request",
				targetType: "request", targetId: String(requestId), success: false,
			});
			throw err;
		}
	});

	// POST /api/seerr/requests/:instanceId/:requestId/decline
	app.post("/:instanceId/:requestId/decline", async (request) => {
		const { instanceId, requestId } = validateRequest(requestIdParams, request.params);
		const userId = request.currentUser!.id;
		const client = await requireSeerrClient(app, userId, instanceId);
		try {
			const result = await client.declineRequest(requestId);
			logSeerrAction(app, request.log, {
				instanceId, userId, action: "decline_request",
				targetType: "request", targetId: String(requestId),
			});
			return result;
		} catch (err) {
			logSeerrAction(app, request.log, {
				instanceId, userId, action: "decline_request",
				targetType: "request", targetId: String(requestId), success: false,
			});
			throw err;
		}
	});

	// DELETE /api/seerr/requests/:instanceId/:requestId
	app.delete("/:instanceId/:requestId", async (request, reply) => {
		const { instanceId, requestId } = validateRequest(requestIdParams, request.params);
		const userId = request.currentUser!.id;
		const client = await requireSeerrClient(app, userId, instanceId);
		try {
			await client.deleteRequest(requestId);
			logSeerrAction(app, request.log, {
				instanceId, userId, action: "delete_request",
				targetType: "request", targetId: String(requestId),
			});
			return reply.status(204).send();
		} catch (err) {
			logSeerrAction(app, request.log, {
				instanceId, userId, action: "delete_request",
				targetType: "request", targetId: String(requestId), success: false,
			});
			throw err;
		}
	});

	// POST /api/seerr/requests/:instanceId/:requestId/retry
	app.post("/:instanceId/:requestId/retry", async (request) => {
		const { instanceId, requestId } = validateRequest(requestIdParams, request.params);
		const userId = request.currentUser!.id;
		const client = await requireSeerrClient(app, userId, instanceId);
		try {
			const result = await client.retryRequest(requestId);
			logSeerrAction(app, request.log, {
				instanceId, userId, action: "retry_request",
				targetType: "request", targetId: String(requestId),
			});
			return result;
		} catch (err) {
			logSeerrAction(app, request.log, {
				instanceId, userId, action: "retry_request",
				targetType: "request", targetId: String(requestId), success: false,
			});
			throw err;
		}
	});

	// POST /api/seerr/requests/:instanceId/bulk — Bulk approve/decline/delete
	app.post("/:instanceId/bulk", async (request, reply) => {
		const { instanceId } = validateRequest(instanceIdParams, request.params);
		const { action, requestIds } = validateRequest(bulkActionBody, request.body);
		const userId = request.currentUser!.id;
		const client = await requireSeerrClient(app, userId, instanceId);

		const results: { requestId: number; success: boolean; error?: string }[] = [];
		for (const reqId of requestIds) {
			try {
				if (action === "approve") {
					await client.approveRequest(reqId);
				} else if (action === "decline") {
					await client.declineRequest(reqId);
				} else {
					await client.deleteRequest(reqId);
				}
				logSeerrAction(app, request.log, {
					instanceId, userId, action: `bulk_${action}_request`,
					targetType: "request", targetId: String(reqId),
				});
				results.push({ requestId: reqId, success: true });
			} catch (err) {
				const errorMessage = getErrorMessage(err, "Unknown error");
				logSeerrAction(app, request.log, {
					instanceId, userId, action: `bulk_${action}_request`,
					targetType: "request", targetId: String(reqId), success: false,
				});
				results.push({ requestId: reqId, success: false, error: errorMessage });
			}
		}

		const totalSuccess = results.filter((r) => r.success).length;
		const totalFailed = results.length - totalSuccess;
		const body = { results, totalSuccess, totalFailed };

		// Return appropriate status code based on outcome
		if (totalSuccess === 0 && results.length > 0) {
			return reply.status(502).send(body);
		}
		if (totalFailed > 0) {
			return reply.status(207).send(body);
		}
		return body;
	});
}
