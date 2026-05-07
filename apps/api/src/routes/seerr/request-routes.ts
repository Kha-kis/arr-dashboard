/**
 * Seerr Request Routes
 *
 * Endpoints for managing media requests: list, approve, decline, delete, retry.
 */

import type { SeerrAttentionItem } from "@arr/shared";
import { SEERR_MEDIA_STATUS, SEERR_REQUEST_STATUS } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { logSeerrAction } from "../../lib/seerr/seerr-action-logger.js";
import { requireSeerrClient } from "../../lib/seerr/seerr-client.js";
import { getErrorMessage } from "../../lib/utils/error-message.js";
import { validateRequest } from "../../lib/utils/validate.js";

/** Requests approved but still processing after this threshold are flagged as stuck */
const STUCK_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48 hours
/** Maximum attention items returned (dashboard signal, not a list page) */
const ATTENTION_LIMIT = 10;

const instanceIdParams = z.object({ instanceId: z.string().min(1) });
const bulkActionBody = z.object({
	action: z.enum(["approve", "decline", "delete"]),
	requestIds: z.array(z.coerce.number().int().positive()).min(1).max(50),
});
const requestIdParams = z.object({
	instanceId: z.string().min(1),
	requestId: z.coerce.number().int().positive(),
});

/**
 * Optional admin overrides applied via PUT before approval.
 * Empty/undefined = approve without modifying the request.
 *
 * `mediaType` is required by Jellyseerr's PUT endpoint, but we accept it as
 * optional here and re-fetch the request when needed so the client doesn't
 * have to send it for a plain approve.
 */
const approveBody = z
	.object({
		serverId: z.number().int().nonnegative().optional(),
		profileId: z.number().int().positive().optional(),
		rootFolder: z.string().min(1).optional(),
		languageProfileId: z.number().int().positive().optional(),
		tags: z.array(z.number().int().nonnegative()).optional(),
		userId: z.number().int().positive().optional(),
	})
	.optional();

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

	// GET /api/seerr/requests/:instanceId/attention — Requests needing admin intervention
	app.get("/:instanceId/attention", async (request) => {
		const { instanceId } = validateRequest(instanceIdParams, request.params);
		const client = await requireSeerrClient(app, request.currentUser!.id, instanceId);
		const now = Date.now();

		// Fetch failed and processing requests in parallel (graceful degradation)
		const [failedResult, processingResult] = await Promise.allSettled([
			client.getRequests({ filter: "failed", take: ATTENTION_LIMIT, sort: "modified" }),
			client.getRequests({ filter: "processing", take: 50, sort: "modified" }),
		]);

		const allItems: SeerrAttentionItem[] = [];

		// All failed requests need attention
		if (failedResult.status === "fulfilled") {
			for (const req of failedResult.value.results) {
				allItems.push({
					request: req,
					reason: "failed",
					ageMs: now - new Date(req.updatedAt).getTime(),
				});
			}
		}

		// Processing requests are only "stuck" if approved + still processing + older than threshold
		if (processingResult.status === "fulfilled") {
			for (const req of processingResult.value.results) {
				if (
					req.status === SEERR_REQUEST_STATUS.APPROVED &&
					req.media.status === SEERR_MEDIA_STATUS.PROCESSING
				) {
					const ageMs = now - new Date(req.updatedAt).getTime();
					if (ageMs >= STUCK_THRESHOLD_MS) {
						allItems.push({ request: req, reason: "stuck", ageMs });
					}
				}
			}
		}

		const total = allItems.length;
		const items = allItems.slice(0, ATTENTION_LIMIT);

		// Enrich with media metadata (posters, titles)
		if (items.length > 0) {
			const enriched = await client.enrichRequestsWithMedia({
				pageInfo: { pages: 1, pageSize: items.length, results: items.length, page: 1 },
				results: items.map((i) => i.request),
			});
			for (let idx = 0; idx < items.length; idx++) {
				items[idx]!.request = enriched.results[idx]!;
			}
		}

		return { items, total };
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
	// Optional body: { serverId?, profileId?, rootFolder?, languageProfileId?, tags?, userId? }
	// When any override field is present, the request is updated (PUT) before approval —
	// useful for admins who want to send a request to a non-default quality profile.
	app.post("/:instanceId/:requestId/approve", async (request) => {
		const { instanceId, requestId } = validateRequest(requestIdParams, request.params);
		const overrides = validateRequest(approveBody, request.body ?? undefined);
		const userId = request.currentUser!.id;
		const client = await requireSeerrClient(app, userId, instanceId);

		const hasOverrides =
			!!overrides &&
			(overrides.serverId !== undefined ||
				overrides.profileId !== undefined ||
				overrides.rootFolder !== undefined ||
				overrides.languageProfileId !== undefined ||
				overrides.tags !== undefined ||
				overrides.userId !== undefined);

		try {
			if (hasOverrides) {
				// Jellyseerr PUT requires mediaType — fetch the request to learn it.
				const existing = await client.getRequest(requestId);
				await client.updateRequest(requestId, {
					mediaType: existing.type,
					...overrides,
				});
			}
			const result = await client.approveRequest(requestId);
			logSeerrAction(app, request.log, {
				instanceId,
				userId,
				action: "approve_request",
				targetType: "request",
				targetId: String(requestId),
				detail: hasOverrides ? { overridden: true, ...overrides } : undefined,
			});
			return result;
		} catch (err) {
			logSeerrAction(app, request.log, {
				instanceId,
				userId,
				action: "approve_request",
				targetType: "request",
				targetId: String(requestId),
				success: false,
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
				instanceId,
				userId,
				action: "decline_request",
				targetType: "request",
				targetId: String(requestId),
			});
			return result;
		} catch (err) {
			logSeerrAction(app, request.log, {
				instanceId,
				userId,
				action: "decline_request",
				targetType: "request",
				targetId: String(requestId),
				success: false,
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
				instanceId,
				userId,
				action: "delete_request",
				targetType: "request",
				targetId: String(requestId),
			});
			return reply.status(204).send();
		} catch (err) {
			logSeerrAction(app, request.log, {
				instanceId,
				userId,
				action: "delete_request",
				targetType: "request",
				targetId: String(requestId),
				success: false,
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
				instanceId,
				userId,
				action: "retry_request",
				targetType: "request",
				targetId: String(requestId),
			});
			return result;
		} catch (err) {
			logSeerrAction(app, request.log, {
				instanceId,
				userId,
				action: "retry_request",
				targetType: "request",
				targetId: String(requestId),
				success: false,
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
					instanceId,
					userId,
					action: `bulk_${action}_request`,
					targetType: "request",
					targetId: String(reqId),
				});
				results.push({ requestId: reqId, success: true });
			} catch (err) {
				const errorMessage = getErrorMessage(err, "Unknown error");
				logSeerrAction(app, request.log, {
					instanceId,
					userId,
					action: `bulk_${action}_request`,
					targetType: "request",
					targetId: String(reqId),
					success: false,
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
