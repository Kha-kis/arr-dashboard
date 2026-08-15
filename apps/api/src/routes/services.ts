import {
	ALL_SERVICES,
	analyticsProviderSchema,
	arrServiceTypeSchema,
	type AnalyticsProvider,
} from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { requireInstance } from "../lib/arr/instance-helpers.js";
import { resolveAnalyticsProviderSelection } from "../lib/analytics/provider-selection.js";
import {
	withCleanupTopologyMutationLease,
	withExclusiveCleanupTopologyMutationLease,
} from "../lib/library-cleanup/cleanup-executor.js";
import { clearFileIdIndexCache } from "../lib/library-sync/infohash-backfill-by-inode.js";
import type { ServiceInstance, ServiceType } from "../lib/prisma.js";
import { invalidateTorrentListCache } from "../lib/qui/torrent-list-cache.js";
import { testServiceConnection } from "../lib/services/connection-tester.js";
import {
	decryptHttpAuthCredentials,
	encryptHttpAuthCredentials,
} from "../lib/services/http-auth.js";
import {
	credentialFreeUrlSchema,
	getHttpAuthConflict,
	httpAuthSchema,
} from "../lib/services/http-auth-validation.js";
import { formatServiceInstance } from "../lib/services/service-formatter.js";
import { updateInstanceTags, upsertTags } from "../lib/services/tag-manager.js";
import { buildUpdateData } from "../lib/services/update-builder.js";
import { assertNoActiveDeploymentOwnership } from "../lib/trash-guides/deployment-operation-gate.js";
import { normalizeDeploymentBaseUrl } from "../lib/trash-guides/deployment-target.js";
import { assertNoActiveTrashRecoveryForInstance } from "../lib/trash-guides/recovery-evidence.js";
import { validateRequest } from "../lib/utils/validate.js";
import { invalidatePulseCache } from "./pulse.js";

const idParams = z.object({ id: z.string().min(1) });
const CACHE_PROVIDER_SERVICES = new Set<ServiceType>(["PLEX", "JELLYFIN", "EMBY", "TAUTULLI"]);
const ANALYTICS_PROVIDER_SERVICES: Record<AnalyticsProvider, ServiceType> = {
	tracearr: "TRACEARR",
	tautulli: "TAUTULLI",
};

const serviceDeleteQuerySchema = z
	.object({ confirmAnalyticsUnavailableFor: analyticsProviderSchema.optional() })
	.strict();

const servicePayloadSchema = z.object({
	label: z.string().min(1).max(120),
	baseUrl: credentialFreeUrlSchema,
	externalUrl: credentialFreeUrlSchema.nullable().optional(), // Optional browser-accessible URL for reverse proxy setups
	apiKey: z.string().min(8),
	httpAuth: httpAuthSchema.nullable().optional(),
	service: arrServiceTypeSchema,
	enabled: z.boolean().default(true),
	isDefault: z.boolean().default(false),
	tags: z.array(z.string().min(1).max(64)).default([]),
	storageGroupId: z.string().min(1).max(64).nullable().optional(),
	// qui-only: enables inode-based hardlink correlation. When true,
	// arr-dashboard reads files directly via stat() to verify which
	// library files are hardlinked to which qui torrents. Requires the
	// arr-dashboard process to have read access to both the qBit content
	// tree and the *arr library tree. Mirrors qui's own
	// `HasLocalFilesystemAccess` per-instance toggle.
	hasLocalFilesystemAccess: z.boolean().default(false),
	// qui-only: optional prefix rewrite for paths reported by qui that
	// arr-dashboard sees at a different mount point. Format:
	// "qui-prefix>local-prefix" (e.g., "/downloads>/qbit-data"). Empty/null
	// = no rewrite. Capped at 256 chars to bound config sprawl.
	pathPrefix: z.string().max(256).nullable().optional(),
});

