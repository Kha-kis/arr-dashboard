/**
 * Tautulli Cache Observability Routes
 *
 * Exposes sync status and manual refresh for Tautulli integration cache.
 * Enables users to see when data was last synced and trigger a refresh.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import {
	findOwnedEnabledTautulliInstance,
	readOwnedTautulliCacheAuthority,
} from "../../lib/tautulli/tautulli-cache-authority.js";
import { refreshOwnedTautulliCache } from "../../lib/tautulli/tautulli-cache-refresher.js";
import { InstanceNotFoundError } from "../../lib/errors.js";
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

		const authority = await readOwnedTautulliCacheAuthority(app.prisma, { userId, instanceId });
		if (!authority) throw new InstanceNotFoundError(instanceId);

		return reply.send({
			instanceId,
			...authority,
			hasCacheData: authority.available && authority.cachedItems > 0,
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

			const instance = await findOwnedEnabledTautulliInstance(app.prisma, {
				userId,
				instanceId,
			});
			if (!instance) throw new InstanceNotFoundError(instanceId);
			const result = await refreshOwnedTautulliCache({
				prisma: app.prisma,
				encryptor: app.encryptor,
				instance,
				log: request.log,
			});

			return reply.send({
				success: result.complete && Boolean(result.completedAt),
				upserted: result.upserted,
				errors: result.errors,
			});
		},
	);
}
