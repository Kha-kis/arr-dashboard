import { ALL_SERVICES, arrServiceTypeSchema } from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { requireInstance } from "../lib/arr/instance-helpers.js";
import { withCleanupTopologyMutationLease } from "../lib/library-cleanup/cleanup-executor.js";
import { clearFileIdIndexCache } from "../lib/library-sync/infohash-backfill-by-inode.js";
import type { ServiceInstance, ServiceType } from "../lib/prisma.js";
import { withQuiObservationTopologyGuard } from "../lib/qui/observation-topology-guard.js";
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
import { validateRequest } from "../lib/utils/validate.js";
import { invalidatePulseCache } from "./pulse.js";

const idParams = z.object({ id: z.string().min(1) });

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

const serviceUpdateSchema = servicePayloadSchema
	.partial()
	.extend({
		// Override create-time defaults so omitted update fields remain omitted.
		enabled: z.boolean().optional(),
		isDefault: z.boolean().optional(),
		tags: z.array(z.string().min(1).max(64)).optional(),
		hasLocalFilesystemAccess: z.boolean().optional(),
	})
	.refine((data) => Object.keys(data).length > 0, {
		message: "At least one field must be provided",
	});

const tagCreateSchema = z.object({
	name: z.string().min(1).max(64),
});

const QUI_TOPOLOGY_UPDATE_FIELDS = [
	"service",
	"enabled",
	"baseUrl",
	"apiKey",
	"httpAuth",
	"hasLocalFilesystemAccess",
	"pathPrefix",
] as const;

function changesQuiTopology(
	existingService: ServiceType,
	payload: z.infer<typeof serviceUpdateSchema>,
): boolean {
	const targetService = (payload.service ?? existingService.toLowerCase()).toUpperCase();
	if (existingService !== "QUI" && targetService !== "QUI") return false;
	return QUI_TOPOLOGY_UPDATE_FIELDS.some((field) => Object.hasOwn(payload, field));
}

function changesJellyfinConnection(
	existing: Pick<ServiceInstance, "service" | "baseUrl" | "enabled">,
	payload: z.infer<typeof serviceUpdateSchema>,
): boolean {
	const targetService = (payload.service ?? existing.service.toLowerCase()).toUpperCase();
	const touchesJellyfin =
		existing.service === "JELLYFIN" ||
		existing.service === "EMBY" ||
		targetService === "JELLYFIN" ||
		targetService === "EMBY";
	if (!touchesJellyfin) return false;

	if (payload.service !== undefined && targetService !== existing.service) return true;
	if (payload.enabled !== undefined && payload.enabled !== existing.enabled) return true;
	if (payload.baseUrl !== undefined && payload.baseUrl !== existing.baseUrl) return true;
	// Secrets are intentionally not returned to the browser. Their presence in
	// an update therefore means the operator supplied a replacement value.
	if (Object.hasOwn(payload, "apiKey") || Object.hasOwn(payload, "httpAuth")) return true;

	return false;
}

async function clearDurableJellyfinCache(
	prisma: {
		jellyfinCache: { deleteMany(args: { where: { instanceId: string } }): Promise<unknown> };
		jellyfinEpisodeCache: { deleteMany(args: { where: { instanceId: string } }): Promise<unknown> };
		cacheRefreshStatus: {
			deleteMany(args: {
				where: { instanceId: string; cacheType: { in: string[] } };
			}): Promise<unknown>;
		};
	},
	instanceId: string,
): Promise<void> {
	await prisma.jellyfinCache.deleteMany({ where: { instanceId } });
	await prisma.jellyfinEpisodeCache.deleteMany({ where: { instanceId } });
	await prisma.cacheRefreshStatus.deleteMany({
		where: { instanceId, cacheType: { in: ["jellyfin", "jellyfin_episode"] } },
	});
}

