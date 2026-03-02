/**
 * Tautulli Cache Observability Routes
 *
 * Exposes sync status and manual refresh for Tautulli integration cache.
 * Enables users to see when data was last synced and trigger a refresh.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { requireTautulliClient } from "../../lib/tautulli/tautulli-helpers.js";
import { refreshTautulliCache } from "../../lib/tautulli/tautulli-cache-refresher.js";
import { validateRequest } from "../../lib/utils/validate.js";

const instanceParams = z.object({
	instanceId: z.string().min(1),
});

export async function registerCacheRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * GET /api/tautulli/cache/:instanceId/status
	 *
	 * Returns sync status for a Tautulli instance's cache:
	 * - total cached items
	 */
	app.get("/cache/:instanceId/status", async (request, reply) => {
		const { instanceId } = validateRequest(instanceParams, request.params);
		const userId = request.currentUser!.id;

		// Verify ownership
		await requireTautulliClient(app, userId, instanceId);

		const count = await app.prisma.tautulliCache.count({ where: { instanceId } });

		return reply.send({
			instanceId,
			cachedItems: count,
			hasCacheData: count > 0,
		});
	});

	/**
	 * POST /api/tautulli/cache/:instanceId/refresh
	 *
	 * Triggers a manual cache refresh for the specified Tautulli instance.
	 * Rate limited to prevent abuse.
	 */
	app.post(
		"/cache/:instanceId/refresh",
		{ config: { rateLimit: { max: 2, timeWindow: "5m" } } },
		async (request, reply) => {
			const { instanceId } = validateRequest(instanceParams, request.params);
			const userId = request.currentUser!.id;

			const { client } = await requireTautulliClient(app, userId, instanceId);

			const result = await refreshTautulliCache(
				client,
				app.prisma,
				instanceId,
				request.log,
			);

			return reply.send({
				success: true,
				upserted: result.upserted,
				errors: result.errors,
			});
		},
	);
}
