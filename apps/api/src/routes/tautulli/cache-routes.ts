/**
 * Tautulli Cache Observability Routes
 *
 * Exposes sync status and manual refresh for Tautulli integration cache.
 * Enables users to see when data was last synced and trigger a refresh.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { recordWatchProviderCacheRefreshFailure } from "../../lib/services/provider-cache-status.js";
import {
	createOwnedTautulliPublicationSnapshot,
	refreshTautulliCache,
} from "../../lib/tautulli/tautulli-cache-refresher.js";
import { requireTautulliClient } from "../../lib/tautulli/tautulli-helpers.js";
import { getErrorMessage } from "../../lib/utils/error-message.js";
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

			const { instance } = await requireTautulliClient(app, userId, instanceId);
			const publicationInstance = createOwnedTautulliPublicationSnapshot(app.encryptor, instance);

			try {
				const result = await refreshTautulliCache({
					prisma: app.prisma,
					instance: publicationInstance,
					log: request.log,
				});
				if ((!result.complete || !result.completedAt) && !result.superseded) {
					await recordWatchProviderCacheRefreshFailure(
						app.prisma,
						"tautulli",
						result.errorMessages.slice(0, 3).join("; ").slice(0, 200) ||
							"Tautulli refresh did not publish a complete generation",
						publicationInstance,
						request.log,
					);
				}

				return reply.send({
					success: result.complete && Boolean(result.completedAt),
					upserted: result.upserted,
					errors: result.errors,
				});
			} catch (err) {
				await recordWatchProviderCacheRefreshFailure(
					app.prisma,
					"tautulli",
					getErrorMessage(err, "Unknown error"),
					publicationInstance,
					request.log,
				);
				throw err;
			}
		},
	);
}
