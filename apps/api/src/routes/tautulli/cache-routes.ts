/**
 * Tautulli Cache Observability Routes
 *
 * Exposes sync status and manual refresh for Tautulli integration cache.
 * Enables users to see when data was last synced and trigger a refresh.
 */

import type { ProviderObservationAcceptedResponse } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { InstanceNotFoundError } from "../../lib/errors.js";
import { startProviderCacheRefreshInBackground } from "../../lib/provider-observation/background-cache-refresh.js";
import { claimProviderCacheRefreshAttempt } from "../../lib/services/provider-cache-status.js";
import { createProviderPublicationAuthority } from "../../lib/services/provider-identity-guard.js";
import { findOwnedEnabledTautulliInstance } from "../../lib/tautulli/tautulli-cache-authority.js";
import { refreshOwnedTautulliCacheWithAttempt } from "../../lib/tautulli/tautulli-cache-refresher.js";
import { readOwnedTautulliObservation } from "../../lib/tautulli/tautulli-observation-repository.js";
import { validateRequest } from "../../lib/utils/validate.js";

const instanceParams = z.object({
	instanceId: z.string().min(1),
});

export async function registerCacheRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * GET /api/tautulli/cache/:instanceId/status
	 *
	 * Returns sync status for a Tautulli instance's cache:
	 * - bounded positive-observation status and row count
	 */
	app.get("/cache/:instanceId/status", async (request, reply) => {
		const { instanceId } = validateRequest(instanceParams, request.params);
		const userId = request.currentUser!.id;

		const observation = await readOwnedTautulliObservation(app.prisma, { userId, instanceId });
		if (!observation) throw new InstanceNotFoundError(instanceId);

		return reply.send({
			providerStatus: observation.providerStatus,
			itemCount: observation.rows.length,
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
			const log = request.log;

			const instance = await findOwnedEnabledTautulliInstance(app.prisma, {
				userId,
				instanceId,
			});
			if (!instance) throw new InstanceNotFoundError(instanceId);
			const authority = createProviderPublicationAuthority(instance);
			await startProviderCacheRefreshInBackground({
				cacheType: "tautulli",
				claim: () => claimProviderCacheRefreshAttempt(app.prisma, "tautulli", authority),
				produce: (attempt) =>
					refreshOwnedTautulliCacheWithAttempt(
						{ prisma: app.prisma, encryptor: app.encryptor, instance, log },
						attempt,
					),
				log,
			});

			const response: ProviderObservationAcceptedResponse = {
				status: "accepted",
				cacheType: "tautulli",
			};
			return reply.status(202).send(response);
		},
	);
}