async function clearDurableQuiObservations(
	prisma: {
		libraryCache: {
			updateMany(args: {
				where: { instance: { userId: string } };
				data: {
					torrentState: null;
					torrentRatio: null;
					torrentSyncedAt: null;
				};
			}): Promise<unknown>;
		};
		episodeFileCache: {
			updateMany(args: {
				where: { instance: { userId: string } };
				data: {
					torrentState: null;
					torrentRatio: null;
					torrentSyncedAt: null;
				};
			}): Promise<unknown>;
		};
	},
	userId: string,
): Promise<void> {
	const where = { instance: { userId } };
	const data = {
		torrentState: null,
		torrentRatio: null,
		torrentSyncedAt: null,
	} as const;
	await prisma.libraryCache.updateMany({ where, data });
	await prisma.episodeFileCache.updateMany({ where, data });
}

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

				const createInstance = (prisma: Pick<typeof app.prisma, "serviceInstance">) =>
					prisma.serviceInstance.create({
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
				const created =
					serviceEnum === "QUI"
						? await withQuiObservationTopologyGuard(userId, () =>
								app.prisma.$transaction(async (tx) => {
									const instance = await createInstance(tx);
									await clearDurableQuiObservations(tx, userId);
									return instance;
								}),
							)
						: await createInstance(app.prisma);

				request.log.info({ service, label: rest.label }, "Service instance added");

				return reply.status(201).send({
					service: formatServiceInstance(created),
				});
			},
		);
	});

	app.put("/services/:id", async (request, reply) => {
		const { id } = validateRequest(idParams, request.params);
		const payload = validateRequest(serviceUpdateSchema, request.body);
		const userId = request.currentUser!.id;

		return await withCleanupTopologyMutationLease(
			{ prisma: app.prisma, log: request.log },
			userId,
			async () => {
				const existing = await requireInstance(app, userId, id);
				const targetServiceName = payload.service ?? existing.service.toLowerCase();
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

				const updateData = buildUpdateData(payload, app.encryptor);

				const targetService = (
					payload.service ?? existing.service.toLowerCase()
				).toUpperCase() as ServiceType;
				const resetOtherDefaults = async (
					prisma: Pick<typeof app.prisma, "serviceInstance">,
				): Promise<void> => {
					if (payload.isDefault === true || payload.service) {
						await prisma.serviceInstance.updateMany({
							where: { service: targetService, userId, NOT: { id } },
							data: { isDefault: false },
						});
					}
				};

				const quiTopologyChanged = changesQuiTopology(existing.service, payload);
				const jellyfinConnectionChanged = changesJellyfinConnection(existing, payload);
				const serviceUpdateData = jellyfinConnectionChanged
					? {
							...updateData,
							// Make the connection generation strictly newer even when two
							// updates land within the database timestamp's clock resolution.
							updatedAt: new Date(Math.max(Date.now(), existing.updatedAt.getTime() + 1)),
						}
					: updateData;
				if (quiTopologyChanged) {
					await withQuiObservationTopologyGuard(userId, async () => {
						await app.prisma.$transaction(async (tx) => {
							await resetOtherDefaults(tx);
							await tx.serviceInstance.updateMany({
								where: { id, userId },
								data: serviceUpdateData,
							});
							if (payload.tags !== undefined) {
								await updateInstanceTags(tx, id, payload.tags);
							}
							if (jellyfinConnectionChanged) {
								await clearDurableJellyfinCache(tx, id);
							}
							await clearDurableQuiObservations(tx, userId);
						});
						// Keep process-local evidence in the same guarded topology
						// transition. Releasing the guard first would allow another
						// observer to reuse the previous endpoint's inode inventory.
						invalidateTorrentListCache(id);
						clearFileIdIndexCache(id);
					});
				} else if (jellyfinConnectionChanged) {
					await app.prisma.$transaction(async (tx) => {
						await resetOtherDefaults(tx);
						await tx.serviceInstance.updateMany({
							where: { id, userId },
							data: serviceUpdateData,
						});
						if (payload.tags !== undefined) {
							await updateInstanceTags(tx, id, payload.tags);
						}
						await clearDurableJellyfinCache(tx, id);
					});
				} else {
					await resetOtherDefaults(app.prisma);
					await app.prisma.serviceInstance.updateMany({
						where: { id, userId },
						data: serviceUpdateData,
					});
					if (payload.tags !== undefined) {
						await updateInstanceTags(app.prisma, id, payload.tags);
					}
				}
				if (jellyfinConnectionChanged) {
					invalidatePulseCache(userId);
				}

				// A qUI topology change invalidates both durable observations
				// (inside the transaction above) and process-local data keyed
				// by this instance. Connection, credential, enabled-state, and
				// filesystem/path-mapping changes participate in one conservative
				// topology generation so no observer can reuse evidence produced
				// before a concurrent physical-evidence mutation.
				const wasQui = existing.service === "QUI";
				const nowDisabled = payload.enabled === false && existing.enabled === true;
				const switchedAwayFromQui =
					payload.service !== undefined && payload.service.toLowerCase() !== "qui";
				if (quiTopologyChanged) {
					request.log.info(
						{
							instanceId: id,
							reason: nowDisabled
								? "disabled"
								: switchedAwayFromQui
									? "service-changed"
									: wasQui
										? "connection-changed"
										: "qui-enabled",
						},
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
		const userId = request.currentUser!.id; // preHandler guarantees authentication

		return await withCleanupTopologyMutationLease(
			{ prisma: app.prisma, log: request.log },
			userId,
			async () => {
				const existing = await requireInstance(app, userId, id);
				if (existing.service === "QUI") {
					await withQuiObservationTopologyGuard(userId, async () => {
						await app.prisma.$transaction(async (tx) => {
							await tx.serviceInstance.delete({ where: { id, userId } });
							await clearDurableQuiObservations(tx, userId);
						});
						invalidateTorrentListCache(id);
						clearFileIdIndexCache(id);
					});
				} else {
					await app.prisma.serviceInstance.delete({ where: { id, userId } });
					invalidateTorrentListCache(id);
					clearFileIdIndexCache(id);
				}

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
