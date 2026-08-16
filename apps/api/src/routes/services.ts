import {
	ALL_SERVICES,
	type AnalyticsProvider,
	analyticsProviderSchema,
	arrServiceTypeSchema,
} from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { resolveAnalyticsProviderSelection } from "../lib/analytics/provider-selection.js";
import { requireInstance } from "../lib/arr/instance-helpers.js";
import { AppValidationError, ConflictError } from "../lib/errors.js";
import {
	withCleanupTopologyMutationLease,
	withExclusiveCleanupTopologyMutationLease,
} from "../lib/library-cleanup/cleanup-executor.js";
import { clearFileIdIndexCache } from "../lib/library-sync/infohash-backfill-by-inode.js";
import type { ServiceInstance, ServiceType } from "../lib/prisma.js";
import { withQuiObservationTopologyGuard } from "../lib/qui/observation-topology-guard.js";
import { invalidateTorrentListCache } from "../lib/qui/torrent-list-cache.js";
import { testServiceConnection } from "../lib/services/connection-tester.js";
import {
	createHttpAuthHeaders,
	decryptHttpAuthCredentials,
	encryptHttpAuthCredentials,
} from "../lib/services/http-auth.js";
import {
	credentialFreeUrlSchema,
	getHttpAuthConflict,
	httpAuthSchema,
} from "../lib/services/http-auth-validation.js";
import { formatServiceInstance } from "../lib/services/service-formatter.js";
import {
	type ProviderIdentityObservation,
	readProviderIdentity,
} from "../lib/services/service-identity.js";
import {
	clearDurableProviderCacheState,
	confirmsIdentityCandidate,
	createProviderReplacementAuthority,
	expireApprovalsForProviderReplacement,
	initialVerifiedIdentityData,
	isProviderIdentityService,
	replacementIdentityData,
	toPersistedIdentityKind,
	toSafeIdentityCandidate,
	verifiedIdentityData,
} from "../lib/services/service-identity-lifecycle.js";
import { updateInstanceTags, upsertTags } from "../lib/services/tag-manager.js";
import { buildUpdateData } from "../lib/services/update-builder.js";
import { assertNoActiveDeploymentOwnership } from "../lib/trash-guides/deployment-operation-gate.js";
import {
	assertEquivalentDeploymentMappingAuthority,
	createDeploymentConnectionBinding,
	createDeploymentConnectionStateToken,
	createDeploymentEndpointKey,
	getEquivalentServiceInstanceIds,
	isCurrentDeploymentConnectionMapping,
	normalizeDeploymentBaseUrl,
} from "../lib/trash-guides/deployment-target.js";
import { assertNoActiveTrashRecoveryForInstance } from "../lib/trash-guides/recovery-evidence.js";
import { validateRequest } from "../lib/utils/validate.js";
import { invalidatePulseCache } from "./pulse.js";

const idParams = z.object({ id: z.string().min(1) });
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

const serviceUpdateSchema = servicePayloadSchema
	.partial()
	.extend({
		// Override create-time defaults so omitted update fields remain omitted.
		enabled: z.boolean().optional(),
		isDefault: z.boolean().optional(),
		tags: z.array(z.string().min(1).max(64)).optional(),
		hasLocalFilesystemAccess: z.boolean().optional(),
		confirmAnalyticsUnavailableFor: analyticsProviderSchema.optional(),
	})
	.refine((data) => Object.keys(data).some((key) => key !== "confirmAnalyticsUnavailableFor"), {
		message: "At least one field must be provided",
	});

type AnalyticsProviderLifecycleChange =
	| { kind: "delete" }
	| { kind: "update"; targetService: ServiceType; targetEnabled: boolean }
	| { kind: "replace"; targetService: ServiceType; targetEnabled: boolean };

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

const serviceCandidateSchema = servicePayloadSchema.partial().extend({
	enabled: z.boolean().optional(),
	isDefault: z.boolean().optional(),
	tags: z.array(z.string().min(1).max(64)).optional(),
	hasLocalFilesystemAccess: z.boolean().optional(),
});

const identityInspectSchema = z.object({
	candidate: serviceCandidateSchema.optional(),
});

