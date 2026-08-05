/**
 * Jellyfin Cache Observability Routes
 *
 * Exposes sync status and manual refresh for Jellyfin integration cache.
 * Enables users to see when data was last synced and trigger a refresh.
 */

import type { CacheHealthResponse } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { refreshJellyfinCache } from "../../lib/jellyfin/jellyfin-cache-refresher.js";
import { runJellyfinCacheRefreshSingleFlight } from "../../lib/jellyfin/jellyfin-cache-singleflight.js";
import { requireJellyfinClient } from "../../lib/jellyfin/jellyfin-helpers.js";
import { validateRequest } from "../../lib/utils/validate.js";
import { buildCacheHealthItems } from "../plex/lib/cache-health-helpers.js";

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
			where: { userId, service: { in: ["JELLYFIN", "EMBY"] }, enabled: true },
			select: { id: true, label: true },
		});

		if (instances.length === 0) {
			const response: CacheHealthResponse = { items: [] };
			return reply.send(response);
		}

		const instanceIds = instances.map((i) => i.id);
		const instanceMap = new Map(instances.map((i) => [i.id, i.label]));

		const statuses = await app.prisma.cacheRefreshStatus.findMany({
			where: {
				instanceId: { in: instanceIds },
				cacheType: { in: ["jellyfin", "jellyfin_episode"] },
			},
		});

		const items = buildCacheHealthItems(statuses, instanceMap);
		const response: CacheHealthResponse = { items };
		return reply.send(response);
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

			const result = await runJellyfinCacheRefreshSingleFlight(
				instanceId,
				() => refreshJellyfinCache(client, app.prisma, instanceId, request.log),
				{ prisma: app.prisma, log: request.log },
			);

			return reply.send({
				success: result.complete && Boolean(result.completedAt),
				upserted: result.upserted,
				errors: result.errors,
			});
		},
	);
}
