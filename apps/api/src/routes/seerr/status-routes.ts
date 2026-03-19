/**
 * Seerr Status Routes
 *
 * Endpoints for health check, version info, and audit log.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { requireSeerrClient } from "../../lib/seerr/seerr-client.js";
import { safeJsonParse } from "../../lib/utils/json.js";
import { validateRequest } from "../../lib/utils/validate.js";

const instanceIdParams = z.object({ instanceId: z.string().min(1) });

const auditLogQuery = z.object({
	limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function registerStatusRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	// GET /api/seerr/status/:instanceId — Health + version + stats
	app.get("/:instanceId", async (request) => {
		const { instanceId } = validateRequest(instanceIdParams, request.params);
		const client = await requireSeerrClient(app, request.currentUser!.id, instanceId);
		return client.getStatus();
	});

	// GET /api/seerr/status/:instanceId/health — Cached health status from scheduler
	app.get("/:instanceId/health", async (request, reply) => {
		const { instanceId } = validateRequest(instanceIdParams, request.params);
		// Verify the instance belongs to the current user
		await requireSeerrClient(app, request.currentUser!.id, instanceId);

		const record = await app.prisma.cacheRefreshStatus.findUnique({
			where: {
				instanceId_cacheType: {
					instanceId,
					cacheType: "seerr_health",
				},
			},
		});

		if (!record) {
			return reply.send({
				status: "unknown",
				lastCheckedAt: null,
				error: null,
			});
		}

		return reply.send({
			status: record.lastResult === "success" ? "healthy" : "error",
			lastCheckedAt: record.lastRefreshedAt.toISOString(),
			error: record.lastErrorMessage,
		});
	});

	// POST /api/seerr/status/:instanceId/cache/clear — Manually clear cached data for this instance
	app.post("/:instanceId/cache/clear", async (request) => {
		const { instanceId } = validateRequest(instanceIdParams, request.params);
		// Verify the instance exists and belongs to the user
		await requireSeerrClient(app, request.currentUser!.id, instanceId);
		const cleared = app.seerrCache.invalidateInstance(instanceId);
		return { cleared };
	});

	// GET /api/seerr/status/:instanceId/audit — Recent action log entries
	app.get("/:instanceId/audit", async (request) => {
		const { instanceId } = validateRequest(instanceIdParams, request.params);
		const { limit } = validateRequest(auditLogQuery, request.query);
		// Verify the instance belongs to the current user
		await requireSeerrClient(app, request.currentUser!.id, instanceId);

		const logs = await app.prisma.seerrActionLog.findMany({
			where: { instanceId, userId: request.currentUser!.id },
			orderBy: { createdAt: "desc" },
			take: limit,
		});

		return logs.map((log) => ({
			id: log.id,
			action: log.action,
			targetType: log.targetType,
			targetId: log.targetId,
			detail: log.detail ? safeJsonParse(log.detail) : null,
			success: log.success,
			createdAt: log.createdAt.toISOString(),
		}));
	});
}
