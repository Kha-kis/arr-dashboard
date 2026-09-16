/**
 * Jellyfin Cache Observability Routes
 *
 * Exposes sync status and manual refresh for Jellyfin integration cache.
 * Enables users to see when data was last synced and trigger a refresh.
 */

import type { CacheHealthResponse, ProviderObservationAcceptedResponse } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { requireEnabledInstance } from "../../lib/arr/instance-helpers.js";
import { AppValidationError } from "../../lib/errors.js";
import {
	type JellyfinCacheHealthInstance,
	readOwnedJellyfinCacheHealthSources,
} from "../../lib/jellyfin/jellyfin-cache-health.js";
import { refreshOwnedJellyfinCacheWithAttempt } from "../../lib/jellyfin/jellyfin-cache-refresher.js";
import { runJellyfinCacheRefreshSingleFlightWithAttempt } from "../../lib/jellyfin/jellyfin-cache-singleflight.js";
import { startProviderCacheRefreshInBackground } from "../../lib/provider-observation/background-cache-refresh.js";
import type { FastifyWithLibraryRefreshRecovery } from "../../lib/services/library-refresh-recovery.js";
import { claimProviderCacheRefreshAttempt } from "../../lib/services/provider-cache-status.js";
import { createProviderPublicationAuthority } from "../../lib/services/provider-identity-guard.js";
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
			where: {
				userId,
				service: { in: ["JELLYFIN", "EMBY"] },
				enabled: true,
			},
			select: { id: true, label: true, service: true, createdAt: true },
		});

		const sources = await readOwnedJellyfinCacheHealthSources({
			prisma: app.prisma,
			userId,
			instances: instances as JellyfinCacheHealthInstance[],
		});

		const items = sources.map((source) => source.item);
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
			const log = request.log;

			const instance = await requireEnabledInstance(app, userId, instanceId);
			if (instance.service !== "JELLYFIN" && instance.service !== "EMBY") {
				throw new AppValidationError("Instance is not a Jellyfin or Emby service");
			}
			const authority = createProviderPublicationAuthority(instance);
			const recovery = (app as FastifyWithLibraryRefreshRecovery).libraryRefreshRecovery;

			await startProviderCacheRefreshInBackground({
				cacheType: "jellyfin",
				claim: () => claimProviderCacheRefreshAttempt(app.prisma, "jellyfin", authority),
				produce: (attempt) =>
					runJellyfinCacheRefreshSingleFlightWithAttempt(authority, "jellyfin", attempt, () =>
						refreshOwnedJellyfinCacheWithAttempt(
							{ prisma: app.prisma, encryptor: app.encryptor, instance, log },
							attempt,
						),
					),
				log,
				...(recovery
					? { recovery: { provider: "jellyfin" as const, userId, instanceId, handoff: recovery } }
					: {}),
			});

			const response: ProviderObservationAcceptedResponse = {
				status: "accepted",
				cacheType: "jellyfin",
			};
			return reply.status(202).send(response);
		},
	);
}