const serviceUpdateSchema = z
	.object({
		label: z.string().min(1).max(120).optional(),
		baseUrl: credentialFreeUrlSchema.optional(),
		externalUrl: credentialFreeUrlSchema.nullable().optional(),
		apiKey: z.string().min(8).optional(),
		httpAuth: httpAuthSchema.nullable().optional(),
		service: arrServiceTypeSchema.optional(),
		enabled: z.boolean().optional(),
		isDefault: z.boolean().optional(),
		tags: z.array(z.string().min(1).max(64)).optional(),
		storageGroupId: z.string().min(1).max(64).nullable().optional(),
		hasLocalFilesystemAccess: z.boolean().optional(),
		pathPrefix: z.string().max(256).nullable().optional(),
		confirmAnalyticsUnavailableFor: analyticsProviderSchema.optional(),
	})
	.refine((data) => Object.keys(data).some((key) => key !== "confirmAnalyticsUnavailableFor"), {
		message: "At least one field must be provided",
	});

type AnalyticsProviderLifecycleChange =
	| { kind: "delete" }
	| { kind: "update"; targetService: ServiceType; targetEnabled: boolean };

async function getAnalyticsProviderConfirmationRequirement(
	prisma: Pick<import("../lib/prisma.js").PrismaClient, "$transaction" | "serviceInstance">,
	userId: string,
	existing: Pick<ServiceInstance, "service" | "enabled">,
	change: AnalyticsProviderLifecycleChange,
): Promise<{ selected: AnalyticsProvider; alternativeEnabled: boolean } | null> {
	const existingProvider = Object.entries(ANALYTICS_PROVIDER_SERVICES).find(
		([, service]) => service === existing.service,
	)?.[0] as AnalyticsProvider | undefined;
	if (!existing.enabled || !existingProvider) return null;

	const selection = await resolveAnalyticsProviderSelection(prisma, userId);
	if (selection.selected !== existingProvider) return null;
	if (
		change.kind === "update" &&
		change.targetEnabled &&
		change.targetService === existing.service
	) {
		return null;
	}

	const alternative = selection.selected === "tautulli" ? "tracearr" : "tautulli";
	const [selectedEnabledCount, alternativeEnabledCount] = await Promise.all([
		prisma.serviceInstance.count({
			where: { userId, service: ANALYTICS_PROVIDER_SERVICES[selection.selected], enabled: true },
		}),
		prisma.serviceInstance.count({
			where: { userId, service: ANALYTICS_PROVIDER_SERVICES[alternative], enabled: true },
		}),
	]);
	if (selectedEnabledCount !== 1) return null;

	return { selected: selection.selected, alternativeEnabled: alternativeEnabledCount > 0 };
}

function changesCacheProviderConnection(
	existing: Pick<ServiceInstance, "service" | "baseUrl" | "enabled">,
	payload: z.infer<typeof serviceUpdateSchema>,
): boolean {
	const target = (payload.service ?? existing.service.toLowerCase()).toUpperCase() as ServiceType;
	if (!CACHE_PROVIDER_SERVICES.has(existing.service) && !CACHE_PROVIDER_SERVICES.has(target))
		return false;
	return (
		target !== existing.service ||
		(payload.enabled !== undefined && payload.enabled !== existing.enabled) ||
		(payload.baseUrl !== undefined && payload.baseUrl !== existing.baseUrl) ||
		Object.hasOwn(payload, "apiKey") ||
		Object.hasOwn(payload, "httpAuth")
	);
}

function isArrService(service: ServiceType): boolean {
	return service === "RADARR" || service === "SONARR";
}

function changesArrConnection(
	existing: Pick<ServiceInstance, "service" | "baseUrl">,
	payload: z.infer<typeof serviceUpdateSchema>,
): boolean {
	const targetService = (
		payload.service ?? existing.service.toLowerCase()
	).toUpperCase() as ServiceType;
	if (!isArrService(existing.service) && !isArrService(targetService)) return false;
	if (targetService !== existing.service) return true;
	if (
		payload.baseUrl !== undefined &&
		normalizeDeploymentBaseUrl(payload.baseUrl) !== normalizeDeploymentBaseUrl(existing.baseUrl)
	) {
		return true;
	}
	return Object.hasOwn(payload, "apiKey") || Object.hasOwn(payload, "httpAuth");
}

