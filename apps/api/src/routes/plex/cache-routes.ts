/**
 * Plex Cache Observability Routes
 *
 * Exposes sync status and manual refresh for Plex integration cache.
 * Enables users to see when data was last synced and trigger a refresh.
 */

import type { CacheHealthResponse } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { requireEnabledInstance } from "../../lib/arr/instance-helpers.js";
import { AppValidationError } from "../../lib/errors.js";
import {
	getPublishedEpisodeGenerationObservation,
	getPublishedGenerationObservation,
	isCurrentAuthoritativePlexEvidence,
	loadUserGenerationObservations,
} from "../../lib/plex/plex-evidence-repository.js";
import { requirePlexClient } from "../../lib/plex/plex-helpers.js";
import { refreshOwnedPlexCache } from "../../lib/plex/plex-refresh-orchestration.js";
import { validateRequest } from "../../lib/utils/validate.js";
import { buildCacheHealthItems } from "./lib/cache-health-helpers.js";

const instanceParams = z.object({
	instanceId: z.string().min(1),
});

export async function registerCacheRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * GET /api/plex/cache/:instanceId/status
	 *
	 * Returns sync status for a Plex instance's cache:
	 * - total cached items
	 * - most recent cache entry timestamp
	 */
	app.get("/cache/:instanceId/status", async (request, reply) => {
		const { instanceId } = validateRequest(instanceParams, request.params);
		const userId = request.currentUser!.id;

		// Verify ownership
		await requirePlexClient(app, userId, instanceId);

		const evidence = await getPublishedGenerationObservation(app.prisma, { userId, instanceId });
		if (!evidence.available || !isCurrentAuthoritativePlexEvidence(evidence.evidence)) {
			return reply.status(503).send({
				error: "Plex cache evidence is unavailable",
				evidence: evidence.evidence,
			});
		}

		return reply.send({
			instanceId,
			cachedItems: evidence.itemCount,
			hasCacheData: evidence.itemCount > 0,
			evidence: evidence.evidence,
		});
	});

	/**
	 * POST /api/plex/cache/:instanceId/refresh
	 *
	 * Triggers a manual cache refresh for the specified Plex instance.
	 * Rate limited to prevent abuse.
	 */
	app.post(
		"/cache/:instanceId/refresh",
		{ config: { rateLimit: { max: 2, timeWindow: "5m" } } },
		async (request, reply) => {
			const { instanceId } = validateRequest(instanceParams, request.params);
			const userId = request.currentUser!.id;

			const instance = await requireEnabledInstance(app, userId, instanceId);
			if (instance.service !== "PLEX") {
				throw new AppValidationError("Instance is not a Plex service");
			}
			const result = await refreshOwnedPlexCache({
				prisma: app.prisma,
				encryptor: app.encryptor,
				instance,
				log: request.log,
			});

			if (!result.complete || !result.completedAt) {
				return reply.status(503).send({
					success: false,
					upserted: result.upserted,
					errors: result.errors,
					error: result.errorMessages[0] ?? "Plex cache refresh did not publish a generation",
				});
			}

			return reply.send({
				success: true,
				upserted: result.upserted,
				errors: result.errors,
			});
		},
	);

	/**
	 * GET /api/plex/cache/health
	 *
	 * Returns cache refresh status for all of the user's Plex/Tautulli instances.
	 * Includes a staleness flag (>12h since last refresh).
	 */
	app.get("/cache/health", async (request, reply) => {
		const userId = request.currentUser!.id;

		// Get all the user's Plex and Tautulli instances
		const instances = await app.prisma.serviceInstance.findMany({
			where: {
				userId,
				service: { in: ["PLEX", "TAUTULLI"] },
				enabled: true,
			},
			select: { id: true, label: true },
		});

		if (instances.length === 0) {
			const response: CacheHealthResponse = { items: [] };
			return reply.send(response);
		}

		const instanceIds = instances.map((i) => i.id);
		const instanceMap = new Map(instances.map((i) => [i.id, i.label]));

		const statuses = await app.prisma.cacheRefreshStatus.findMany({
			where: { instanceId: { in: instanceIds } },
		});
		const plexEvidenceByStatus = new Map();
		for (const entry of await loadUserGenerationObservations(app.prisma, { userId })) {
			if (entry.instanceId) plexEvidenceByStatus.set(`${entry.instanceId}:plex`, entry.evidence);
		}
		for (const instance of instances) {
			const status = statuses.find(
				(candidate) =>
					candidate.instanceId === instance.id && candidate.cacheType === "plex_episode",
			);
			if (!status) continue;
			const evidence = await getPublishedEpisodeGenerationObservation(app.prisma, {
				userId,
				instanceId: instance.id,
			});
			plexEvidenceByStatus.set(`${instance.id}:plex_episode`, evidence.evidence);
		}

		const items = buildCacheHealthItems(statuses, instanceMap, undefined, plexEvidenceByStatus);
		const response: CacheHealthResponse = { items };
		return reply.send(response);
	});
}
