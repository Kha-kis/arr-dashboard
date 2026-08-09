/**
 * Instance Quality Profile Routes
 *
 * Routes for managing quality profiles on specific Radarr/Sonarr instances
 */

import type { RadarrClient, SonarrClient } from "arr-sdk";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { AppValidationError, ConflictError } from "../../lib/errors.js";
import { withCleanupTopologyMutationLease } from "../../lib/library-cleanup/cleanup-executor.js";
import { readPersistedManagedCustomFormatIdentities } from "../../lib/trash-guides/deployment-managed-format-state.js";
import { assertNoPendingDeploymentOperation } from "../../lib/trash-guides/deployment-operation-gate.js";
import {
	assertNoLegacyDeploymentConnectionMappings,
	createDeploymentConnectionBindingCandidates,
	createDeploymentConnectionStateToken,
	createDeploymentEndpointKey,
	createQualityProfileStateToken,
	getEquivalentServiceInstanceIds,
} from "../../lib/trash-guides/deployment-target.js";
import { getErrorMessage } from "../../lib/utils/error-message.js";
import { validateRequest } from "../../lib/utils/validate.js";

// ============================================================================
// Type Definitions
// ============================================================================

/** Represents a custom format entry in a parsed template config */
interface ParsedTemplateCustomFormat {
	trashId?: string;
	name?: string;
	scoreOverride?: number;
	conditionsEnabled?: Record<string, boolean>;
	originalConfig?: {
		_instanceCFId?: number;
		trash_scores?: Record<string, number>;
		[key: string]: unknown;
	};
}

/** Parsed template configuration data structure */
interface ParsedTemplateConfig {
	customFormats?: ParsedTemplateCustomFormat[];
	qualityProfile?: { trash_score_set?: string };
	[key: string]: unknown;
}

// ============================================================================
// Validation Schemas
// ============================================================================

const updateScoresSchema = z.object({
	scoreUpdates: z
		.array(
			z.object({
				customFormatId: z.number().int().positive().safe(),
				score: z.number().int().safe(),
			}),
		)
		.min(1)
		.superRefine((updates, context) => {
			const seen = new Set<number>();
			for (const [index, update] of updates.entries()) {
				if (seen.has(update.customFormatId)) {
					context.addIssue({
						code: "custom",
						message: "Each Custom Format can only be updated once per request",
						path: [index, "customFormatId"],
					});
				}
				seen.add(update.customFormatId);
			}
		}),
});

const bulkDeleteOverridesSchema = z.object({
	customFormatIds: z.array(z.number().int().positive().safe()).min(1).max(500),
});

const promoteOverrideSchema = z.object({
	customFormatId: z.number().int().positive().safe(),
	templateId: z.string().min(1),
});

function getTemplateScore(
	config: ParsedTemplateConfig,
	customFormatId: number,
	trashId?: string,
): { score: number; inTemplate: boolean } {
	const templateCf = config.customFormats?.find(
		(cf) =>
			(trashId !== undefined && cf.trashId === trashId) ||
			cf.originalConfig?._instanceCFId === customFormatId,
	);
	if (!templateCf) return { score: 0, inTemplate: false };
	if (templateCf.scoreOverride !== undefined) {
		return { score: templateCf.scoreOverride, inTemplate: true };
	}
	const scoreSet = config.qualityProfile?.trash_score_set;
	const scoreSetValue = scoreSet ? templateCf.originalConfig?.trash_scores?.[scoreSet] : undefined;
	if (scoreSetValue !== undefined) {
		return { score: scoreSetValue, inTemplate: true };
	}
	return {
		score: templateCf.originalConfig?.trash_scores?.default ?? 0,
		inTemplate: true,
	};
}

// ============================================================================
// Route Handlers
// ============================================================================

