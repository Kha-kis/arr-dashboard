/**
 * Tautulli Cache Observability Routes
 *
 * Exposes sync status and manual refresh for Tautulli integration cache.
 * Enables users to see when data was last synced and trigger a refresh.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import {
	refreshOwnedTautulliCache,
	summarizeTautulliRefreshResultForLog,
} from "../../lib/tautulli/tautulli-cache-refresher.js";
import { loadPersistedTautulliGeneration } from "../../lib/tautulli/tautulli-evidence-repository.js";
import { decodeTautulliGenerationMetadata } from "../../lib/tautulli/tautulli-generation-metadata.js";
import {
	requireTautulliClient,
	requireTautulliInstance,
} from "../../lib/tautulli/tautulli-helpers.js";
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

			const instance = await requireTautulliInstance(app, userId, instanceId);

			try {
				const result = await refreshOwnedTautulliCache({
					prisma: app.prisma,
					encryptor: app.encryptor,
					instance,
					log: request.log,
				});
				request.log.info(
					{ instanceId, ...summarizeTautulliRefreshResultForLog(result) },
					"Manual Tautulli cache refresh completed",
				);
				return reply.send({
					success:
						result.kind === "published-authoritative" || result.kind === "published-positive",
					partial: result.kind === "published-positive",
					terminalResult: result.kind,
					upserted: result.upserted,
					errors: result.errors,
				});
			} catch {
				request.log.error(
					{ instanceId, reasonCode: "refresh_rejected" },
					"Manual Tautulli cache refresh failed",
				);
				throw new Error("Tautulli cache refresh failed");
			}
		},
	);
}
