/**
 * Jellyfin Cache Observability Routes
 *
 * Exposes sync status and manual refresh for Jellyfin integration cache.
 * Enables users to see when data was last synced and trigger a refresh.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { requireJellyfinClient } from "../../lib/jellyfin/jellyfin-helpers.js";
import { refreshJellyfinCache } from "../../lib/jellyfin/jellyfin-cache-refresher.js";
import { getErrorMessage } from "../../lib/utils/error-message.js";
import { validateRequest } from "../../lib/utils/validate.js";

const instanceParams = z.object({
	instanceId: z.string().min(1),
});

export async function registerCacheRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * GET /api/jellyfin/cache/health
	 *
	 * Returns cache refresh status for all of the user's Jellyfin instances.
	 */
	app.get("/cache/health", async (request, reply) => {
		const userId = request.currentUser!.id;

		const instances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: "JELLYFIN", enabled: true },
			select: { id: true, label: true },
		});

		if (instances.length === 0) {
			return reply.send({ items: [] });
		}

		const instanceIds = instances.map((i) => i.id);
		const instanceMap = new Map(instances.map((i) => [i.id, i.label]));

		const statuses = await app.prisma.cacheRefreshStatus.findMany({
			where: {
				instanceId: { in: instanceIds },
				cacheType: { in: ["jellyfin", "jellyfin_episode"] },
			},
		});

		const now = Date.now();
		const STALE_THRESHOLD_MS = 12 * 60 * 60 * 1000; // 12 hours

		const items = statuses.map((s) => ({
			instanceId: s.instanceId,
			instanceName: instanceMap.get(s.instanceId) ?? s.instanceId,
			cacheType: s.cacheType,
			lastRefreshedAt: s.lastRefreshedAt?.toISOString() ?? null,
			lastResult: s.lastResult,
			lastErrorMessage: s.lastErrorMessage,
			itemCount: s.itemCount,
			isStale: s.lastRefreshedAt ? now - s.lastRefreshedAt.getTime() > STALE_THRESHOLD_MS : true,
		}));

		return reply.send({ items });
	});

	/**
	 * POST /api/jellyfin/cache/:instanceId/refresh
	 *
	 * Triggers a manual cache refresh for the specified Jellyfin instance.
	 * Rate limited to prevent abuse.
	 */
	app.post(
		"/cache/:instanceId/refresh",
		{ config: { rateLimit: { max: 2, timeWindow: "5m" } } },
		async (request, reply) => {
			const { instanceId } = validateRequest(instanceParams, request.params);
			const userId = request.currentUser!.id;

			const { client } = await requireJellyfinClient(app, userId, instanceId);

			try {
				const result = await refreshJellyfinCache(client, app.prisma, instanceId, request.log);

				await app.prisma.cacheRefreshStatus
					.upsert({
						where: { instanceId_cacheType: { instanceId, cacheType: "jellyfin" } },
						create: {
							instanceId,
							cacheType: "jellyfin",
							lastRefreshedAt: new Date(),
							lastResult: result.errors > 0 ? "error" : "success",
							lastErrorMessage:
								result.errorMessages.length > 0
									? result.errorMessages.slice(0, 3).join("; ").slice(0, 200)
									: null,
							itemCount: result.upserted,
						},
						update: {
							lastRefreshedAt: new Date(),
							lastResult: result.errors > 0 ? "error" : "success",
							lastErrorMessage:
								result.errorMessages.length > 0
									? result.errorMessages.slice(0, 3).join("; ").slice(0, 200)
									: null,
							itemCount: result.upserted,
						},
					})
					.catch((trackErr) => {
						request.log.warn(
							{ err: trackErr, instanceId },
							"Cache refreshed but failed to record status",
						);
					});

				return reply.send({
					success: true,
					upserted: result.upserted,
					errors: result.errors,
				});
			} catch (err) {
				await app.prisma.cacheRefreshStatus
					.upsert({
						where: { instanceId_cacheType: { instanceId, cacheType: "jellyfin" } },
						create: {
							instanceId,
							cacheType: "jellyfin",
							lastRefreshedAt: new Date(),
							lastResult: "error",
							lastErrorMessage: getErrorMessage(err, "Unknown error"),
							itemCount: 0,
						},
						update: {
							lastRefreshedAt: new Date(),
							lastResult: "error",
							lastErrorMessage: getErrorMessage(err, "Unknown error"),
						},
					})
					.catch(() => {});

				throw err;
			}
		},
	);
}