async function clearDurableProviderCacheState(
	prisma: {
		plexCache: { deleteMany(args: { where: { instanceId: string } }): Promise<unknown> };
		plexEpisodeCache: { deleteMany(args: { where: { instanceId: string } }): Promise<unknown> };
		jellyfinCache: { deleteMany(args: { where: { instanceId: string } }): Promise<unknown> };
		jellyfinEpisodeCache: { deleteMany(args: { where: { instanceId: string } }): Promise<unknown> };
		tautulliCache: { deleteMany(args: { where: { instanceId: string } }): Promise<unknown> };
		cacheRefreshStatus: {
			deleteMany(args: { where: { instanceId: string } }): Promise<unknown>;
			upsert(args: Record<string, unknown>): Promise<unknown>;
		};
	},
	instanceId: string,
	targetService: ServiceType,
	targetEnabled: boolean,
): Promise<void> {
	await prisma.plexCache.deleteMany({ where: { instanceId } });
	await prisma.plexEpisodeCache.deleteMany({ where: { instanceId } });
	await prisma.jellyfinCache.deleteMany({ where: { instanceId } });
	await prisma.jellyfinEpisodeCache.deleteMany({ where: { instanceId } });
	await prisma.tautulliCache.deleteMany({ where: { instanceId } });
	await prisma.cacheRefreshStatus.deleteMany({ where: { instanceId } });

	if (!targetEnabled || !CACHE_PROVIDER_SERVICES.has(targetService)) return;
	const cacheTypes =
		targetService === "PLEX"
			? ["plex", "plex_episode"]
			: targetService === "TAUTULLI"
				? ["tautulli"]
				: ["jellyfin", "jellyfin_episode"];
	const invalidatedAt = new Date();
	const message = "Provider connection changed; refresh required";
	for (const cacheType of cacheTypes) {
		await prisma.cacheRefreshStatus.upsert({
			where: { instanceId_cacheType: { instanceId, cacheType } },
			create: {
				instanceId,
				cacheType,
				lastRefreshedAt: invalidatedAt,
				lastResult: "error",
				lastErrorMessage: message,
				itemCount: 0,
				lastAttemptAt: invalidatedAt,
				lastAttemptResult: "error",
				lastAttemptErrorMessage: message,
			},
			update: {
				lastRefreshedAt: invalidatedAt,
				lastResult: "error",
				lastErrorMessage: message,
				itemCount: 0,
				generationId: null,
				generationMetadata: null,
				lastAttemptAt: invalidatedAt,
				lastAttemptResult: "error",
				lastAttemptErrorMessage: message,
			},
		});
	}
}

const tagCreateSchema = z.object({
	name: z.string().min(1).max(64),
});

