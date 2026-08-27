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
import { loadPersistedTautulliGeneration } from "../../lib/tautulli/tautulli-evidence-repository.js";
import { decodeTautulliGenerationMetadata } from "../../lib/tautulli/tautulli-generation-metadata.js";
import { requireTautulliClient } from "../../lib/tautulli/tautulli-helpers.js";
import { projectTautulliCacheStatus } from "../../lib/tautulli/tautulli-status.js";
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

		const [count, status] = await Promise.all([
			app.prisma.tautulliCache.count({ where: { instanceId } }),
			app.prisma.cacheRefreshStatus.findUnique({
				where: { instanceId_cacheType: { instanceId, cacheType: "tautulli" } },
				select: {
					lastResult: true,
					lastRefreshedAt: true,
					lastAttemptAt: true,
					lastAttemptResult: true,
					lastAttemptErrorMessage: true,
					lastErrorMessage: true,
					generationId: true,
					generationMetadata: true,
					itemCount: true,
					connectionGeneration: true,
					identityGeneration: true,
				},
			}),
		]);

		const decoded = decodeTautulliGenerationMetadata(status?.generationMetadata);
		const persisted =
			status && decoded.ok
				? await loadPersistedTautulliGeneration(app.prisma, {
						instanceId,
						generationId: decoded.metadata.generationId,
						connectionGeneration: decoded.metadata.connectionGeneration,
						identityGeneration: decoded.metadata.identityGeneration,
						expected: decoded.metadata.completeness,
					})
				: null;

		return reply.send({
			instanceId,
			...projectTautulliCacheStatus(status, count, persisted?.ok === true),
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
				return reply.send({
					success: result.complete && Boolean(result.completedAt),
					upserted: result.upserted,
					errors: result.errors,
				});
			} catch (err) {
				await recordWatchProviderCacheRefreshFailure(
					app.prisma,
					"tautulli",
					"unknown_failure",
					publicationInstance,
					request.log,
				);
				throw err;
			}
		},
	);
}
