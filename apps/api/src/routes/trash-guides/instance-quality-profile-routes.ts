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
import { assertNoPendingDeploymentOperation } from "../../lib/trash-guides/deployment-operation-gate.js";
import {
	assertNoLegacyDeploymentConnectionMappings,
	createDeploymentConnectionBindingCandidates,
	createDeploymentConnectionStateToken,
	createDeploymentEndpointKey,
	createQualityProfileStateToken,
	getEquivalentServiceInstanceIds,
	isCurrentDeploymentConnectionMapping,
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
	scoreSet?: string;
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

const bulkOverridesSchema = z.object({
	profileIds: z.array(z.number().int().positive().safe()).min(1),
});

function parsePositiveSafeIntegerParam(value: string): number | null {
	if (!/^[1-9]\d*$/.test(value)) return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

function assertCurrentConnectionRows(
	rows: Array<{
		instanceId: string;
		connectionGeneration?: number | null;
		connectionStateToken?: string | null;
	}>,
	bindings: Parameters<typeof isCurrentDeploymentConnectionMapping>[1],
	recordLabel: string,
): void {
	if (rows.some((row) => !isCurrentDeploymentConnectionMapping(row, bindings))) {
		throw new ConflictError(
			`An equivalent ARR alias has a stale ${recordLabel} for this quality profile. Reconcile the alias before changing scores.`,
		);
	}
}

function assertExactLiveProfile(
	profile: { id?: number; name?: string | null },
	requestedProfileId: number,
	expectedProfileName?: string,
): void {
	if (!Number.isSafeInteger(profile.id) || profile.id !== requestedProfileId) {
		throw new ConflictError(
			"ARR returned a different quality profile identity than the requested profile.",
		);
	}
	if (expectedProfileName !== undefined && profile.name !== expectedProfileName) {
		throw new ConflictError(
			"The mapped quality profile name no longer matches the live ARR profile.",
		);
	}
}

function describeRecoveryIntent(
	override: {
		instanceId: string;
		qualityProfileId: number;
		customFormatId: number;
		intentOperation: string | null;
		intendedScore: number | null;
		status: string;
		connectionGeneration?: number | null;
		connectionStateToken?: string | null;
	},
	bindings: Parameters<typeof isCurrentDeploymentConnectionMapping>[1],
) {
	const retryable =
		isCurrentDeploymentConnectionMapping(override, bindings) &&
		override.intentOperation === "SET_SCORE" &&
		override.intendedScore !== null;
	return {
		qualityProfileId: override.qualityProfileId,
		customFormatId: override.customFormatId,
		operation: override.intentOperation,
		intendedScore: override.intendedScore,
		status: override.status,
		retryable,
		requiresManualReconciliation: !retryable,
		retryAction: retryable ? { method: "PATCH" as const, score: override.intendedScore! } : null,
	};
}

// ============================================================================
// Route Handlers
// ============================================================================

const registerInstanceQualityProfileRoutes: FastifyPluginCallback = (app, _opts, done) => {
	const endpointMutationTails = new Map<string, Promise<void>>();
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

	async function runWithCoordinatedEndpointMutation<T>(
		userId: string,
		instance: Parameters<typeof createDeploymentEndpointKey>[1],
		operation: string,
		action: (endpointKey: string) => Promise<T>,
	): Promise<T> {
		const endpointKey = createDeploymentEndpointKey(userId, instance);
		const predecessor = endpointMutationTails.get(endpointKey) ?? Promise.resolve();
		let releaseSlot!: () => void;
		const slot = new Promise<void>((resolve) => {
			releaseSlot = resolve;
		});
		const tail = predecessor.catch(() => undefined).then(() => slot);
		endpointMutationTails.set(endpointKey, tail);

		await predecessor.catch(() => undefined);
		try {
			return await withCleanupTopologyMutationLease(
				{ prisma: app.prisma, log: app.log },
				userId,
				() => app.deploymentExecutor.runWithEndpointMutation(userId, instance, operation, action),
			);
		} finally {
			releaseSlot();
			if (endpointMutationTails.get(endpointKey) === tail) {
				endpointMutationTails.delete(endpointKey);
			}
		}
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
		const initialContext = await getEquivalentConnectionContext(userId, instanceId);
		if (!initialContext) throw new AppValidationError("Instance not found or access denied");

		return runWithCoordinatedEndpointMutation(
			userId,
			initialContext.instance,
			"Quality profile override reset",
			async (endpointKey) => {
				const connectionContext = await getEquivalentConnectionContext(userId, instanceId);
				if (
					!connectionContext ||
					createDeploymentEndpointKey(userId, connectionContext.instance) !== endpointKey ||
					createDeploymentConnectionStateToken(connectionContext.instance) !==
						createDeploymentConnectionStateToken(initialContext.instance)
				) {
					throw new ConflictError(
						"The ARR service connection changed while the override reset was starting.",
					);
				}
				const connectionBindings = connectionContext.connectionReadBindings;
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
				assertCurrentConnectionRows(mappings, connectionBindings, "template mapping");
				const templateIds = new Set(mappings.map((mapping) => mapping.templateId));
				if (mappings.length === 0 || templateIds.size !== 1) {
					throw new ConflictError(
						"The quality profile does not have one current template mapping for this ARR connection.",
					);
				}
				const mapping = mappings[0]!;
				if (
					mappings.some(
						(candidate) =>
							candidate.qualityProfileName !== mapping.qualityProfileName ||
							candidate.syncStrategy !== mapping.syncStrategy ||
							candidate.managedCustomFormatsCaptured !== mapping.managedCustomFormatsCaptured ||
							candidate.managedCustomFormats !== mapping.managedCustomFormats,
					)
				) {
					throw new ConflictError(
						"Equivalent ARR aliases have conflicting quality-profile mapping authority.",
					);
				}
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
						instanceId: { in: connectionContext.equivalentInstanceIds },
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
				assertCurrentConnectionRows(pendingResetIntents, connectionBindings, "score reset intent");
				const persistedResetScores = new Map<number, number>();
				for (const intent of pendingResetIntents) {
					if (intent.intentOperation !== "RESET_SCORE" || intent.intendedScore === null) {
						throw new ConflictError(
							"A different score write is unresolved for this profile. Retry or reconcile it first.",
						);
					}
					const previous = persistedResetScores.get(intent.customFormatId);
					if (previous !== undefined && previous !== intent.intendedScore) {
						throw new ConflictError(
							"Equivalent aliases contain conflicting reset intent for this Custom Format.",
						);
					}
					persistedResetScores.set(intent.customFormatId, intent.intendedScore);
				}
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
				await assertNoPendingDeploymentOperation(
					app.prisma,
					userId,
					connectionContext.equivalentInstanceIds,
					{
						qualityProfileId: profileId,
						operation: "RESET_SCORE",
						scoreUpdates: customFormatIds.map((customFormatId) => ({
							customFormatId,
							score: templateScores.get(customFormatId)!.score,
						})),
						connectionBindings,
					},
				);
				const overrides = await app.prisma.instanceQualityProfileOverride.findMany({
					where: {
						userId,
						qualityProfileId: profileId,
						customFormatId: { in: customFormatIds },
						status: { in: ["APPLIED", "PENDING", "UNCERTAIN"] },
						OR: connectionBindings,
					},
				});
				assertCurrentConnectionRows(overrides, connectionBindings, "saved score override");
				if (
					customFormatIds.some(
						(customFormatId) =>
							overrides.filter((override) => override.customFormatId === customFormatId).length ===
							0,
					)
				) {
					throw new ConflictError(
						"One or more overrides changed or are not bound to the current ARR connection. Refresh and try again.",
					);
				}

				const intentAt = new Date();
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

				const pendingResetWhere = {
					userId,
					status: "PENDING",
					OR: overrides.map((override) => ({ id: override.id, updatedAt: intentAt })),
				} as const;
				let writeAttempted = false;
				try {
					const client = app.arrClientFactory.create(connectionContext.instance) as
						| SonarrClient
						| RadarrClient;
					const profile = await client.qualityProfile.getById(profileId);
					assertExactLiveProfile(profile, profileId, mapping.qualityProfileName);
					for (const customFormatId of customFormatIds) {
						const matches = (profile.formatItems ?? []).filter(
							(item) => item.format === customFormatId,
						);
						if (matches.length !== 1) {
							throw new ConflictError(
								"The selected Custom Format is missing or duplicated in the live quality profile.",
							);
						}
					}
					const reviewedProfileToken = createQualityProfileStateToken(profile);
					const updatedProfile = {
						...profile,
						formatItems: (profile.formatItems ?? []).map((item) => {
							const reset = item.format === undefined ? undefined : templateScores.get(item.format);
							return reset ? { ...item, score: reset.score } : item;
						}),
					};
					const freshProfile = await client.qualityProfile.getById(profileId);
					assertExactLiveProfile(freshProfile, profileId, mapping.qualityProfileName);
					if (createQualityProfileStateToken(freshProfile) !== reviewedProfileToken) {
						throw new ConflictError(
							"The quality profile changed while the override reset was being prepared. Refresh and try again.",
						);
					}
					writeAttempted = true;
					// biome-ignore lint/suspicious/noExplicitAny: Sonarr/Radarr profile types are runtime-compatible
					await client.qualityProfile.update(profileId, updatedProfile as any);
					const postWriteProfile = await client.qualityProfile.getById(profileId);
					assertExactLiveProfile(postWriteProfile, profileId, mapping.qualityProfileName);
					for (const [customFormatId, reset] of templateScores) {
						const matches = (postWriteProfile.formatItems ?? []).filter(
							(item) => item.format === customFormatId,
						);
						if (matches.length !== 1 || matches[0]!.score !== reset.score) {
							throw new ConflictError(
								"ARR accepted the profile update, but the reset scores could not be verified. Saved overrides were retained for retry.",
							);
						}
					}
				} catch (error) {
					try {
						if (writeAttempted) {
							await app.prisma.instanceQualityProfileOverride.updateMany({
								where: pendingResetWhere,
								data: { status: "UNCERTAIN" },
							});
						} else {
							await app.prisma.$transaction(async (transaction) => {
								for (const override of overrides) {
									const restored = await transaction.instanceQualityProfileOverride.updateMany({
										where: {
											id: override.id,
											userId,
											status: "PENDING",
											updatedAt: intentAt,
										},
										data: {
											status: override.status,
											intentOperation: override.intentOperation,
											intendedScore: override.intendedScore,
											updatedAt: override.updatedAt,
										},
									});
									if (restored.count !== 1) {
										throw new ConflictError(
											"The reset was not sent to ARR, but its saved override state changed before it could be restored.",
										);
									}
								}
							});
						}
					} catch (intentError) {
						app.log.error(
							{ err: intentError, instanceId, profileId },
							writeAttempted
								? "Failed to mark an uncertain quality-profile reset intent"
								: "Failed to restore a quality-profile reset intent that was not sent upstream",
						);
					}
					throw error;
				}
				const deleted = await app.prisma.instanceQualityProfileOverride.deleteMany({
					where: pendingResetWhere,
				});
				if (deleted.count !== overrides.length) {
					throw new ConflictError(
						"Scores were reset upstream, but one or more saved overrides changed concurrently and were retained.",
					);
				}
				return { deletedCount: customFormatIds.length, templateScores };
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
		const profileIdNum = parsePositiveSafeIntegerParam(profileId);

		if (profileIdNum === null) {
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
		const requestedConnectionStateToken = createDeploymentConnectionStateToken(instance);

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
					createDeploymentEndpointKey(userId, currentInstance) !== endpointKey ||
					createDeploymentConnectionStateToken(currentInstance) !== requestedConnectionStateToken
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
				const connectionBindings = aliases
					.filter((alias) => equivalentInstanceIds.includes(alias.id))
					.flatMap(createDeploymentConnectionBindingCandidates);
				await assertNoPendingDeploymentOperation(
					request.server.prisma,
					userId,
					equivalentInstanceIds,
					{
						qualityProfileId: profileIdNum,
						operation: "SET_SCORE",
						scoreUpdates,
						connectionBindings,
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
				const templateMappings = await request.server.prisma.templateQualityProfileMapping.findMany(
					{
						where: {
							qualityProfileId: profileIdNum,
							instanceId: { in: equivalentInstanceIds },
							template: { userId },
						},
						orderBy: { updatedAt: "desc" },
					},
				);
				assertNoLegacyDeploymentConnectionMappings(templateMappings);
				assertCurrentConnectionRows(templateMappings, connectionBindings, "template mapping");
				if (new Set(templateMappings.map((mapping) => mapping.templateId)).size > 1) {
					throw new ConflictError(
						"Equivalent records for this ARR instance have conflicting template mappings.",
					);
				}
				const templateMapping = templateMappings[0];
				const mappedProfileNames = new Set(
					templateMappings.flatMap((mapping) =>
						typeof mapping.qualityProfileName === "string" && mapping.qualityProfileName.length > 0
							? [mapping.qualityProfileName]
							: [],
					),
				);
				if (mappedProfileNames.size > 1) {
					throw new ConflictError(
						"Equivalent records for this ARR instance have conflicting mapped profile names.",
					);
				}
				const expectedProfileName = mappedProfileNames.values().next().value;
				assertExactLiveProfile(profile, profileIdNum, expectedProfileName);

				const freshProfile = await client.qualityProfile.getById(profileIdNum);
				assertExactLiveProfile(freshProfile, profileIdNum, expectedProfileName);
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
									customFormatId: true,
									score: true,
									status: true,
									connectionGeneration: true,
									connectionStateToken: true,
								},
							});
							assertCurrentConnectionRows(
								existingOverrides,
								connectionBindings,
								"saved score override",
							);
							if (existingOverrides.some((override) => override.status !== "APPLIED")) {
								throw new ConflictError(
									"An equivalent score override changed while the score intent was being saved. Refresh and retry the exact pending change.",
								);
							}
							const appliedScoresByFormat = new Map<number, number>();
							for (const override of existingOverrides) {
								const priorScore = appliedScoresByFormat.get(override.customFormatId);
								if (
									appliedScoresByFormat.has(override.customFormatId) &&
									priorScore !== override.score
								) {
									throw new ConflictError(
										"Equivalent records for this ARR instance have conflicting saved score overrides.",
									);
								}
								appliedScoresByFormat.set(override.customFormatId, override.score);
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
				assertExactLiveProfile(writeProfile, profileIdNum, expectedProfileName);
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
					assertExactLiveProfile(postWriteProfile, profileIdNum, expectedProfileName);
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
		const profileIdNum = parsePositiveSafeIntegerParam(profileId);

		if (profileIdNum === null) {
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
			.map((override) => {
				const { qualityProfileId: _qualityProfileId, ...intent } = describeRecoveryIntent(
					override,
					connectionContext.connectionReadBindings,
				);
				return intent;
			});

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
		const { customFormatId, templateId } = request.body;

		if (Number.isNaN(profileIdNum)) {
			return reply.status(400).send({
				statusCode: 400,
				error: "BadRequest",
				message: "profileId must be a valid number",
			});
		}

		// Verify the user owns this instance first
		const instance = await request.server.prisma.serviceInstance.findFirst({
			where: {
				id: instanceId,
				userId,
			},
			select: { id: true },
		});

		if (!instance) {
			return reply.status(403).send({
				statusCode: 403,
				error: "Forbidden",
				message: "You do not have access to this instance",
			});
		}

		// Get the instance override
		const override = await request.server.prisma.instanceQualityProfileOverride.findUnique({
			where: {
				instanceId_qualityProfileId_customFormatId: {
					instanceId,
					qualityProfileId: profileIdNum,
					customFormatId,
				},
			},
		});

		if (!override) {
			return reply.status(404).send({
				statusCode: 404,
				error: "NotFound",
				message: "Override not found",
			});
		}

		// Ensure this profile is actually mapped to the requested template
		const templateMapping = await request.server.prisma.templateQualityProfileMapping.findUnique({
			where: {
				instanceId_qualityProfileId: {
					instanceId,
					qualityProfileId: profileIdNum,
				},
			},
			include: { template: true },
		});

		if (!templateMapping || templateMapping.templateId !== templateId) {
			return reply.status(400).send({
				statusCode: 400,
				error: "BadRequest",
				message: "Quality profile is not mapped to the specified template",
			});
		}

		// Verify the user owns this template
		if (templateMapping.template.userId !== userId) {
			return reply.status(403).send({
				statusCode: 403,
				error: "Forbidden",
				message: "You do not have access to this template",
			});
		}

		const template = templateMapping.template;

		// Parse template config
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

		// Find and update the CF's scoreOverride in the template
		const customFormats = configData.customFormats || [];
		let cfUpdated = false;

		for (const cf of customFormats) {
			// Match by instance custom format ID (stored in originalConfig._instanceCFId)
			if (cf.originalConfig?._instanceCFId === customFormatId) {
				cf.scoreOverride = override.score;
				cfUpdated = true;
				request.server.log.info(
					{ cfName: cf.name, instanceCFId: customFormatId, newScore: override.score },
					"Updated CF scoreOverride in template",
				);
				break;
			}
		}

		if (!cfUpdated) {
			return reply.status(400).send({
				statusCode: 400,
				error: "BadRequest",
				message: "Custom Format not found in template",
			});
		}

		// Update template with new scoreOverride
		await request.server.prisma.trashTemplate.update({
			where: { id: templateId },
			data: {
				configData: JSON.stringify(configData),
				hasUserModifications: true,
				lastModifiedAt: new Date(),
				lastModifiedBy: userId,
			},
		});

		// Delete the instance override (now it's in the template)
		await request.server.prisma.instanceQualityProfileOverride.delete({
			where: {
				instanceId_qualityProfileId_customFormatId: {
					instanceId,
					qualityProfileId: profileIdNum,
					customFormatId,
				},
			},
		});

		return reply.status(200).send({
			success: true,
			message:
				"Override promoted to template. All instances using this template will receive the updated score on next sync.",
			templateId,
			customFormatId,
			newScore: override.score,
		});
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
		const { profileIds } = validateRequest(bulkOverridesSchema, request.body);

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
			.map((override) =>
				describeRecoveryIntent(override, connectionContext.connectionReadBindings),
			);
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

			// Check if override exists
			const override = await request.server.prisma.instanceQualityProfileOverride.findUnique({
				where: {
					instanceId_qualityProfileId_customFormatId: {
						instanceId,
						qualityProfileId: profileIdNum,
						customFormatId: customFormatIdNum,
					},
				},
			});

			if (!override) {
				return reply.status(404).send({
					statusCode: 404,
					error: "NotFound",
					message: "Override not found",
				});
			}

			// Get the template mapping to find the template score
			const templateMapping = await request.server.prisma.templateQualityProfileMapping.findUnique({
				where: {
					instanceId_qualityProfileId: {
						instanceId,
						qualityProfileId: profileIdNum,
					},
				},
				include: {
					template: true,
				},
			});

			if (!templateMapping) {
				return reply.status(400).send({
					statusCode: 400,
					error: "BadRequest",
					message: "Quality profile is not managed by a template",
				});
			}

			// Parse template config to get the template score for this custom format
			let templateConfigReset: ParsedTemplateConfig;
			try {
				templateConfigReset = JSON.parse(
					templateMapping.template.configData,
				) as ParsedTemplateConfig;
			} catch (parseError) {
				return reply.status(500).send({
					statusCode: 500,
					error: "InternalServerError",
					message: `Template configData is invalid JSON: ${getErrorMessage(parseError)}`,
				});
			}
			const templateCf = templateConfigReset.customFormats?.find(
				(cf: ParsedTemplateCustomFormat) => cf.originalConfig?._instanceCFId === customFormatIdNum,
			);

			// Calculate the template score (if CF not in template, default to 0)
			// This can happen if the CF was manually added or the template was updated
			let templateScore = 0;
			if (templateCf) {
				// Priority 1: User's score override from wizard
				if (templateCf.scoreOverride !== undefined) {
					templateScore = templateCf.scoreOverride;
				}
				// Priority 2: TRaSH Guides score from template's score set
				else if (
					templateConfigReset.scoreSet != null &&
					templateConfigReset.scoreSet !== "" &&
					templateCf.originalConfig?.trash_scores?.[templateConfigReset.scoreSet] !== undefined
				) {
					templateScore = templateCf.originalConfig.trash_scores[templateConfigReset.scoreSet]!;
				}
				// Priority 3: TRaSH Guides default score
				else if (templateCf.originalConfig?.trash_scores?.default !== undefined) {
					templateScore = templateCf.originalConfig.trash_scores.default;
				}
				// Priority 4: Explicit zero (CF exists in template but has no score)
				// remains 0
			}

			// Get the instance from database
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
				},
			});

			if (!instance) {
				return reply.status(404).send({
					statusCode: 404,
					error: "NotFound",
					message: "Instance not found or access denied",
				});
			}

			// Create SDK client using factory
			const client = request.server.arrClientFactory.create(instance) as
				| SonarrClient
				| RadarrClient;

			// Fetch current quality profile
			const profile = await client.qualityProfile.getById(profileIdNum);

			// Update the formatItems with the template score
			const profileFormatItems = profile.formatItems ?? [];
			const updatedFormatItems = profileFormatItems.map((item) => {
				if (item.format === customFormatIdNum) {
					return {
						...item,
						score: templateScore,
					};
				}
				return item;
			});

			// Update the quality profile in Radarr/Sonarr
			// biome-ignore lint/suspicious/noExplicitAny: SonarrClient | RadarrClient union creates impossible intersection for QualityProfile.update() parameter
			const updatedProfile: any = { ...profile, formatItems: updatedFormatItems };
			await client.qualityProfile.update(profileIdNum, updatedProfile);

			// Delete the override from database
			await request.server.prisma.instanceQualityProfileOverride.delete({
				where: {
					instanceId_qualityProfileId_customFormatId: {
						instanceId,
						qualityProfileId: profileIdNum,
						customFormatId: customFormatIdNum,
					},
				},
			});

			request.server.log.info(
				{
					instanceId,
					profileId: profileIdNum,
					customFormatId: customFormatIdNum,
					templateScore,
					cfInTemplate: !!templateCf,
				},
				"Deleted instance-level score override and reverted to template score",
			);

			const message = templateCf
				? `Override removed. Score reverted to template value (${templateScore}).`
				: "Override removed. Score set to 0 (custom format not in template).";

			return reply.status(200).send({
				success: true,
				message,
				customFormatId: customFormatIdNum,
				revertedScore: templateScore,
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
		const { customFormatIds } = request.body;

		if (Number.isNaN(profileIdNum)) {
			return reply.status(400).send({
				statusCode: 400,
				error: "BadRequest",
				message: "profileId must be a valid number",
			});
		}

		if (!Array.isArray(customFormatIds) || customFormatIds.length === 0) {
			return reply.status(400).send({
				statusCode: 400,
				error: "BadRequest",
				message: "customFormatIds must be a non-empty array",
			});
		}

		// Get the template mapping to find template scores
		const templateMapping = await request.server.prisma.templateQualityProfileMapping.findUnique({
			where: {
				instanceId_qualityProfileId: {
					instanceId,
					qualityProfileId: profileIdNum,
				},
			},
			include: {
				template: true,
			},
		});

		if (!templateMapping) {
			return reply.status(400).send({
				statusCode: 400,
				error: "BadRequest",
				message: "Quality profile is not managed by a template",
			});
		}

		// Parse template config
		let templateConfigParsed: ParsedTemplateConfig;
		try {
			templateConfigParsed = JSON.parse(templateMapping.template.configData);
		} catch (parseError) {
			return reply.status(500).send({
				statusCode: 500,
				error: "InternalServerError",
				message: `Template configData is invalid JSON: ${getErrorMessage(parseError)}`,
			});
		}

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
			},
		});

		if (!instance) {
			return reply.status(404).send({
				statusCode: 404,
				error: "NotFound",
				message: "Instance not found or access denied",
			});
		}

		// Create SDK client using factory
		const client = request.server.arrClientFactory.create(instance) as SonarrClient | RadarrClient;

		// Fetch current quality profile
		const profile = await client.qualityProfile.getById(profileIdNum);

		// Build a map of customFormatId -> template score
		const templateScores = new Map<number, number>();
		for (const cfId of customFormatIds) {
			const templateCf = templateConfigParsed.customFormats?.find(
				(cf: ParsedTemplateCustomFormat) => cf.originalConfig?._instanceCFId === cfId,
			);
			if (templateCf) {
				// Priority 1: User's score override from wizard
				let score = 0;
				if (templateCf.scoreOverride !== undefined) {
					score = templateCf.scoreOverride;
				}
				// Priority 2: TRaSH Guides score from template's score set
				else if (
					templateConfigParsed.scoreSet != null &&
					templateConfigParsed.scoreSet !== "" &&
					templateCf.originalConfig?.trash_scores?.[templateConfigParsed.scoreSet] !== undefined
				) {
					score = templateCf.originalConfig.trash_scores[templateConfigParsed.scoreSet]!;
				}
				// Priority 3: TRaSH Guides default score
				else if (templateCf.originalConfig?.trash_scores?.default !== undefined) {
					score = templateCf.originalConfig.trash_scores.default;
				}
				// Priority 4: Explicit zero (remains 0)

				templateScores.set(cfId, score);
			} else {
				// CF not found in template - set to 0 to neutralize the override in ARR
				// This matches single-DELETE behavior and ensures ARR doesn't retain hidden overrides
				templateScores.set(cfId, 0);
			}
		}

		// Update the formatItems with template scores for the specified CFs
		const profileFormatItems = profile.formatItems ?? [];
		const updatedFormatItems = profileFormatItems.map((item) => {
			const templateScore = item.format !== undefined ? templateScores.get(item.format) : undefined;
			if (templateScore !== undefined) {
				return {
					...item,
					score: templateScore,
				};
			}
			return item;
		});

		// Update the quality profile in Radarr/Sonarr
		// biome-ignore lint/suspicious/noExplicitAny: SonarrClient | RadarrClient union creates impossible intersection for QualityProfile.update() parameter
		const updatedProfile: any = { ...profile, formatItems: updatedFormatItems };
		await client.qualityProfile.update(profileIdNum, updatedProfile);

		// Delete all specified overrides from database
		const result = await request.server.prisma.instanceQualityProfileOverride.deleteMany({
			where: {
				instanceId,
				qualityProfileId: profileIdNum,
				customFormatId: {
					in: customFormatIds,
				},
			},
		});

		request.server.log.info(
			{ instanceId, profileId: profileIdNum, count: result.count },
			"Bulk deleted instance-level score overrides and reverted to template scores",
		);

		return reply.status(200).send({
			success: true,
			message: `Removed ${result.count} override(s). Scores reverted to template values.`,
			deletedCount: result.count,
		});
	});

	done();
};

export default registerInstanceQualityProfileRoutes;