const servicesRoute: FastifyPluginCallback = (app, _opts, done) => {
	app.get("/services", async (request, reply) => {
		const instances = await app.prisma.serviceInstance.findMany({
			where: { userId: request.currentUser!.id },
			include: {
				tags: {
					include: {
						tag: true,
					},
				},
			},
			orderBy: { createdAt: "asc" },
		});

		const formatted = instances.map(formatServiceInstance);
		return reply.send({ services: formatted });
	});

	app.post("/services", async (request, reply) => {
		const { apiKey, httpAuth, service, tags, isDefault, ...rest } = validateRequest(
			servicePayloadSchema,
			request.body,
		);

		const encrypted = app.encryptor.encrypt(apiKey);
		const httpAuthConflict = httpAuth ? getHttpAuthConflict(service) : null;
		if (httpAuthConflict) {
			return reply.status(400).send({
				error: `HTTP Basic Auth is not supported for ${service}`,
				details: httpAuthConflict,
			});
		}
		const encryptedHttpAuth = httpAuth ? encryptHttpAuthCredentials(app.encryptor, httpAuth) : {};

		const serviceEnum = service.toUpperCase() as ServiceType;
		const userId = request.currentUser!.id;

		return await withCleanupTopologyMutationLease(
			{ prisma: app.prisma, log: request.log },
			userId,
			async () => {
				if (isDefault) {
					await app.prisma.serviceInstance.updateMany({
						where: { service: serviceEnum, userId },
						data: { isDefault: false },
					});
				}

				const tagRecords = await upsertTags(app.prisma, tags);

				const created = await app.prisma.serviceInstance.create({
					data: {
						userId, // preHandler guarantees auth
						service: serviceEnum,
						encryptedApiKey: encrypted.value,
						encryptionIv: encrypted.iv,
						...encryptedHttpAuth,
						isDefault,
						...rest,
						tags: {
							create: tagRecords,
						},
					},
					include: {
						tags: {
							include: {
								tag: true,
							},
						},
					},
				});

				request.log.info({ service, label: rest.label }, "Service instance added");

				return reply.status(201).send({
					service: formatServiceInstance(created),
				});
			},
		);
	});

	app.put("/services/:id", async (request, reply) => {
		const { id } = validateRequest(idParams, request.params);
		const { confirmAnalyticsUnavailableFor, ...payload } = validateRequest(
			serviceUpdateSchema,
			request.body,
		);
		const userId = request.currentUser!.id;

		return await withCleanupTopologyMutationLease(
			{ prisma: app.prisma, log: request.log },
			userId,
			async () => {
				const existing = await requireInstance(app, userId, id);
				const targetServiceName = payload.service ?? existing.service.toLowerCase();
				const targetService = targetServiceName.toUpperCase() as ServiceType;
				const keepsExistingHttpAuth =
					payload.httpAuth === undefined && Boolean(existing.encryptedHttpAuthCredentials);
				const httpAuthConflict =
					payload.httpAuth || keepsExistingHttpAuth ? getHttpAuthConflict(targetServiceName) : null;
				if (httpAuthConflict) {
					return reply.status(400).send({
						error: `HTTP Basic Auth is not supported for ${targetServiceName}`,
						details: `${httpAuthConflict} Remove HTTP Basic Auth or configure a proxy bypass.`,
					});
				}
				const confirmation = await getAnalyticsProviderConfirmationRequirement(
					app.prisma,
					userId,
					existing,
					{
						kind: "update",
						targetService,
						targetEnabled: payload.enabled ?? existing.enabled,
					},
				);
				if (confirmation && confirmAnalyticsUnavailableFor !== confirmation.selected) {
					return reply.status(409).send({
						code: "ANALYTICS_PROVIDER_CONFIRMATION_REQUIRED",
						...confirmation,
					});
				}

				const updateData = buildUpdateData(payload, app.encryptor);
				const providerConnectionChanged = changesCacheProviderConnection(existing, payload);
				const arrConnectionChanged = changesArrConnection(existing, payload);
				const shouldResetOtherDefaults = payload.isDefault === true || Boolean(payload.service);
				if (arrConnectionChanged && isArrService(existing.service)) {
					const aliases = await app.prisma.serviceInstance.findMany({
						where: { userId, service: existing.service },
					});
					const currentEndpoint = normalizeDeploymentBaseUrl(existing.baseUrl);
					const equivalentInstanceIds = aliases
						.filter(
							(alias) =>
								alias.userId === userId &&
								alias.service === existing.service &&
								normalizeDeploymentBaseUrl(alias.baseUrl) === currentEndpoint,
						)
						.map((alias) => alias.id);
					if (!equivalentInstanceIds.includes(id)) equivalentInstanceIds.push(id);
					for (const instanceId of equivalentInstanceIds) {
						await assertNoActiveTrashRecoveryForInstance(app.prisma, userId, instanceId);
					}
					await assertNoActiveDeploymentOwnership(app.prisma, userId, equivalentInstanceIds);
				}
				const connectionChanged = providerConnectionChanged || arrConnectionChanged;

				if (connectionChanged) {
					await app.prisma.$transaction(async (tx) => {
						if (shouldResetOtherDefaults) {
							await tx.serviceInstance.updateMany({
								where: { service: targetService, userId, NOT: { id } },
								data: { isDefault: false },
							});
						}
						await tx.serviceInstance.updateMany({
							where: { id, userId },
							data: { ...updateData, connectionGeneration: { increment: 1 } },
						});
						if (payload.tags) await updateInstanceTags(tx, id, payload.tags);
						await clearDurableProviderCacheState(
							tx,
							id,
							targetService,
							payload.enabled ?? existing.enabled,
						);
					});
				} else {
					if (shouldResetOtherDefaults) {
						await app.prisma.serviceInstance.updateMany({
							where: { service: targetService, userId, NOT: { id } },
							data: { isDefault: false },
						});
					}
					await app.prisma.serviceInstance.updateMany({ where: { id, userId }, data: updateData });
					if (payload.tags) await updateInstanceTags(app.prisma, id, payload.tags);
				}
				if (providerConnectionChanged) invalidatePulseCache(userId);

				// Drop process-local qui caches when a qui instance becomes
				// unreachable from this app's perspective — either disabled
				// (enabled: true → false) or its service type changed away from
				// QUI. Mirrors the DELETE handler's invalidation but for the
				// "kept but inert" case. Without this, a disabled instance's
				// inode index + torrent list would sit in memory for the rest
				// of the process lifetime (TTL is read-only; nothing reads a
				// disabled instance, so no self-healing). No-op for non-qui
				// services because the keys won't be in those caches.
				const wasQui = existing.service === "QUI";
				const nowDisabled = payload.enabled === false && existing.enabled === true;
				const switchedAwayFromQui =
					payload.service !== undefined && payload.service.toLowerCase() !== "qui";
				if (wasQui && (nowDisabled || switchedAwayFromQui)) {
					invalidateTorrentListCache(id);
					clearFileIdIndexCache(id);
					request.log.info(
						{ instanceId: id, reason: nowDisabled ? "disabled" : "service-changed" },
						"qui caches dropped after instance update",
					);
				}

				// Fetch updated instance - include userId to ensure we only get owned instances
				const fresh = await app.prisma.serviceInstance.findFirst({
					where: {
						id,
						userId,
					},
					include: { tags: { include: { tag: true } } },
				});

				if (!fresh) {
					return reply.status(404).send({ error: "Service instance not found" });
				}

				request.log.info(
					{ service: fresh.service, label: fresh.label, instanceId: id },
					"Service instance updated",
				);

				return reply.send({
					service: formatServiceInstance(fresh),
				});
			},
		);
	});

	app.delete("/services/:id", async (request, reply) => {
		const { id } = validateRequest(idParams, request.params);
		const { confirmAnalyticsUnavailableFor } = validateRequest(
			serviceDeleteQuerySchema,
			request.query,
		);
		const userId = request.currentUser!.id; // preHandler guarantees authentication

		return await withExclusiveCleanupTopologyMutationLease(
			{ prisma: app.prisma, log: request.log },
			userId,
			async () => {
				const existing = await requireInstance(app, userId, id);
				const confirmation = await getAnalyticsProviderConfirmationRequirement(
					app.prisma,
					userId,
					existing,
					{ kind: "delete" },
				);
				if (confirmation && confirmAnalyticsUnavailableFor !== confirmation.selected) {
					return reply.status(409).send({
						code: "ANALYTICS_PROVIDER_CONFIRMATION_REQUIRED",
						...confirmation,
					});
				}
				if (existing.service === "RADARR" || existing.service === "SONARR") {
					await assertNoActiveTrashRecoveryForInstance(app.prisma, userId, id);
				}
				await app.prisma.serviceInstance.delete({ where: { id, userId } });

				// Free any process-local qui caches keyed to this instance. Both
				// the torrent-list cache and the inode index retain heavy entries
				// (TTL-checked on read only — a stale entry self-heals, but a
				// deleted instance is never read again, so its entry would linger
				// for the whole process life). No-op for non-qui services: the id
				// simply isn't a key in those caches.
				invalidateTorrentListCache(id);
				clearFileIdIndexCache(id);

				request.log.info({ instanceId: id }, "Service instance deleted");
				return reply.status(204).send();
			},
		);
	});

	app.get("/tags", async (_request, reply) => {
		const tags = await app.prisma.serviceTag.findMany({
			orderBy: { name: "asc" },
		});

		return reply.send({ tags });
	});

	app.post("/tags", async (request, reply) => {
		const { name } = validateRequest(tagCreateSchema, request.body);

		const tag = await app.prisma.serviceTag.upsert({
			where: { name },
			update: {},
			create: { name },
		});

		return reply.status(201).send({ tag });
	});

	app.delete("/tags/:id", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { id } = validateRequest(idParams, request.params);

		// Only delete tags that are associated with the current user's instances
		// (ServiceTag is shared, so verify at least one of the user's instances uses it)
		const userTag = await app.prisma.serviceInstanceTag.findFirst({
			where: { tagId: id, instance: { userId } },
		});

		if (!userTag) {
			return reply.status(404).send({ error: "Tag not found" });
		}

		await app.prisma.serviceTag.delete({
			where: { id },
		});
		return reply.status(204).send();
	});

	app.post("/services/test-connection", async (request, reply) => {
		const { baseUrl, apiKey, service, httpAuth } = validateRequest(
			z.object({
				baseUrl: credentialFreeUrlSchema,
				apiKey: z.string().min(1),
				httpAuth: httpAuthSchema.optional(),
				service: z
					.string()
					.min(1)
					.transform((s) => s.toLowerCase()),
			}),
			request.body,
		);

		// Validate URL scheme to prevent SSRF with non-HTTP schemes
		try {
			const parsed = new URL(baseUrl);
			if (!["http:", "https:"].includes(parsed.protocol)) {
				return reply.status(400).send({
					error: "Invalid URL scheme",
					details: "Base URL must use http:// or https://",
				});
			}
		} catch {
			return reply.status(400).send({
				error: "Invalid URL",
				details: "Base URL must be a valid URL",
			});
		}

		if (!(ALL_SERVICES as readonly string[]).includes(service)) {
			return reply.status(400).send({
				error: "Invalid service type",
				details: `Service must be one of: ${ALL_SERVICES.join(", ")}`,
			});
		}
		const httpAuthConflict = httpAuth ? getHttpAuthConflict(service) : null;
		if (httpAuthConflict) {
			return reply.status(400).send({
				error: `HTTP Basic Auth is not supported for ${service}`,
				details: httpAuthConflict,
			});
		}

		const result = httpAuth
			? await testServiceConnection(baseUrl, apiKey, service, httpAuth)
			: await testServiceConnection(baseUrl, apiKey, service);
		if (!result.success) {
			request.log.warn({ service, baseUrl }, "Connection test failed");

			app.notificationService
				?.notify({
					eventType: "SERVICE_CONNECTION_FAILED",
					title: `Connection test failed for ${service}`,
					body: result.error ?? `Failed to connect to ${service} at ${baseUrl}`,
					metadata: {
						service,
						baseUrl,
					},
				})
				.catch((err) => {
					request.log.warn({ err }, "Service connection failed notification dispatch failed");
				});
		}
		return reply.status(200).send(result);
	});

	app.post("/services/:id/test", async (request, reply) => {
		const { id } = validateRequest(idParams, request.params);
		const userId = request.currentUser!.id; // preHandler guarantees authentication

		const instance = await requireInstance(app, userId, id);

		const apiKey = app.encryptor.decrypt({
			value: instance.encryptedApiKey,
			iv: instance.encryptionIv,
		});
		const service = instance.service.toLowerCase();
		const requestBody = validateRequest(
			z.object({ httpAuth: httpAuthSchema.nullable().optional() }),
			request.body ?? {},
		);
		const storedHttpAuth = decryptHttpAuthCredentials(app.encryptor, instance);
		const httpAuth = requestBody.httpAuth === undefined ? storedHttpAuth : requestBody.httpAuth;
		const httpAuthConflict = httpAuth ? getHttpAuthConflict(service) : null;
		if (httpAuthConflict) {
			return reply.status(400).send({
				error: `HTTP Basic Auth is not supported for ${service}`,
				details: `${httpAuthConflict} Configure a proxy bypass for arr-dashboard.`,
			});
		}

		const result = httpAuth
			? await testServiceConnection(instance.baseUrl, apiKey, service, httpAuth)
			: await testServiceConnection(instance.baseUrl, apiKey, service);
		return reply.status(200).send(result);
	});

	done();
};

export const registerServiceRoutes = servicesRoute;