const identityConfirmationSchema = z.object({
	confirmationDigest: z.string().regex(/^[a-f0-9]{64}$/i),
	expectedConnectionGeneration: z.number().int().nonnegative(),
	expectedIdentityGeneration: z.number().int().nonnegative(),
});

const identityReplaceSchema = identityConfirmationSchema.extend({
	candidate: serviceCandidateSchema.default({}),
	confirmAnalyticsUnavailableFor: analyticsProviderSchema.optional(),
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
const CACHE_PROVIDER_SERVICES = new Set<ServiceType>(["PLEX", "TAUTULLI", "JELLYFIN", "EMBY"]);

type ServiceUpdatePayload = z.infer<typeof serviceUpdateSchema>;
type ServiceCandidatePayload = z.infer<typeof serviceCandidateSchema>;

function isArrService(service: ServiceType): boolean {
	return service === "RADARR" || service === "SONARR";
}

function changesQuiTopology(existingService: ServiceType, payload: ServiceUpdatePayload): boolean {
	const targetService = (payload.service ?? existingService.toLowerCase()).toUpperCase();
	if (existingService !== "QUI" && targetService !== "QUI") return false;
	return QUI_TOPOLOGY_UPDATE_FIELDS.some((field) => Object.hasOwn(payload, field));
}

function changesCacheProviderConnection(
	existing: Pick<ServiceInstance, "service" | "baseUrl" | "enabled">,
	payload: z.infer<typeof serviceUpdateSchema>,
): boolean {
	const targetService = (payload.service ?? existing.service.toLowerCase()).toUpperCase();
	if (
		!CACHE_PROVIDER_SERVICES.has(existing.service) &&
		!CACHE_PROVIDER_SERVICES.has(targetService as ServiceType)
	) {
		return false;
	}

	if (payload.service !== undefined && targetService !== existing.service) return true;
	if (payload.enabled !== undefined && payload.enabled !== existing.enabled) return true;
	if (payload.baseUrl !== undefined && payload.baseUrl !== existing.baseUrl) return true;
	// Secrets are intentionally not returned to the browser. Their presence in
	// an update therefore means the operator supplied a replacement value.
	if (Object.hasOwn(payload, "apiKey") || Object.hasOwn(payload, "httpAuth")) return true;

	return false;
}

function createIdentityConflict(
	code:
		| "IDENTITY_CANDIDATE_CHANGED"
		| "IDENTITY_GENERATION_STALE"
		| "IDENTITY_REPLACEMENT_REQUIRED",
	message: string,
	instance: Pick<ServiceInstance, "connectionGeneration" | "identityGeneration">,
	candidate?: ReturnType<typeof toSafeIdentityCandidate>,
): ConflictError {
	return new ConflictError(message, {
		code,
		...(candidate ? { candidate } : {}),
		connectionGeneration: instance.connectionGeneration,
		identityGeneration: instance.identityGeneration,
	});
}

function buildIdentityCandidateSnapshot(
	instance: ServiceInstance,
	candidate: ServiceCandidatePayload,
	encryptor: { decrypt(input: { value: string; iv: string }): string },
) {
	const service = (candidate.service ?? instance.service.toLowerCase()).toUpperCase();
	if (!isProviderIdentityService(service)) {
		throw new AppValidationError(
			"Provider identity verification is not supported for this service.",
		);
	}
	const storedHttpAuth = decryptHttpAuthCredentials(encryptor, instance);
	const httpAuth = candidate.httpAuth === undefined ? storedHttpAuth : candidate.httpAuth;
	const httpAuthConflict = httpAuth ? getHttpAuthConflict(service) : null;
	if (httpAuthConflict) {
		throw new AppValidationError(`${httpAuthConflict} Configure a proxy bypass for arr-dashboard.`);
	}
	return {
		service,
		baseUrl: candidate.baseUrl ?? instance.baseUrl,
		apiKey:
			candidate.apiKey ??
			encryptor.decrypt({ value: instance.encryptedApiKey, iv: instance.encryptionIv }),
		httpAuthHeaders: createHttpAuthHeaders(httpAuth),
		label: candidate.label ?? instance.label,
	};
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
	async function deleteArrAliasWithStateMigration(
		userId: string,
		existing: ServiceInstance,
	): Promise<void> {
		await app.deploymentExecutor.runWithEndpointMutation(
			userId,
			existing,
			"ARR service alias deletion",
			async (endpointKey) => {
				const current = await requireInstance(app, userId, existing.id);
				const currentCredentialIdentity =
					app.arrClientFactory.createConnectionCredentialIdentity(current);
				if (
					createDeploymentEndpointKey(userId, {
						...current,
						credentialIdentity: currentCredentialIdentity,
					}) !== endpointKey ||
					createDeploymentConnectionStateToken(current) !==
						createDeploymentConnectionStateToken(existing)
				) {
					throw new ConflictError(
						"The ARR service connection changed while alias deletion was starting.",
					);
				}

				await app.prisma.$transaction(async (tx) => {
					const aliases = await tx.serviceInstance.findMany({
						where: { userId, service: current.service },
					});
					const aliasesWithIdentity = aliases.map((alias) => ({
						...alias,
						credentialIdentity: app.arrClientFactory.createConnectionCredentialIdentity(alias),
					}));
					const endpointInstanceIds = getEquivalentServiceInstanceIds(aliasesWithIdentity, {
						...current,
						credentialIdentity: currentCredentialIdentity,
					});
					const endpointAliases = aliases.filter((alias) => endpointInstanceIds.includes(alias.id));
					if (!endpointAliases.some((alias) => alias.id === current.id)) {
						throw new ConflictError(
							"The ARR alias topology changed before deletion could be authorized.",
						);
					}
					const durableDeploymentState = await tx.serviceInstance.findFirst({
						where: {
							id: current.id,
							userId,
							OR: [
								{ trashSchedules: { some: {} } },
								{ standaloneCFDeployments: { some: {} } },
								{ qualitySizeMapping: { isNot: null } },
								{ namingConfig: { isNot: null } },
								{
									namingDeployHistory: {
										some: {
											status: { in: ["PENDING", "SUCCESS"] },
											rolledBack: false,
										},
									},
								},
							],
						},
						select: { id: true },
					});
					if (durableDeploymentState) {
						throw new ConflictError(
							"This ARR alias has deployment history or managed configuration that would be lost by deletion. Remove or migrate that state before deleting the service.",
						);
					}
					const [mappings, overrides] = await Promise.all([
						tx.templateQualityProfileMapping.findMany({
							where: { instanceId: { in: endpointInstanceIds } },
							include: {
								template: { select: { userId: true } },
								instance: { select: { userId: true } },
							},
						}),
						tx.instanceQualityProfileOverride.findMany({
							where: { instanceId: { in: endpointInstanceIds } },
							include: { instance: { select: { userId: true } } },
						}),
					]);
					if (
						mappings.some(
							(mapping) => mapping.template.userId !== userId || mapping.instance.userId !== userId,
						) ||
						overrides.some(
							(override) => override.userId !== userId || override.instance.userId !== userId,
						)
					) {
						throw new ConflictError(
							"Saved ARR profile state has inconsistent ownership and cannot be migrated or deleted.",
						);
					}
					if (overrides.some((override) => override.status !== "APPLIED")) {
						throw new ConflictError(
							"This ARR endpoint has unresolved score intent. Reconcile it before deleting an alias.",
						);
					}

					const sourceMappings = mappings.filter((mapping) => mapping.instanceId === current.id);
					const sourceOverrides = overrides.filter(
						(override) => override.instanceId === current.id,
					);
					const hasMigratableState = sourceMappings.length > 0 || sourceOverrides.length > 0;
					const exactSurvivors = endpointAliases.filter((alias) => alias.id !== current.id);
					if (hasMigratableState && exactSurvivors.length !== 1) {
						throw new ConflictError(
							"Saved profile state cannot be migrated because no single exact surviving ARR alias exists.",
						);
					}

					const survivor = exactSurvivors[0];
					if (survivor && hasMigratableState) {
						const sourceBindings = [
							createDeploymentConnectionBinding(current, currentCredentialIdentity),
						];
						const survivorBindings = [
							createDeploymentConnectionBinding(
								survivor,
								app.arrClientFactory.createConnectionCredentialIdentity(survivor),
							),
						];
						if (
							sourceMappings.some(
								(mapping) => !isCurrentDeploymentConnectionMapping(mapping, sourceBindings),
							) ||
							sourceOverrides.some(
								(override) => !isCurrentDeploymentConnectionMapping(override, sourceBindings),
							)
						) {
							throw new ConflictError(
								"The deleting ARR alias has stale saved profile state that requires manual reconciliation.",
							);
						}
						const survivorMappings = mappings.filter(
							(mapping) => mapping.instanceId === survivor.id,
						);
						const survivorOverrides = overrides.filter(
							(override) => override.instanceId === survivor.id,
						);
						if (
							survivorMappings.some(
								(mapping) => !isCurrentDeploymentConnectionMapping(mapping, survivorBindings),
							) ||
							survivorOverrides.some(
								(override) => !isCurrentDeploymentConnectionMapping(override, survivorBindings),
							)
						) {
							throw new ConflictError(
								"The surviving ARR alias has stale saved profile state that requires manual reconciliation.",
							);
						}

						for (const mapping of sourceMappings) {
							const target = survivorMappings.find(
								(candidate) => candidate.qualityProfileId === mapping.qualityProfileId,
							);
							if (target) {
								if (target.templateId !== mapping.templateId) {
									throw new ConflictError(
										"Equivalent ARR aliases have conflicting template mappings.",
									);
								}
								assertEquivalentDeploymentMappingAuthority([mapping, target]);
								const deleted = await tx.templateQualityProfileMapping.deleteMany({
									where: {
										id: mapping.id,
										instanceId: current.id,
										connectionGeneration: mapping.connectionGeneration,
										connectionStateToken: mapping.connectionStateToken,
									},
								});
								if (deleted.count !== 1) {
									throw new ConflictError("The ARR alias mapping changed during deletion.");
								}
								continue;
							}
							const migrated = await tx.templateQualityProfileMapping.updateMany({
								where: {
									id: mapping.id,
									instanceId: current.id,
									connectionGeneration: mapping.connectionGeneration,
									connectionStateToken: mapping.connectionStateToken,
								},
								data: {
									instanceId: survivor.id,
									connectionGeneration: survivor.connectionGeneration,
									connectionStateToken: createDeploymentConnectionStateToken(survivor),
								},
							});
							if (migrated.count !== 1) {
								throw new ConflictError("The ARR alias mapping changed during migration.");
							}
						}

						for (const override of sourceOverrides) {
							const target = survivorOverrides.find(
								(candidate) =>
									candidate.qualityProfileId === override.qualityProfileId &&
									candidate.customFormatId === override.customFormatId,
							);
							if (target) {
								if (target.status !== "APPLIED" || target.score !== override.score) {
									throw new ConflictError(
										"Equivalent ARR aliases have conflicting saved score overrides.",
									);
								}
								const deleted = await tx.instanceQualityProfileOverride.deleteMany({
									where: {
										id: override.id,
										instanceId: current.id,
										status: "APPLIED",
										userId,
									},
								});
								if (deleted.count !== 1) {
									throw new ConflictError("The ARR alias override changed during deletion.");
								}
								continue;
							}
							const migrated = await tx.instanceQualityProfileOverride.updateMany({
								where: {
									id: override.id,
									instanceId: current.id,
									status: "APPLIED",
									userId,
									connectionGeneration: override.connectionGeneration,
									connectionStateToken: override.connectionStateToken,
								},
								data: {
									instanceId: survivor.id,
									connectionGeneration: survivor.connectionGeneration,
									connectionStateToken: createDeploymentConnectionStateToken(survivor),
								},
							});
							if (migrated.count !== 1) {
								throw new ConflictError("The ARR alias override changed during migration.");
							}
						}
					}

					await tx.serviceInstance.delete({ where: { id: current.id, userId } });
				});
			},
		);
	}

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
		let identityData = {};
		if (isProviderIdentityService(serviceEnum)) {
			try {
				const observation = await readProviderIdentity(
					{
						service: serviceEnum,
						baseUrl: rest.baseUrl,
						apiKey,
						httpAuthHeaders: createHttpAuthHeaders(httpAuth ?? null),
						label: rest.label,
					},
					request.log,
				);
				identityData = initialVerifiedIdentityData(observation);
			} catch {
				throw new AppValidationError(
					"The provider identity could not be verified, so the service was not added.",
				);
			}
		}

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
							...identityData,
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
		const { confirmAnalyticsUnavailableFor, ...payload } = validateRequest(
			serviceUpdateSchema,
			request.body,
		);
		const userId = request.currentUser!.id;

		const withTopologyLease =
			payload.enabled === false
				? withExclusiveCleanupTopologyMutationLease
				: withCleanupTopologyMutationLease;
		return await withTopologyLease({ prisma: app.prisma, log: request.log }, userId, async () => {
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
			const providerConnectionChanged = changesCacheProviderConnection(existing, payload);
			const serviceTypeChanged = targetService !== existing.service;
			const leavesProviderIdentityFamily =
				serviceTypeChanged &&
				isProviderIdentityService(existing.service) &&
				!isProviderIdentityService(targetService);
			const providerIdentityReadRequired =
				providerConnectionChanged &&
				isProviderIdentityService(targetService) &&
				(serviceTypeChanged ||
					payload.baseUrl !== undefined ||
					payload.apiKey !== undefined ||
					payload.httpAuth !== undefined);
			if (providerIdentityReadRequired) {
				let observation: ProviderIdentityObservation;
				try {
					observation = await readProviderIdentity(
						buildIdentityCandidateSnapshot(existing, payload, app.encryptor),
						request.log,
					);
				} catch {
					throw new AppValidationError(
						"The provider identity could not be verified, so the service connection was not changed.",
					);
				}
				if (
					existing.expectedIdentity !== null &&
					(existing.expectedIdentity !== observation.rawIdentity ||
						existing.identityKind !== toPersistedIdentityKind(observation.identityKind))
				) {
					throw createIdentityConflict(
						"IDENTITY_REPLACEMENT_REQUIRED",
						"The provider identity differs from the enrolled server. Replace the server explicitly.",
						existing,
						toSafeIdentityCandidate(observation),
					);
				}
			}
			const targetConnection = {
				...existing,
				...updateData,
				service: targetService,
			};
			const arrConnectionInvolved = isArrService(existing.service) || isArrService(targetService);
			const arrCredentialFieldsSubmitted =
				payload.apiKey !== undefined || payload.httpAuth !== undefined;
			const arrCredentialsChanged =
				arrConnectionInvolved &&
				arrCredentialFieldsSubmitted &&
				app.arrClientFactory.createConnectionCredentialIdentity(existing) !==
					app.arrClientFactory.createConnectionCredentialIdentity(targetConnection);
			if (arrConnectionInvolved && arrCredentialFieldsSubmitted && !arrCredentialsChanged) {
				if (payload.apiKey !== undefined) {
					delete updateData.encryptedApiKey;
					delete updateData.encryptionIv;
				}
				if (payload.httpAuth !== undefined) {
					delete updateData.encryptedHttpAuthCredentials;
					delete updateData.httpAuthEncryptionIv;
				}
			}
			const arrConnectionFieldsSubmitted =
				serviceTypeChanged || payload.baseUrl !== undefined || arrCredentialFieldsSubmitted;
			const arrConnectionChanged =
				arrConnectionInvolved &&
				arrConnectionFieldsSubmitted &&
				(serviceTypeChanged ||
					normalizeDeploymentBaseUrl(existing.baseUrl) !==
						normalizeDeploymentBaseUrl(targetConnection.baseUrl) ||
					arrCredentialsChanged);
			const executeUpdate = async () => {
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
					const unresolvedIntents = await app.prisma.instanceQualityProfileOverride.findMany({
						where: {
							userId,
							instanceId: { in: equivalentInstanceIds },
							status: { in: ["PENDING", "UNCERTAIN"] },
						},
					});
					if (unresolvedIntents.length > 0) {
						throw new ConflictError(
							"This ARR endpoint has unresolved score intent. Reconcile it before changing the connection.",
						);
					}
					await assertNoActiveDeploymentOwnership(app.prisma, userId, equivalentInstanceIds);
				}
				const serviceUpdateData =
					arrConnectionChanged || providerConnectionChanged
						? {
								...updateData,
								connectionGeneration: { increment: 1 },
							}
						: updateData;
				const updateDataWithResetProviderIdentity = leavesProviderIdentityFamily
					? {
							...serviceUpdateData,
							expectedIdentity: null,
							identityKind: null,
							identityStatus: "UNVERIFIED" as const,
							identityGeneration: { increment: 1 },
							identityVerifiedAt: null,
							identityLastCheckedAt: null,
						}
					: serviceUpdateData;
				if (quiTopologyChanged) {
					await withQuiObservationTopologyGuard(userId, async () => {
						await app.prisma.$transaction(async (tx) => {
							await resetOtherDefaults(tx);
							await tx.serviceInstance.updateMany({
								where: { id, userId },
								data: updateDataWithResetProviderIdentity,
							});
							if (payload.tags !== undefined) {
								await updateInstanceTags(tx, id, payload.tags);
							}
							if (providerConnectionChanged) {
								await clearDurableProviderCacheState(tx, id);
							}
							await clearDurableQuiObservations(tx, userId);
						});
						// Keep process-local evidence in the same guarded topology
						// transition. Releasing the guard first would allow another
						// observer to reuse the previous endpoint's inode inventory.
						invalidateTorrentListCache(id);
						clearFileIdIndexCache(id);
					});
				} else if (providerConnectionChanged || serviceTypeChanged || arrConnectionChanged) {
					await app.prisma.$transaction(async (tx) => {
						await resetOtherDefaults(tx);
						await tx.serviceInstance.updateMany({
							where: { id, userId },
							data: updateDataWithResetProviderIdentity,
						});
						if (payload.tags !== undefined) {
							await updateInstanceTags(tx, id, payload.tags);
						}
						if (providerConnectionChanged) {
							await clearDurableProviderCacheState(tx, id);
						}
					});
				} else {
					await resetOtherDefaults(app.prisma);
					await app.prisma.serviceInstance.updateMany({
						where: { id, userId },
						data: updateDataWithResetProviderIdentity,
					});
					if (payload.tags !== undefined) {
						await updateInstanceTags(app.prisma, id, payload.tags);
					}
				}
				if (providerConnectionChanged || serviceTypeChanged) {
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
			};

			if (arrConnectionChanged && isArrService(existing.service)) {
				return await app.deploymentExecutor.runWithEndpointMutation(
					userId,
					existing,
					"ARR connection replacement",
					async (expectedEndpointKey) => {
						const current = await requireInstance(app, userId, id);
						const currentEndpointKey = createDeploymentEndpointKey(userId, {
							service: current.service,
							baseUrl: current.baseUrl,
							credentialIdentity: app.arrClientFactory.createConnectionCredentialIdentity(current),
						});
						if (
							currentEndpointKey !== expectedEndpointKey ||
							createDeploymentConnectionStateToken(current) !==
								createDeploymentConnectionStateToken(existing)
						) {
							throw new ConflictError(
								"The ARR connection changed while the replacement was starting. Review it and try again.",
							);
						}
						return await executeUpdate();
					},
				);
			}

			return await executeUpdate();
		});
	});

	app.post("/services/:id/identity/inspect", async (request, reply) => {
		const { id } = validateRequest(idParams, request.params);
		const { candidate = {} } = validateRequest(identityInspectSchema, request.body ?? {});
		const userId = request.currentUser!.id;
		const existing = await requireInstance(app, userId, id);
		const snapshot = buildIdentityCandidateSnapshot(existing, candidate, app.encryptor);
		const observation = await readProviderIdentity(snapshot, request.log);

		return reply.send({
			candidate: toSafeIdentityCandidate(observation),
			connectionGeneration: existing.connectionGeneration,
			identityGeneration: existing.identityGeneration,
		});
	});

	app.post("/services/:id/identity/verify", async (request, reply) => {
		const { id } = validateRequest(idParams, request.params);
		const confirmation = validateRequest(identityConfirmationSchema, request.body);
		const userId = request.currentUser!.id;

		return await withExclusiveCleanupTopologyMutationLease(
			{ prisma: app.prisma, log: request.log },
			userId,
			async () => {
				const existing = await requireInstance(app, userId, id);
				if (
					existing.connectionGeneration !== confirmation.expectedConnectionGeneration ||
					existing.identityGeneration !== confirmation.expectedIdentityGeneration
				) {
					throw createIdentityConflict(
						"IDENTITY_GENERATION_STALE",
						"The service changed after identity inspection. Inspect it again before verifying.",
						existing,
					);
				}
				const observation = await readProviderIdentity(
					buildIdentityCandidateSnapshot(existing, {}, app.encryptor),
					request.log,
				);
				const safeCandidate = toSafeIdentityCandidate(observation);
				if (!confirmsIdentityCandidate(observation, confirmation.confirmationDigest)) {
					throw createIdentityConflict(
						"IDENTITY_CANDIDATE_CHANGED",
						"The provider identity changed after inspection. Inspect it again before verifying.",
						existing,
						safeCandidate,
					);
				}
				if (existing.expectedIdentity && existing.expectedIdentity !== observation.rawIdentity) {
					throw createIdentityConflict(
						"IDENTITY_REPLACEMENT_REQUIRED",
						"The provider identity differs from the enrolled server. Replace the server explicitly.",
						existing,
						safeCandidate,
					);
				}

				const verified = verifiedIdentityData(existing, observation);
				const updated = await app.prisma.$transaction(async (tx) =>
					tx.serviceInstance.updateMany({
						where: {
							id,
							userId,
							connectionGeneration: confirmation.expectedConnectionGeneration,
							identityGeneration: confirmation.expectedIdentityGeneration,
						},
						data: verified,
					}),
				);
				if (updated.count !== 1) {
					const current = await requireInstance(app, userId, id);
					throw createIdentityConflict(
						"IDENTITY_GENERATION_STALE",
						"The service changed while identity verification was being saved.",
						current,
					);
				}

				const fresh = await app.prisma.serviceInstance.findFirst({
					where: { id, userId },
					include: { tags: { include: { tag: true } } },
				});
				if (!fresh) return reply.status(404).send({ error: "Service instance not found" });
				return reply.send({ service: formatServiceInstance(fresh) });
			},
		);
	});

	app.post("/services/:id/identity/replace", async (request, reply) => {
		const { id } = validateRequest(idParams, request.params);
		const { candidate, confirmAnalyticsUnavailableFor, ...confirmation } = validateRequest(
			identityReplaceSchema,
			request.body,
		);
		const userId = request.currentUser!.id;

		return await withExclusiveCleanupTopologyMutationLease(
			{ prisma: app.prisma, log: request.log },
			userId,
			async () => {
				const existing = await requireInstance(app, userId, id);
				const authorityIsCurrent =
					existing.connectionGeneration === confirmation.expectedConnectionGeneration &&
					existing.identityGeneration === confirmation.expectedIdentityGeneration;
				const mayBeIdempotentRetry =
					existing.identityGeneration === confirmation.expectedIdentityGeneration + 1 &&
					(existing.connectionGeneration === confirmation.expectedConnectionGeneration ||
						existing.connectionGeneration === confirmation.expectedConnectionGeneration + 1);
				if (!authorityIsCurrent && !mayBeIdempotentRetry) {
					throw createIdentityConflict(
						"IDENTITY_GENERATION_STALE",
						"The service changed after identity inspection. Inspect it again before replacing.",
						existing,
					);
				}
				const observation = await readProviderIdentity(
					buildIdentityCandidateSnapshot(existing, candidate, app.encryptor),
					request.log,
				);
				const safeCandidate = toSafeIdentityCandidate(observation);
				if (!confirmsIdentityCandidate(observation, confirmation.confirmationDigest)) {
					throw createIdentityConflict(
						"IDENTITY_CANDIDATE_CHANGED",
						"The provider identity changed after inspection. Inspect it again before replacing.",
						existing,
						safeCandidate,
					);
				}

				const alreadyReplaced =
					mayBeIdempotentRetry &&
					existing.identityStatus === "VERIFIED" &&
					existing.expectedIdentity === observation.rawIdentity &&
					existing.identityKind === toPersistedIdentityKind(observation.identityKind) &&
					existing.identityGeneration === confirmation.expectedIdentityGeneration + 1;
				if (alreadyReplaced) {
					const fresh = await app.prisma.serviceInstance.findFirst({
						where: { id, userId },
						include: { tags: { include: { tag: true } } },
					});
					if (!fresh) return reply.status(404).send({ error: "Service instance not found" });
					return reply.send({ service: formatServiceInstance(fresh) });
				}
				if (!authorityIsCurrent) {
					throw createIdentityConflict(
						"IDENTITY_GENERATION_STALE",
						"The service changed after identity inspection. Inspect it again before replacing.",
						existing,
						safeCandidate,
					);
				}

				const replacementService = (
					candidate.service ?? existing.service
				).toUpperCase() as ServiceType;
				const analyticsConfirmation = await getAnalyticsProviderConfirmationRequirement(
					app.prisma,
					userId,
					existing,
					{
						kind: "replace",
						targetService: replacementService,
						targetEnabled: candidate.enabled ?? existing.enabled,
					},
				);
				if (
					analyticsConfirmation &&
					confirmAnalyticsUnavailableFor !== analyticsConfirmation.selected
				) {
					return reply.status(409).send({
						code: "ANALYTICS_PROVIDER_CONFIRMATION_REQUIRED",
						...analyticsConfirmation,
					});
				}

				const connectionChanged = changesCacheProviderConnection(existing, candidate);
				const replacedProviderAuthority = createProviderReplacementAuthority(existing);
				if (!replacedProviderAuthority) {
					throw new ConflictError(
						"The existing provider identity is unavailable; inspect the service again before replacing.",
					);
				}
				const replacementData = {
					...buildUpdateData(candidate, app.encryptor),
					...(connectionChanged ? { connectionGeneration: existing.connectionGeneration + 1 } : {}),
					...replacementIdentityData(existing, observation),
				};
				const replaced = await app.prisma.$transaction(async (tx) => {
					const updated = await tx.serviceInstance.updateMany({
						where: {
							id,
							userId,
							connectionGeneration: confirmation.expectedConnectionGeneration,
							identityGeneration: confirmation.expectedIdentityGeneration,
						},
						data: replacementData,
					});
					if (updated.count !== 1) return false;
					if (candidate.isDefault === true || candidate.service !== undefined) {
						await tx.serviceInstance.updateMany({
							where: { service: replacementService, userId, NOT: { id } },
							data: { isDefault: false },
						});
					}
					if (candidate.tags !== undefined) {
						await updateInstanceTags(tx, id, candidate.tags);
					}
					await clearDurableProviderCacheState(tx, id);
					await expireApprovalsForProviderReplacement(tx, userId, replacedProviderAuthority);
					return true;
				});
				if (!replaced) {
					const current = await requireInstance(app, userId, id);
					throw createIdentityConflict(
						"IDENTITY_GENERATION_STALE",
						"The service changed while replacement was being saved.",
						current,
						safeCandidate,
					);
				}

				invalidatePulseCache(userId);
				const fresh = await app.prisma.serviceInstance.findFirst({
					where: { id, userId },
					include: { tags: { include: { tag: true } } },
				});
				if (!fresh) return reply.status(404).send({ error: "Service instance not found" });
				return reply.send({ service: formatServiceInstance(fresh) });
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
					// Re-check after exclusive ownership is established. This is the
					// execution-time authority check before the cascading delete.
					await assertNoActiveTrashRecoveryForInstance(app.prisma, userId, id);
					await deleteArrAliasWithStateMigration(userId, existing);
				} else if (existing.service === "QUI") {
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
