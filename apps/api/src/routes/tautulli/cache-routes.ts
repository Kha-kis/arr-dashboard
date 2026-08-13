import type {
	TautulliCacheHealthResponse,
	TautulliCacheRefreshResponse,
	TautulliCacheStatusResponse,
} from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { refreshTautulliCache } from "../../lib/tautulli/tautulli-cache-refresher.js";
import { createCurrentTautulliClient } from "../../lib/tautulli/current-tautulli-client.js";
import { providerConnectionIdentity } from "../../lib/services/provider-connection-guard.js";
import { sanitizeErrorMessage } from "../../lib/media-stats/cache-health-helpers.js";
import { validateRequest } from "../../lib/utils/validate.js";

const instanceParams = z.object({ instanceId: z.string().min(1) });
const emptyBody = z.object({}).strict();
const staleThresholdMs = 12 * 60 * 60 * 1000;

export async function registerCacheRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	app.get("/cache/:instanceId/status", async (request, reply) => {
		const { instanceId } = validateRequest(instanceParams, request.params);
		const instance = await app.prisma.serviceInstance.findFirst({
			where: {
				id: instanceId,
				userId: request.currentUser!.id,
				service: "TAUTULLI",
				enabled: true,
			},
		});
		if (!instance) {
			return reply.status(404).send({ error: "Instance not found or access denied" });
		}
		const [cachedItems, status] = await Promise.all([
			app.prisma.tautulliCache.count({ where: { instanceId } }),
			app.prisma.cacheRefreshStatus.findUnique({
				where: { instanceId_cacheType: { instanceId, cacheType: "tautulli" } },
			}),
		]);
		const response: TautulliCacheStatusResponse = {
			instanceId,
			cachedItems,
			hasCacheData: cachedItems > 0,
			status: status && {
				cacheType: "tautulli",
				lastRefreshedAt: status.lastRefreshedAt.toISOString(),
				lastResult: status.lastResult,
				lastErrorMessage: sanitizeErrorMessage(status.lastErrorMessage),
				itemCount: status.itemCount,
				lastAttemptAt: status.lastAttemptAt?.toISOString() ?? null,
				lastAttemptResult: status.lastAttemptResult,
				lastAttemptErrorMessage: sanitizeErrorMessage(status.lastAttemptErrorMessage),
			},
		};
		return reply.send(response);
	});

	app.get("/cache/health", async (request, reply) => {
		const instances = await app.prisma.serviceInstance.findMany({
			where: { userId: request.currentUser!.id, service: "TAUTULLI", enabled: true },
			select: { id: true, label: true },
		});
		const statuses = instances.length
			? await app.prisma.cacheRefreshStatus.findMany({
					where: {
						instanceId: { in: instances.map((instance) => instance.id) },
						cacheType: "tautulli",
					},
				})
			: [];
		const statusByInstance = new Map(statuses.map((status) => [status.instanceId, status]));
		const response: TautulliCacheHealthResponse = {
			items: instances.map((instance) => {
				const status = statusByInstance.get(instance.id);
				const newerPendingAttempt =
					status?.lastAttemptResult === "pending" &&
					status.lastAttemptAt != null &&
					status.lastAttemptAt.getTime() >= status.lastRefreshedAt.getTime();
				const newerFailedAttempt =
					status?.lastAttemptResult === "error" &&
					status.lastAttemptAt != null &&
					status.lastAttemptAt.getTime() >= status.lastRefreshedAt.getTime();
				return {
					instanceId: instance.id,
					instanceLabel: instance.label,
					cacheType: "tautulli",
					lastRefreshedAt: status?.lastRefreshedAt.toISOString() ?? null,
					lastResult: status?.lastResult ?? null,
					lastErrorMessage: sanitizeErrorMessage(status?.lastErrorMessage ?? null),
					itemCount: status?.itemCount ?? 0,
					lastAttemptAt: status?.lastAttemptAt?.toISOString() ?? null,
					lastAttemptResult: status?.lastAttemptResult ?? null,
					lastAttemptErrorMessage: sanitizeErrorMessage(status?.lastAttemptErrorMessage ?? null),
					effectiveResult: newerPendingAttempt
						? "pending"
						: status?.lastResult === "error"
							? "error"
							: newerFailedAttempt
								? "partial"
								: (status?.lastResult ?? null),
					isStale: status ? Date.now() - status.lastRefreshedAt.getTime() > staleThresholdMs : null,
				};
			}),
		};
		return reply.send(response);
	});

	app.post(
		"/cache/:instanceId/refresh",
		{ config: { rateLimit: { max: 2, timeWindow: "5m" } } },
		async (request, reply) => {
			const { instanceId } = validateRequest(instanceParams, request.params);
			validateRequest(emptyBody, request.body ?? {});
			// Resolve the current owned enabled instance immediately before the guarded refresh.
			const instance = await app.prisma.serviceInstance.findFirst({
				where: {
					id: instanceId,
					userId: request.currentUser!.id,
					service: "TAUTULLI",
					enabled: true,
				},
			});
			if (!instance) {
				return reply.status(404).send({ error: "Instance not found or access denied" });
			}
			const { client } = createCurrentTautulliClient(app, instance);
			const result = await refreshTautulliCache(
				client,
				app.prisma,
				instanceId,
				request.log,
				providerConnectionIdentity(instance),
			);
			const response: TautulliCacheRefreshResponse = {
				success: result.complete && Boolean(result.completedAt),
				complete: result.complete,
				superseded: Boolean(result.superseded),
				upserted: result.upserted,
				errors: result.errors,
			};
			return reply.send(response);
		},
	);
}