const registerInstanceQualityProfileRoutes: FastifyPluginCallback = (app, _opts, done) => {
	const arrConnectionSelect = {
		id: true,
		baseUrl: true,
		service: true,
		encryptedApiKey: true,
		encryptionIv: true,
		encryptedHttpAuthCredentials: true,
		httpAuthEncryptionIv: true,
		connectionGeneration: true,
	} as const;

	function runWithCoordinatedEndpointMutation<T>(
		userId: string,
		instance: Parameters<typeof createDeploymentEndpointKey>[1],
		operation: string,
		action: (endpointKey: string) => Promise<T>,
	): Promise<T> {
		return withCleanupTopologyMutationLease({ prisma: app.prisma, log: app.log }, userId, () =>
			app.deploymentExecutor.runWithEndpointMutation(userId, instance, operation, action),
		);
	}

	async function getEquivalentConnectionContext(userId: string, instanceId: string) {
		const instance = await app.prisma.serviceInstance.findFirst({
			where: { id: instanceId, userId, service: { in: ["RADARR", "SONARR"] } },
			select: arrConnectionSelect,
		});
		if (!instance) return null;
		const aliases = await app.prisma.serviceInstance.findMany({
			where: { userId, service: instance.service },
			select: arrConnectionSelect,
		});
		const credentialIdentity = app.arrClientFactory.createConnectionCredentialIdentity(instance);
		const equivalentInstanceIds = getEquivalentServiceInstanceIds(
			aliases.map((alias) => ({
				...alias,
				credentialIdentity: app.arrClientFactory.createConnectionCredentialIdentity(alias),
			})),
			{ ...instance, credentialIdentity },
		);
		if (!equivalentInstanceIds.includes(instanceId)) equivalentInstanceIds.push(instanceId);
		const connectionReadBindings = aliases
			.filter((alias) => equivalentInstanceIds.includes(alias.id))
			.flatMap(createDeploymentConnectionBindingCandidates);
		return { instance, aliases, equivalentInstanceIds, connectionReadBindings };
	}

	async function resetScoreOverrides(
		userId: string,
		instanceId: string,
		profileId: number,
		requestedCustomFormatIds: number[],
	) {
		const customFormatIds = [...new Set(requestedCustomFormatIds)];
		if (customFormatIds.length !== requestedCustomFormatIds.length) {
			throw new AppValidationError("Each Custom Format can only be reset once per request.");
		}
		const selectConnection = {
			id: true,
			baseUrl: true,
			service: true,
			encryptedApiKey: true,
			encryptionIv: true,
			encryptedHttpAuthCredentials: true,
			httpAuthEncryptionIv: true,
			connectionGeneration: true,
		} as const;
		const instance = await app.prisma.serviceInstance.findFirst({
			where: { id: instanceId, userId, service: { in: ["RADARR", "SONARR"] } },
			select: selectConnection,
		});
		if (!instance) throw new AppValidationError("Instance not found or access denied");

		return runWithCoordinatedEndpointMutation(
			userId,
			instance,
			"Quality profile override reset",
			async (endpointKey) => {
				const currentInstance = await app.prisma.serviceInstance.findFirst({
					where: { id: instanceId, userId, service: { in: ["RADARR", "SONARR"] } },
					select: selectConnection,
				});
				if (
					!currentInstance ||
					createDeploymentEndpointKey(userId, currentInstance) !== endpointKey
				) {
					throw new ConflictError(
						"The ARR service connection changed while the override reset was starting.",
					);
				}
				const aliases = await app.prisma.serviceInstance.findMany({
					where: { userId, service: currentInstance.service },
					select: selectConnection,
				});
				const credentialIdentity =
					app.arrClientFactory.createConnectionCredentialIdentity(currentInstance);
				const equivalentInstanceIds = getEquivalentServiceInstanceIds(
					aliases.map((alias) => ({
						...alias,
						credentialIdentity: app.arrClientFactory.createConnectionCredentialIdentity(alias),
					})),
					{ ...currentInstance, credentialIdentity },
				);
				if (!equivalentInstanceIds.includes(instanceId)) equivalentInstanceIds.push(instanceId);
				const connectionBindings = aliases
					.filter((alias) => equivalentInstanceIds.includes(alias.id))
					.flatMap(createDeploymentConnectionBindingCandidates);

				const mappings = await app.prisma.templateQualityProfileMapping.findMany({
					where: {
						qualityProfileId: profileId,
						OR: connectionBindings,
						template: { userId },
					},
					include: { template: true },
					orderBy: { updatedAt: "desc" },
				});
				assertNoLegacyDeploymentConnectionMappings(mappings);
				const templateIds = new Set(mappings.map((mapping) => mapping.templateId));
				if (mappings.length === 0 || templateIds.size !== 1) {
					throw new ConflictError(
						"The quality profile does not have one current template mapping for this ARR connection.",
					);
				}
				const mapping = mappings[0]!;
				const managedFormats = readPersistedManagedCustomFormatIdentities(mapping);
				const trashIdByResourceId = new Map(
					managedFormats.map((format) => [format.resourceId, format.trashId]),
				);
				let templateConfig: ParsedTemplateConfig;
				try {
					templateConfig = JSON.parse(mapping.template.configData) as ParsedTemplateConfig;
				} catch (error) {
					throw new AppValidationError(
						`Template configuration is invalid: ${getErrorMessage(error)}`,
					);
				}
				const pendingResetIntents = await app.prisma.instanceQualityProfileOverride.findMany({
					where: {
						userId,
						instanceId: { in: equivalentInstanceIds },
						qualityProfileId: profileId,
						customFormatId: { in: customFormatIds },
						status: { in: ["PENDING", "UNCERTAIN"] },
					},
					select: {
						id: true,
						instanceId: true,
						connectionGeneration: true,
						connectionStateToken: true,
						customFormatId: true,
						intentOperation: true,
						intendedScore: true,
					},
				});
				const currentBindingKeys = new Set(
					connectionBindings.map(
						(binding) =>
							`${binding.instanceId}:${binding.connectionGeneration}:${binding.connectionStateToken}`,
					),
				);
				if (
					pendingResetIntents.some(
						(intent) =>
							!currentBindingKeys.has(
								`${intent.instanceId}:${intent.connectionGeneration}:${intent.connectionStateToken}`,
							),
					)
				) {
					throw new ConflictError(
						"A saved score reset belongs to an older ARR connection. Retry or resolve it before resetting current overrides.",
					);
				}
				const persistedResetScores = new Map(
					pendingResetIntents.flatMap((intent) =>
						intent.intentOperation === "RESET_SCORE" && intent.intendedScore !== null
							? [[intent.customFormatId, intent.intendedScore] as const]
							: [],
					),
				);
				const templateScores = new Map(
					customFormatIds.map((customFormatId) => [
						customFormatId,
						persistedResetScores.has(customFormatId)
							? { score: persistedResetScores.get(customFormatId)!, inTemplate: true }
							: getTemplateScore(
									templateConfig,
									customFormatId,
									trashIdByResourceId.get(customFormatId),
								),
					]),
				);
				await assertNoPendingDeploymentOperation(app.prisma, userId, equivalentInstanceIds, {
					qualityProfileId: profileId,
					operation: "RESET_SCORE",
					scoreUpdates: customFormatIds.map((customFormatId) => ({
						customFormatId,
						score: templateScores.get(customFormatId)!.score,
					})),
				});
				const overrides = await app.prisma.instanceQualityProfileOverride.findMany({
					where: {
						userId,
						qualityProfileId: profileId,
						customFormatId: { in: customFormatIds },
						status: { in: ["APPLIED", "PENDING", "UNCERTAIN"] },
						OR: connectionBindings,
					},
				});
				if (overrides.length !== customFormatIds.length) {
					throw new ConflictError(
						"One or more overrides changed or are not bound to the current ARR connection. Refresh and try again.",
					);
				}
				const intentAt = new Date();
				try {
					await app.prisma.$transaction(async (transaction) => {
						for (const override of overrides) {
							const write = await transaction.instanceQualityProfileOverride.updateMany({
								where: {
									id: override.id,
									updatedAt: override.updatedAt,
									status: { in: ["APPLIED", "PENDING", "UNCERTAIN"] },
								},
								data: {
									status: "PENDING",
									intentOperation: "RESET_SCORE",
									intendedScore: templateScores.get(override.customFormatId)!.score,
									updatedAt: intentAt,
								},
							});
							if (write.count !== 1) {
								throw new ConflictError(
									"One or more overrides changed while the reset intent was being saved. Refresh and try again.",
								);
							}
						}
					});
				} catch (error) {
					if (error instanceof ConflictError) throw error;
					throw new ConflictError(
						"The score reset intents could not be saved atomically. Refresh and try again.",
					);
				}

				const client = app.arrClientFactory.create(currentInstance) as SonarrClient | RadarrClient;
				const profile = await client.qualityProfile.getById(profileId);
				const reviewedProfileToken = createQualityProfileStateToken(profile);
				const updatedProfile = {
					...profile,
					formatItems: (profile.formatItems ?? []).map((item) => {
						const reset = item.format === undefined ? undefined : templateScores.get(item.format);
						return reset ? { ...item, score: reset.score } : item;
					}),
				};
				const freshProfile = await client.qualityProfile.getById(profileId);
				if (createQualityProfileStateToken(freshProfile) !== reviewedProfileToken) {
					throw new ConflictError(
						"The quality profile changed while the override reset was being prepared. Refresh and try again.",
					);
				}
				try {
					// biome-ignore lint/suspicious/noExplicitAny: Sonarr/Radarr profile types are runtime-compatible
					await client.qualityProfile.update(profileId, updatedProfile as any);
					const postWriteProfile = await client.qualityProfile.getById(profileId);
					for (const [customFormatId, reset] of templateScores) {
						const actual =
							postWriteProfile.formatItems?.find((item) => item.format === customFormatId)?.score ??
							0;
						if (actual !== reset.score) {
							throw new ConflictError(
								"ARR accepted the profile update, but the reset scores could not be verified. Saved overrides were retained for retry.",
							);
						}
					}
				} catch (error) {
					try {
						await app.prisma.instanceQualityProfileOverride.updateMany({
							where: {
								userId,
								status: "PENDING",
								OR: overrides.map((override) => ({ id: override.id, updatedAt: intentAt })),
							},
							data: { status: "UNCERTAIN" },
						});
					} catch (intentError) {
						app.log.error(
							{ err: intentError, instanceId, profileId },
							"Failed to mark an uncertain quality-profile reset intent",
						);
					}
					throw error;
				}
				const deleted = await app.prisma.instanceQualityProfileOverride.deleteMany({
					where: {
						userId,
						status: "PENDING",
						OR: overrides.map((override) => ({ id: override.id, updatedAt: intentAt })),
					},
				});
				if (deleted.count !== overrides.length) {
					throw new ConflictError(
						"Scores were reset upstream, but one or more saved overrides changed concurrently and were retained.",
					);
				}
				return { deletedCount: deleted.count, templateScores };
			},
		);
	}
	/**
	 * PATCH /api/trash-guides/instances/:instanceId/quality-profiles/:profileId/scores
	 * Update custom format scores for a quality profile
	 */
	app.patch<{
		Params: { instanceId: string; profileId: string };
		Body: z.infer<typeof updateScoresSchema>;
	}>("/:instanceId/quality-profiles/:profileId/scores", async (request, reply) => {
		// userId is guaranteed by preHandler authentication check
		const userId = request.currentUser!.id; // preHandler guarantees auth
		const { instanceId, profileId } = request.params;
		const profileIdNum = Number.parseInt(profileId, 10);

		if (Number.isNaN(profileIdNum)) {
			return reply.status(400).send({
				statusCode: 400,
				error: "BadRequest",
				message: "profileId must be a valid number",
			});
		}

		// Validate request body
		const { scoreUpdates } = validateRequest(updateScoresSchema, request.body);

		// Get the instance from database with ownership verification
		const instance = await request.server.prisma.serviceInstance.findFirst({
			where: {
				id: instanceId,
				userId,
				service: {
					in: ["RADARR", "SONARR"],
				},
			},
			select: {
				id: true,
				baseUrl: true,
				service: true,
				encryptedApiKey: true,
				encryptionIv: true,
				encryptedHttpAuthCredentials: true,
				httpAuthEncryptionIv: true,
				connectionGeneration: true,
			},
		});

		if (!instance) {
			return reply.status(404).send({
				statusCode: 404,
				error: "NotFound",
				message: "Instance not found or access denied",
			});
		}

		return runWithCoordinatedEndpointMutation(
			userId,
			instance,
			"Quality profile score update",
			async (endpointKey) => {
				const currentInstance = await request.server.prisma.serviceInstance.findFirst({
					where: { id: instanceId, userId, service: { in: ["RADARR", "SONARR"] } },
					select: {
						id: true,
						baseUrl: true,
						service: true,
						encryptedApiKey: true,
						encryptionIv: true,
						encryptedHttpAuthCredentials: true,
						httpAuthEncryptionIv: true,
						connectionGeneration: true,
					},
				});
				if (
					!currentInstance ||
					createDeploymentEndpointKey(userId, currentInstance) !== endpointKey
				) {
					throw new ConflictError(
						"The ARR service connection changed while the score update was starting.",
					);
				}
				const aliases = await request.server.prisma.serviceInstance.findMany({
					where: { userId, service: currentInstance.service },
					select: {
						id: true,
						baseUrl: true,
						service: true,
						encryptedApiKey: true,
						encryptionIv: true,
						encryptedHttpAuthCredentials: true,
						httpAuthEncryptionIv: true,
						connectionGeneration: true,
					},
				});
				const credentialIdentity =
					request.server.arrClientFactory.createConnectionCredentialIdentity(currentInstance);
				const equivalentInstanceIds = getEquivalentServiceInstanceIds(
					aliases.map((alias) => ({
						...alias,
						credentialIdentity:
							request.server.arrClientFactory.createConnectionCredentialIdentity(alias),
					})),
					{ ...currentInstance, credentialIdentity },
				);
				if (!equivalentInstanceIds.includes(instanceId)) equivalentInstanceIds.push(instanceId);
				await assertNoPendingDeploymentOperation(
					request.server.prisma,
					userId,
					equivalentInstanceIds,
					{
						qualityProfileId: profileIdNum,
						operation: "SET_SCORE",
						scoreUpdates,
					},
				);
				const retryIntents = await request.server.prisma.instanceQualityProfileOverride.findMany({
					where: {
						userId,
						instanceId: { in: equivalentInstanceIds },
						qualityProfileId: profileIdNum,
						status: { in: ["PENDING", "UNCERTAIN"] },
					},
					select: {
						id: true,
						updatedAt: true,
						customFormatId: true,
						intentOperation: true,
						intendedScore: true,
					},
				});

				const client = request.server.arrClientFactory.create(currentInstance) as
					| SonarrClient
					| RadarrClient;
				const [profile, customFormats] = await Promise.all([
					client.qualityProfile.getById(profileIdNum),
					client.customFormat.getAll(),
				]);
				const knownFormatIds = new Set(
					customFormats.flatMap((format) => (format.id === undefined ? [] : [format.id])),
				);
				const unknownFormat = scoreUpdates.find(
					(update) => !knownFormatIds.has(update.customFormatId),
				);
				if (unknownFormat) {
					throw new AppValidationError(
						`Custom Format ${unknownFormat.customFormatId} does not exist on this ARR instance.`,
					);
				}
				const updatesByFormatId = new Map(
					scoreUpdates.map((update) => [update.customFormatId, update.score]),
				);
				const formatItems = profile.formatItems ?? [];
				const updatedFormatItems = formatItems.map((item) => ({
					...item,
					score:
						item.format === undefined
							? item.score
							: (updatesByFormatId.get(item.format) ?? item.score),
				}));
				for (const update of scoreUpdates) {
					if (!formatItems.some((item) => item.format === update.customFormatId)) {
						updatedFormatItems.push({ format: update.customFormatId, score: update.score });
					}
				}
				const updatedProfile = { ...profile, formatItems: updatedFormatItems };
				const connectionStateToken = createDeploymentConnectionStateToken(currentInstance);
				const connectionBindings = aliases
					.filter((alias) => equivalentInstanceIds.includes(alias.id))
					.flatMap(createDeploymentConnectionBindingCandidates);
				const templateMappings = await request.server.prisma.templateQualityProfileMapping.findMany(
					{
						where: {
							qualityProfileId: profileIdNum,
							OR: connectionBindings,
							template: { userId },
						},
						orderBy: { updatedAt: "desc" },
					},
				);
				assertNoLegacyDeploymentConnectionMappings(templateMappings);
				if (new Set(templateMappings.map((mapping) => mapping.templateId)).size > 1) {
					throw new ConflictError(
						"Equivalent records for this ARR instance have conflicting template mappings.",
					);
				}
				const templateMapping = templateMappings[0];

				const freshProfile = await client.qualityProfile.getById(profileIdNum);
				if (
					createQualityProfileStateToken(freshProfile) !== createQualityProfileStateToken(profile)
				) {
					throw new ConflictError(
						"The quality profile changed while the score update was being prepared. Refresh and try again.",
					);
				}

				// Persist the desired score before the upstream write. If ARR commits
				// but the response is lost, the idempotent intent survives for retry.
				const intentAt = new Date();
				if (retryIntents.length > 0) {
					try {
						await request.server.prisma.$transaction(async (transaction) => {
							for (const intent of retryIntents) {
								const write = await transaction.instanceQualityProfileOverride.updateMany({
									where: {
										id: intent.id,
										updatedAt: intent.updatedAt,
										status: { in: ["PENDING", "UNCERTAIN"] },
										intentOperation: "SET_SCORE",
										intendedScore: intent.intendedScore,
									},
									data: {
										instanceId,
										score: updatesByFormatId.get(intent.customFormatId)!,
										status: "PENDING",
										connectionGeneration: currentInstance.connectionGeneration,
										connectionStateToken,
										updatedAt: intentAt,
									},
								});
								if (write.count !== 1) {
									throw new ConflictError(
										"The saved score retry changed while it was being resumed. Refresh and try again.",
									);
								}
							}
						});
					} catch (error) {
						if (error instanceof ConflictError) throw error;
						throw new ConflictError(
							"The saved score retry could not be rebound to this ARR connection. Refresh and resolve any duplicate override before retrying.",
						);
					}
				} else {
					try {
						await request.server.prisma.$transaction(async (transaction) => {
							const existingOverrides = await transaction.instanceQualityProfileOverride.findMany({
								where: {
									userId,
									instanceId: { in: equivalentInstanceIds },
									qualityProfileId: profileIdNum,
									customFormatId: {
										in: scoreUpdates.map((update) => update.customFormatId),
									},
								},
								select: {
									id: true,
									instanceId: true,
									status: true,
								},
							});
							if (existingOverrides.some((override) => override.status !== "APPLIED")) {
								throw new ConflictError(
									"An equivalent score override changed while the score intent was being saved. Refresh and retry the exact pending change.",
								);
							}
							const aliasOverrideIds = existingOverrides
								.filter((override) => override.instanceId !== instanceId)
								.map((override) => override.id);
							if (aliasOverrideIds.length > 0) {
								const deleted = await transaction.instanceQualityProfileOverride.deleteMany({
									where: {
										id: { in: aliasOverrideIds },
										status: "APPLIED",
										userId,
									},
								});
								if (deleted.count !== aliasOverrideIds.length) {
									throw new ConflictError(
										"An equivalent score override changed before it could be replaced. Refresh and try again.",
									);
								}
							}
							for (const update of scoreUpdates) {
								await transaction.instanceQualityProfileOverride.upsert({
									where: {
										instanceId_qualityProfileId_customFormatId: {
											instanceId,
											qualityProfileId: profileIdNum,
											customFormatId: update.customFormatId,
										},
									},
									create: {
										instanceId,
										qualityProfileId: profileIdNum,
										customFormatId: update.customFormatId,
										score: update.score,
										status: "PENDING",
										intentOperation: "SET_SCORE",
										intendedScore: update.score,
										userId,
										connectionGeneration: currentInstance.connectionGeneration,
										connectionStateToken,
										updatedAt: intentAt,
									},
									update: {
										score: update.score,
										status: "PENDING",
										intentOperation: "SET_SCORE",
										intendedScore: update.score,
										userId,
										connectionGeneration: currentInstance.connectionGeneration,
										connectionStateToken,
										updatedAt: intentAt,
									},
								});
							}
						});
					} catch (error) {
						if (error instanceof ConflictError) throw error;
						throw new ConflictError(
							"Equivalent score overrides could not be consolidated safely. Refresh and try again.",
						);
					}
				}

				const [writeInstance, writeProfile] = await Promise.all([
					request.server.prisma.serviceInstance.findFirst({
						where: { id: instanceId, userId },
					}),
					client.qualityProfile.getById(profileIdNum),
				]);
				if (
					!writeInstance ||
					createDeploymentConnectionStateToken(writeInstance) !== connectionStateToken ||
					createQualityProfileStateToken(writeProfile) !== createQualityProfileStateToken(profile)
				) {
					throw new ConflictError(
						"The ARR connection or quality profile changed before the score update. The saved score intent was not applied upstream.",
					);
				}
				const overrideWhere = {
					userId,
					instanceId: { in: equivalentInstanceIds },
					qualityProfileId: profileIdNum,
					status: "PENDING",
					OR: scoreUpdates.map((update) => ({
						customFormatId: update.customFormatId,
						intentOperation: "SET_SCORE",
						intendedScore: update.score,
						updatedAt: intentAt,
					})),
				} as const;
				try {
					// biome-ignore lint/suspicious/noExplicitAny: SonarrClient | RadarrClient union creates impossible intersection for QualityProfile.update() parameter
					await client.qualityProfile.update(profileIdNum, updatedProfile as any);
					const postWriteProfile = await client.qualityProfile.getById(profileIdNum);
					for (const update of scoreUpdates) {
						const appliedScore =
							postWriteProfile.formatItems?.find((item) => item.format === update.customFormatId)
								?.score ?? 0;
						if (appliedScore !== update.score) {
							throw new ConflictError(
								"ARR accepted the quality profile update, but its resulting scores could not be verified. The saved score intent remains available for retry.",
							);
						}
					}
					const completed = templateMapping
						? await request.server.prisma.instanceQualityProfileOverride.updateMany({
								where: overrideWhere,
								data: { status: "APPLIED", intentOperation: null, intendedScore: null },
							})
						: await request.server.prisma.instanceQualityProfileOverride.deleteMany({
								where: overrideWhere,
							});
					if (completed.count !== scoreUpdates.length) {
						throw new ConflictError(
							"ARR accepted the score update, but the saved retry state changed before completion.",
						);
					}
				} catch (error) {
					await request.server.prisma.instanceQualityProfileOverride.updateMany({
						where: overrideWhere,
						data: { status: "UNCERTAIN" },
					});
					throw error;
				}

				request.server.log.info(
					{
						instanceId,
						profileId: profileIdNum,
						scoreUpdates: scoreUpdates.length,
						templateId: templateMapping?.templateId,
					},
					templateMapping
						? "Applied durable instance-level score overrides"
						: "Applied quality profile scores without persistent overrides",
				);

				const message = templateMapping
					? `Updated ${scoreUpdates.length} custom format score(s) in quality profile "${profile.name}". Override will persist across template syncs.`
					: `Updated ${scoreUpdates.length} custom format score(s) in quality profile "${profile.name}".`;
				return reply.status(200).send({
					success: true,
					message,
					profileId: profileIdNum,
					profileName: profile.name,
					updatedCount: scoreUpdates.length,
					isTemplateManaged: !!templateMapping,
				});
			},
		);
	});

	/**
	 * GET /api/trash-guides/instances/:instanceId/quality-profiles/:profileId/overrides
	 * Get instance-level score overrides with conflict detection
	 */
	app.get<{
		Params: { instanceId: string; profileId: string };
	}>("/:instanceId/quality-profiles/:profileId/overrides", async (request, reply) => {
		// userId is guaranteed by preHandler authentication check
		const userId = request.currentUser!.id; // preHandler guarantees auth
		const { instanceId, profileId } = request.params;
		const profileIdNum = Number.parseInt(profileId, 10);

		if (Number.isNaN(profileIdNum)) {
			return reply.status(400).send({
				statusCode: 400,
				error: "BadRequest",
				message: "profileId must be a valid number",
			});
		}

		const connectionContext = await getEquivalentConnectionContext(userId, instanceId);

		if (!connectionContext) {
			return reply.status(403).send({
				statusCode: 403,
				error: "Forbidden",
				message: "You do not have access to this instance",
			});
		}

		// Include unfinished intents so a reload never hides a retryable upstream result.
		const overrides = await request.server.prisma.instanceQualityProfileOverride.findMany({
			where: {
				userId,
				qualityProfileId: profileIdNum,
				OR: [
					{ status: "APPLIED", OR: connectionContext.connectionReadBindings },
					{
						status: { in: ["PENDING", "UNCERTAIN"] },
						instanceId: { in: connectionContext.equivalentInstanceIds },
					},
				],
			},
			orderBy: {
				updatedAt: "desc",
			},
		});
		const appliedOverridesByFormat = new Map<number, (typeof overrides)[number]>();
		for (const override of overrides.filter((row) => row.status === "APPLIED")) {
			const existing = appliedOverridesByFormat.get(override.customFormatId);
			if (existing && existing.score !== override.score) {
				throw new ConflictError(
					"Equivalent records for this ARR instance have conflicting saved score overrides.",
				);
			}
			if (!existing) appliedOverridesByFormat.set(override.customFormatId, override);
		}
		const appliedOverrides = [...appliedOverridesByFormat.values()];
		const recoveryIntents = overrides
			.filter((override) => override.status !== "APPLIED")
			.map((override) => ({
				customFormatId: override.customFormatId,
				operation: override.intentOperation,
				intendedScore: override.intendedScore,
				status: override.status,
				retryAction:
					override.intentOperation === "RESET_SCORE" && override.intendedScore !== null
						? { method: "DELETE" as const }
						: override.intentOperation === "SET_SCORE" && override.intendedScore !== null
							? { method: "PATCH" as const, score: override.intendedScore }
							: null,
			}));

		return reply.status(200).send({
			success: true,
			overrides: appliedOverrides,
			recoveryIntents,
		});
	});

	/**
	 * POST /api/trash-guides/instances/:instanceId/quality-profiles/:profileId/promote-override
	 * Promote instance override to template (updates template for all instances)
	 */
	app.post<{
		Params: { instanceId: string; profileId: string };
		Body: { customFormatId: number; templateId: string };
	}>("/:instanceId/quality-profiles/:profileId/promote-override", async (request, reply) => {
		// userId is guaranteed by preHandler authentication check
		const userId = request.currentUser!.id; // preHandler guarantees auth
		const { instanceId, profileId } = request.params;
		const profileIdNum = Number.parseInt(profileId, 10);
		const { customFormatId, templateId } = validateRequest(promoteOverrideSchema, request.body);

		if (Number.isNaN(profileIdNum)) {
			return reply.status(400).send({
				statusCode: 400,
				error: "BadRequest",
				message: "profileId must be a valid number",
			});
		}

		// Verify the user owns this instance before acquiring its endpoint lock.
		const instance = await request.server.prisma.serviceInstance.findFirst({
			where: {
				id: instanceId,
				userId,
			},
			select: arrConnectionSelect,
		});

		if (!instance) {
			return reply.status(403).send({
				statusCode: 403,
				error: "Forbidden",
				message: "You do not have access to this instance",
			});
		}

		return runWithCoordinatedEndpointMutation(
			userId,
			instance,
			"Score override promotion",
			async (endpointKey) => {
				const connectionContext = await getEquivalentConnectionContext(userId, instanceId);
				if (
					!connectionContext ||
					createDeploymentEndpointKey(userId, connectionContext.instance) !== endpointKey
				) {
					throw new ConflictError(
						"The ARR service connection changed while the override promotion was starting.",
					);
				}

				const overrides = await request.server.prisma.instanceQualityProfileOverride.findMany({
					where: {
						qualityProfileId: profileIdNum,
						customFormatId,
						userId,
						OR: [
							{ status: "APPLIED", OR: connectionContext.connectionReadBindings },
							{
								status: { in: ["PENDING", "UNCERTAIN"] },
								instanceId: { in: connectionContext.equivalentInstanceIds },
							},
						],
					},
					orderBy: { updatedAt: "desc" },
				});
				const override = overrides[0];
				if (!override) {
					return reply.status(404).send({
						statusCode: 404,
						error: "NotFound",
						message: "Override not found",
					});
				}
				if (overrides.some((candidate) => candidate.status !== "APPLIED")) {
					throw new ConflictError(
						"This score has an unresolved upstream result. Retry or resolve it before promoting the override.",
					);
				}
				if (overrides.some((candidate) => candidate.score !== override.score)) {
					throw new ConflictError(
						"Equivalent records for this ARR instance have conflicting saved score overrides.",
					);
				}

				const connectionBindings = connectionContext.aliases
					.filter((alias) => connectionContext.equivalentInstanceIds.includes(alias.id))
					.flatMap(createDeploymentConnectionBindingCandidates);
				const templateMappings = await request.server.prisma.templateQualityProfileMapping.findMany(
					{
						where: {
							qualityProfileId: profileIdNum,
							OR: connectionBindings,
							template: { userId },
						},
						include: { template: true },
						orderBy: { updatedAt: "desc" },
					},
				);
				assertNoLegacyDeploymentConnectionMappings(templateMappings);
				if (new Set(templateMappings.map((mapping) => mapping.templateId)).size > 1) {
					throw new ConflictError(
						"Equivalent records for this ARR instance have conflicting template mappings.",
					);
				}
				const matchingMappings = templateMappings.filter(
					(mapping) => mapping.templateId === templateId,
				);
				if (matchingMappings.length === 0) {
					return reply.status(400).send({
						statusCode: 400,
						error: "BadRequest",
						message: "Quality profile is not mapped to the specified template",
					});
				}
				const template = matchingMappings[0]!.template;
				const reviewedMappingState = templateMappings
					.map((mapping) => ({
						id: mapping.id,
						templateId: mapping.templateId,
						updatedAt: mapping.updatedAt,
						connectionGeneration: mapping.connectionGeneration,
						connectionStateToken: mapping.connectionStateToken,
					}))
					.sort((left, right) => left.id.localeCompare(right.id));

				let configData: ParsedTemplateConfig;
				try {
					configData = JSON.parse(template.configData);
				} catch (parseError) {
					return reply.status(500).send({
						statusCode: 500,
						error: "InternalServerError",
						message: `Template configData is invalid JSON: ${getErrorMessage(parseError)}`,
					});
				}

				const customFormats = configData.customFormats || [];
				const customFormat = customFormats.find(
					(cf) => cf.originalConfig?._instanceCFId === customFormatId,
				);
				if (!customFormat) {
					return reply.status(400).send({
						statusCode: 400,
						error: "BadRequest",
						message: "Custom Format not found in template",
					});
				}
				customFormat.scoreOverride = override.score;

				await request.server.prisma.$transaction(async (transaction) => {
					const transactionInstance = await transaction.serviceInstance.findFirst({
						where: { id: instanceId, userId },
						select: arrConnectionSelect,
					});
					if (
						!transactionInstance ||
						createDeploymentConnectionStateToken(transactionInstance) !==
							createDeploymentConnectionStateToken(connectionContext.instance)
					) {
						throw new ConflictError(
							"The ARR service connection changed while the override was being promoted. Refresh and try again.",
						);
					}
					const transactionMappings = await transaction.templateQualityProfileMapping.findMany({
						where: {
							qualityProfileId: profileIdNum,
							OR: connectionBindings,
							template: { userId },
						},
						select: {
							id: true,
							templateId: true,
							updatedAt: true,
							connectionGeneration: true,
							connectionStateToken: true,
						},
					});
					const transactionMappingState = transactionMappings
						.map((mapping) => ({
							id: mapping.id,
							templateId: mapping.templateId,
							updatedAt: mapping.updatedAt,
							connectionGeneration: mapping.connectionGeneration,
							connectionStateToken: mapping.connectionStateToken,
						}))
						.sort((left, right) => left.id.localeCompare(right.id));
					if (JSON.stringify(transactionMappingState) !== JSON.stringify(reviewedMappingState)) {
						throw new ConflictError(
							"The template mapping changed while the override was being promoted. Refresh and try again.",
						);
					}
					const removed = await transaction.instanceQualityProfileOverride.deleteMany({
						where: {
							userId,
							status: "APPLIED",
							OR: overrides.map((candidate) => ({
								id: candidate.id,
								updatedAt: candidate.updatedAt,
							})),
						},
					});
					if (removed.count !== overrides.length) {
						throw new ConflictError(
							"The saved score override changed while it was being promoted. Refresh and try again.",
						);
					}
					const remaining = await transaction.instanceQualityProfileOverride.count({
						where: {
							qualityProfileId: profileIdNum,
							customFormatId,
							userId,
							OR: [
								{ status: "APPLIED", OR: connectionContext.connectionReadBindings },
								{
									status: { in: ["PENDING", "UNCERTAIN"] },
									instanceId: { in: connectionContext.equivalentInstanceIds },
								},
							],
						},
					});
					if (remaining !== 0) {
						throw new ConflictError(
							"The saved score override set changed while it was being promoted. Refresh and try again.",
						);
					}

					const updated = await transaction.trashTemplate.updateMany({
						where: { id: templateId, userId, updatedAt: template.updatedAt },
						data: {
							configData: JSON.stringify(configData),
							hasUserModifications: true,
							lastModifiedAt: new Date(),
							lastModifiedBy: userId,
						},
					});
					if (updated.count !== 1) {
						throw new ConflictError(
							"The template changed while the score override was being promoted. Refresh and try again.",
						);
					}
				});

				request.server.log.info(
					{ cfName: customFormat.name, instanceCFId: customFormatId, newScore: override.score },
					"Promoted CF score override to template",
				);
				return reply.status(200).send({
					success: true,
					message:
						"Override promoted to template. All instances using this template will receive the updated score on next sync.",
					templateId,
					customFormatId,
					newScore: override.score,
				});
			},
		);
	});

	/**
	 * POST /api/trash-guides/instances/:instanceId/quality-profiles/bulk-overrides
	 * Get overrides for multiple quality profiles in a single request
	 * This is more efficient than fetching overrides for each profile individually
	 */
	app.post<{
		Params: { instanceId: string };
		Body: { profileIds: number[] };
	}>("/:instanceId/quality-profiles/bulk-overrides", async (request, reply) => {
		// userId is guaranteed by preHandler authentication check
		const userId = request.currentUser!.id; // preHandler guarantees auth
		const { instanceId } = request.params;
		const { profileIds } = request.body;

		if (!Array.isArray(profileIds) || profileIds.length === 0) {
			return reply.status(400).send({
				statusCode: 400,
				error: "BadRequest",
				message: "profileIds must be a non-empty array of numbers",
			});
		}

		// Validate all profileIds are numbers
		const invalidIds = profileIds.filter((id) => typeof id !== "number" || Number.isNaN(id));
		if (invalidIds.length > 0) {
			return reply.status(400).send({
				statusCode: 400,
				error: "BadRequest",
				message: "All profileIds must be valid numbers",
			});
		}

		const connectionContext = await getEquivalentConnectionContext(userId, instanceId);

		if (!connectionContext) {
			return reply.status(403).send({
				statusCode: 403,
				error: "Forbidden",
				message: "You do not have access to this instance",
			});
		}

		// Fetch all overrides for the specified profiles in a single query
		const overrides = await request.server.prisma.instanceQualityProfileOverride.findMany({
			where: {
				userId,
				qualityProfileId: {
					in: profileIds,
				},
				OR: [
					{ status: "APPLIED", OR: connectionContext.connectionReadBindings },
					{
						status: { in: ["PENDING", "UNCERTAIN"] },
						instanceId: { in: connectionContext.equivalentInstanceIds },
					},
				],
			},
			orderBy: {
				qualityProfileId: "asc",
			},
		});

		// Group overrides by profile ID for easier frontend consumption
		const overridesByProfile: Record<
			number,
			Array<{
				customFormatId: number;
				score: number;
				updatedAt: Date;
			}>
		> = {};

		const appliedScores = new Map<string, number>();
		for (const override of overrides) {
			if (override.status !== "APPLIED") continue;
			const profileId = override.qualityProfileId;
			const key = `${profileId}:${override.customFormatId}`;
			const existingScore = appliedScores.get(key);
			if (existingScore !== undefined) {
				if (existingScore !== override.score) {
					throw new ConflictError(
						"Equivalent records for this ARR instance have conflicting saved score overrides.",
					);
				}
				continue;
			}
			appliedScores.set(key, override.score);
			if (!overridesByProfile[profileId]) {
				overridesByProfile[profileId] = [];
			}
			overridesByProfile[profileId]?.push({
				customFormatId: override.customFormatId,
				score: override.score,
				updatedAt: override.updatedAt,
			});
		}
		const recoveryIntents = overrides
			.filter((override) => override.status !== "APPLIED")
			.map((override) => ({
				qualityProfileId: override.qualityProfileId,
				customFormatId: override.customFormatId,
				operation: override.intentOperation,
				intendedScore: override.intendedScore,
				status: override.status,
				retryable:
					(override.intentOperation === "RESET_SCORE" ||
						override.intentOperation === "SET_SCORE") &&
					override.intendedScore !== null,
			}));
		const appliedOverrideCount = appliedScores.size;

		return reply.status(200).send({
			success: true,
			overridesByProfile,
			totalOverrides: appliedOverrideCount,
			recoveryIntents,
		});
	});

	/**
	 * DELETE /api/trash-guides/instances/:instanceId/quality-profiles/:profileId/overrides/:customFormatId
	 * Delete an instance-level override (revert to template/default score)
	 */
	app.delete<{
		Params: { instanceId: string; profileId: string; customFormatId: string };
	}>(
		"/:instanceId/quality-profiles/:profileId/overrides/:customFormatId",
		async (request, reply) => {
			// userId is guaranteed by preHandler authentication check
			const userId = request.currentUser!.id; // preHandler guarantees auth
			const { instanceId, profileId, customFormatId } = request.params;
			const profileIdNum = Number.parseInt(profileId, 10);
			const customFormatIdNum = Number.parseInt(customFormatId, 10);

			if (Number.isNaN(profileIdNum) || Number.isNaN(customFormatIdNum)) {
				return reply.status(400).send({
					statusCode: 400,
					error: "BadRequest",
					message: "profileId and customFormatId must be valid numbers",
				});
			}

			const result = await resetScoreOverrides(userId, instanceId, profileIdNum, [
				customFormatIdNum,
			]);
			const reset = result.templateScores.get(customFormatIdNum)!;
			return reply.status(200).send({
				success: true,
				message: reset.inTemplate
					? `Override removed. Score reverted to template value (${reset.score}).`
					: "Override removed. Score set to 0 (custom format not in template).",
				customFormatId: customFormatIdNum,
				revertedScore: reset.score,
			});
		},
	);

	/**
	 * POST /api/trash-guides/instances/:instanceId/quality-profiles/:profileId/overrides/bulk-delete
	 * Delete multiple instance-level overrides in one operation
	 */
	app.post<{
		Params: { instanceId: string; profileId: string };
		Body: { customFormatIds: number[] };
	}>("/:instanceId/quality-profiles/:profileId/overrides/bulk-delete", async (request, reply) => {
		// userId is guaranteed by preHandler authentication check
		const userId = request.currentUser!.id; // preHandler guarantees auth
		const { instanceId, profileId } = request.params;
		const profileIdNum = Number.parseInt(profileId, 10);
		const { customFormatIds } = validateRequest(bulkDeleteOverridesSchema, request.body);

		if (Number.isNaN(profileIdNum)) {
			return reply.status(400).send({
				statusCode: 400,
				error: "BadRequest",
				message: "profileId must be a valid number",
			});
		}

		const result = await resetScoreOverrides(userId, instanceId, profileIdNum, customFormatIds);
		return reply.status(200).send({
			success: true,
			message: `Removed ${result.deletedCount} override(s). Scores reverted to template values.`,
			deletedCount: result.deletedCount,
		});
	});

	done();
};

export default registerInstanceQualityProfileRoutes;
