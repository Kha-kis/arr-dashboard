/**
 * Instance Quality Profile Routes
 *
 * Routes for managing quality profiles on specific Radarr/Sonarr instances
 */

import type { RadarrClient, SonarrClient } from "arr-sdk";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { AppValidationError, ConflictError } from "../../lib/errors.js";
import { withCleanupTopologyMutationLease } from "../../lib/library-cleanup/cleanup-run-lease.js";
import { readPersistedManagedCustomFormatIdentities } from "../../lib/trash-guides/deployment-managed-format-state.js";
import { assertNoPendingDeploymentOperation } from "../../lib/trash-guides/deployment-operation-gate.js";
import {
	assertNoLegacyDeploymentConnectionMappings,
	createDeploymentConnectionBindingCandidates,
	createDeploymentConnectionPersistenceBindings,
	createDeploymentConnectionStateToken,
	createDeploymentEndpointKey,
	createQualityProfileStateToken,
	createUpstreamResourceStateToken,
	getEquivalentServiceInstanceIds,
	isCurrentDeploymentConnectionMapping,
	isVerifiedClonedProfileSourceConnection,
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
		name?: string;
		specifications?: unknown[];
		trash_scores?: Record<string, number>;
		[key: string]: unknown;
	};
}

/** Parsed template configuration data structure */
interface ParsedTemplateConfig {
	customFormats?: ParsedTemplateCustomFormat[];
	completeQualityProfile?: {
		sourceInstanceId?: string;
		sourceConnectionStateToken?: string;
	};
	qualityProfile?: { trash_score_set?: string };
	[key: string]: unknown;
}

// ============================================================================
// Validation Schemas
// ============================================================================

const updateScoresSchema = z.object({
	recoveryToken: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
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

const bulkDeleteOverridesSchema = z.object({
	customFormatIds: z.array(z.number().int().positive().safe()).min(1).max(500),
});

const promoteOverrideSchema = z.object({
	customFormatId: z.number().int().positive().safe(),
	templateId: z.string().min(1),
});

function parsePositiveSafeIntegerParam(value: string): number | null {
	if (!/^[1-9]\d*$/.test(value)) return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

function findTemplateCustomFormat(
	config: ParsedTemplateConfig,
	customFormatId: number,
	trashId?: string,
	allowInstanceIdFallback = false,
): ParsedTemplateCustomFormat | undefined {
	const matches =
		config.customFormats?.filter((cf) =>
			trashId !== undefined
				? cf.trashId === trashId
				: allowInstanceIdFallback && cf.originalConfig?._instanceCFId === customFormatId,
		) ?? [];
	if (matches.length > 1) {
		throw new ConflictError(
			"The template contains a duplicate Custom Format identity for this score reset.",
		);
	}
	return matches[0];
}

function getTemplateScore(
	config: ParsedTemplateConfig,
	customFormatId: number,
	trashId?: string,
	allowInstanceIdFallback = false,
): { score: number; inTemplate: boolean } {
	const templateCf = findTemplateCustomFormat(
		config,
		customFormatId,
		trashId,
		allowInstanceIdFallback,
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

type ScoreResetCustomFormatIdentity =
	| { kind: "managed"; stateToken: string }
	| { kind: "source"; stateToken: string };

function createSourceCustomFormatIdentity(
	templateCustomFormat: ParsedTemplateCustomFormat | undefined,
): ScoreResetCustomFormatIdentity {
	const originalConfig = templateCustomFormat?.originalConfig;
	if (
		!originalConfig ||
		typeof originalConfig.name !== "string" ||
		originalConfig.name.length === 0 ||
		!Array.isArray(originalConfig.specifications)
	) {
		throw new ConflictError(
			"Custom Format identity could not be established from the verified source template.",
		);
	}
	return {
		kind: "source",
		stateToken: createUpstreamResourceStateToken({
			name: originalConfig.name,
			specifications: originalConfig.specifications,
		}),
	};
}

async function assertCurrentCustomFormatIdentity(
	client: SonarrClient | RadarrClient,
	customFormatId: number,
	expected: ScoreResetCustomFormatIdentity,
): Promise<void> {
	let live: unknown;
	try {
		live = await client.customFormat.getById(customFormatId);
	} catch {
		throw new ConflictError(
			"The Custom Format identity changed or could not be verified. Refresh and try again.",
		);
	}
	if (!live || typeof live !== "object" || Array.isArray(live)) {
		throw new ConflictError(
			"The Custom Format identity changed or could not be verified. Refresh and try again.",
		);
	}
	const candidate = live as {
		id?: number;
		name?: unknown;
		specifications?: unknown;
	};
	if (candidate.id !== customFormatId) {
		throw new ConflictError(
			"The Custom Format identity changed or could not be verified. Refresh and try again.",
		);
	}
	const liveStateToken =
		expected.kind === "managed"
			? createUpstreamResourceStateToken(live)
			: createUpstreamResourceStateToken({
					name: candidate.name,
					specifications: candidate.specifications,
				});
	if (liveStateToken !== expected.stateToken) {
		throw new ConflictError(
			"The Custom Format identity changed or could not be verified. Refresh and try again.",
		);
	}
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

function createScoreRecoveryToken(
	rows: Array<{
		id: string;
		instanceId: string;
		qualityProfileId: number;
		customFormatId: number;
		intentOperation: string | null;
		intendedScore: number | null;
		status: string;
		updatedAt: Date;
		connectionGeneration?: number | null;
		connectionStateToken?: string | null;
	}>,
): string {
	return createUpstreamResourceStateToken(
		rows
			.map((row) => ({
				id: row.id,
				instanceId: row.instanceId,
				qualityProfileId: row.qualityProfileId,
				customFormatId: row.customFormatId,
				intentOperation: row.intentOperation,
				intendedScore: row.intendedScore,
				status: row.status,
				updatedAt: row.updatedAt.toISOString(),
				connectionGeneration: row.connectionGeneration ?? null,
				connectionStateToken: row.connectionStateToken ?? null,
			}))
			.sort((left, right) => left.id.localeCompare(right.id)),
	);
}

function buildScoreRecoveryPlans(
	overrides: Array<{
		id: string;
		instanceId: string;
		qualityProfileId: number;
		customFormatId: number;
		intentOperation: string | null;
		intendedScore: number | null;
		status: string;
		updatedAt: Date;
		connectionGeneration?: number | null;
		connectionStateToken?: string | null;
	}>,
	bindings: Parameters<typeof isCurrentDeploymentConnectionMapping>[1],
) {
	const byProfile = new Map<number, typeof overrides>();
	for (const override of overrides) {
		const rows = byProfile.get(override.qualityProfileId) ?? [];
		rows.push(override);
		byProfile.set(override.qualityProfileId, rows);
	}
	return [...byProfile.entries()].map(([qualityProfileId, rows]) => {
		const desiredScores = new Map<number, number>();
		let retryable = true;
		let operation: "SET_SCORE" | "RESET_SCORE" | null = null;
		for (const row of rows) {
			if (
				!isCurrentDeploymentConnectionMapping(row, bindings) ||
				(row.intentOperation !== "SET_SCORE" && row.intentOperation !== "RESET_SCORE") ||
				row.intendedScore === null
			) {
				retryable = false;
				continue;
			}
			if (operation !== null && operation !== row.intentOperation) retryable = false;
			operation = row.intentOperation;
			const existing = desiredScores.get(row.customFormatId);
			if (existing !== undefined && existing !== row.intendedScore) retryable = false;
			desiredScores.set(row.customFormatId, row.intendedScore);
		}
		if (desiredScores.size === 0 || operation === null) retryable = false;
		const orderedScores = [...desiredScores]
			.sort(([left], [right]) => left - right)
			.map(([customFormatId, score]) => ({ customFormatId, score }));
		return {
			qualityProfileId,
			entries: rows.map((row) => ({
				customFormatId: row.customFormatId,
				operation: row.intentOperation,
				intendedScore: row.intendedScore,
				status: row.status,
			})),
			retryable,
			requiresManualReconciliation: !retryable,
			retryAction: !retryable
				? null
				: operation === "SET_SCORE"
					? {
							method: "PATCH" as const,
							recoveryToken: createScoreRecoveryToken(rows),
							scoreUpdates: orderedScores,
						}
					: {
							method: "POST" as const,
							customFormatIds: orderedScores.map((score) => score.customFormatId),
						},
		};
	});
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
	type ArrConnectionInstance = Parameters<
		typeof app.arrClientFactory.createConnectionCredentialIdentity
	>[0] & { id: string };

	function withCredentialIdentity(instance: ArrConnectionInstance) {
		return {
			...instance,
			credentialIdentity: app.arrClientFactory.createConnectionCredentialIdentity(instance),
		};
	}

	function createEndpointKey(userId: string, instance: ArrConnectionInstance): string {
		return createDeploymentEndpointKey(userId, withCredentialIdentity(instance));
	}

	function connectionBindingCandidates(instance: ArrConnectionInstance) {
		return createDeploymentConnectionBindingCandidates(
			instance,
			app.arrClientFactory.createConnectionCredentialIdentity(instance),
		);
	}

	async function runWithCoordinatedEndpointMutation<T>(
		userId: string,
		instance: ArrConnectionInstance,
		operation: string,
		action: (endpointKey: string) => Promise<T>,
	): Promise<T> {
		const lockedEndpointKey = createEndpointKey(userId, instance);
		const predecessor = endpointMutationTails.get(lockedEndpointKey) ?? Promise.resolve();
		let releaseSlot!: () => void;
		const slot = new Promise<void>((resolve) => {
			releaseSlot = resolve;
		});
		const tail = predecessor.catch(() => undefined).then(() => slot);
		endpointMutationTails.set(lockedEndpointKey, tail);

		await predecessor.catch(() => undefined);
		try {
			return await withCleanupTopologyMutationLease(
				{ prisma: app.prisma, log: app.log },
				userId,
				() => app.deploymentExecutor.runWithEndpointMutation(userId, instance, operation, action),
			);
		} finally {
			releaseSlot();
			if (endpointMutationTails.get(lockedEndpointKey) === tail) {
				endpointMutationTails.delete(lockedEndpointKey);
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
			.flatMap(connectionBindingCandidates);
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
					createEndpointKey(userId, connectionContext.instance) !== endpointKey ||
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
						OR: createDeploymentConnectionPersistenceBindings(connectionBindings),
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
				const trashIdByResourceId = new Map<number, string>();
				const managedIdentityByResourceId = new Map<number, ScoreResetCustomFormatIdentity>();
				const resourceIdByTrashId = new Map<string, number>();
				for (const format of managedFormats) {
					if (
						trashIdByResourceId.has(format.resourceId) ||
						resourceIdByTrashId.has(format.trashId)
					) {
						throw new ConflictError(
							"The deployment mapping contains duplicate managed Custom Format authority.",
						);
					}
					trashIdByResourceId.set(format.resourceId, format.trashId);
					managedIdentityByResourceId.set(format.resourceId, {
						kind: "managed",
						stateToken: format.stateToken,
					});
					resourceIdByTrashId.set(format.trashId, format.resourceId);
				}
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
				const requiresInstanceIdFallback = customFormatIds.some(
					(customFormatId) => !trashIdByResourceId.has(customFormatId),
				);
				const sourceBinding = templateConfig.completeQualityProfile;
				const isRecordedSourceConnection = Boolean(
					requiresInstanceIdFallback &&
						sourceBinding?.sourceInstanceId &&
						connectionContext.equivalentInstanceIds.includes(sourceBinding.sourceInstanceId),
				);
				const allowInstanceIdFallback = isRecordedSourceConnection
					? isVerifiedClonedProfileSourceConnection({
							sourceInstanceId: sourceBinding?.sourceInstanceId,
							sourceConnectionStateToken: sourceBinding?.sourceConnectionStateToken,
							equivalentInstanceIds: connectionContext.equivalentInstanceIds,
							sourceInstance: connectionContext.aliases.find(
								(alias) => alias.id === sourceBinding?.sourceInstanceId,
							),
						})
					: false;
				const customFormatIdentities = new Map<number, ScoreResetCustomFormatIdentity>();
				for (const customFormatId of customFormatIds) {
					const managedIdentity = managedIdentityByResourceId.get(customFormatId);
					if (managedIdentity) {
						customFormatIdentities.set(customFormatId, managedIdentity);
						continue;
					}
					if (!allowInstanceIdFallback) {
						throw new ConflictError(
							"Custom Format identity could not be established for this ARR connection.",
						);
					}
					customFormatIdentities.set(
						customFormatId,
						createSourceCustomFormatIdentity(
							findTemplateCustomFormat(templateConfig, customFormatId, undefined, true),
						),
					);
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
									allowInstanceIdFallback,
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
						OR: createDeploymentConnectionPersistenceBindings(connectionBindings),
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
				const client = app.arrClientFactory.create(connectionContext.instance) as
					| SonarrClient
					| RadarrClient;
				for (const [customFormatId, identity] of customFormatIdentities) {
					await assertCurrentCustomFormatIdentity(client, customFormatId, identity);
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
					for (const [customFormatId, identity] of customFormatIdentities) {
						await assertCurrentCustomFormatIdentity(client, customFormatId, identity);
					}
					const currentTemplateCount = await app.prisma.trashTemplate.count({
						where: {
							id: mapping.templateId,
							userId,
							updatedAt: mapping.template.updatedAt,
						},
					});
					if (currentTemplateCount !== 1) {
						throw new ConflictError(
							"The template changed while the override reset was being prepared. Refresh and try again.",
						);
					}
					writeAttempted = true;
					// biome-ignore lint/suspicious/noExplicitAny: Sonarr/Radarr profile types are runtime-compatible
					await client.qualityProfile.update(profileId, updatedProfile as any);
					for (const [customFormatId, identity] of customFormatIdentities) {
						await assertCurrentCustomFormatIdentity(client, customFormatId, identity);
					}
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
		const { recoveryToken, scoreUpdates } = validateRequest(updateScoresSchema, request.body);

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
					createEndpointKey(userId, currentInstance) !== endpointKey ||
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
					.flatMap(connectionBindingCandidates);
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
						instanceId: true,
						qualityProfileId: true,
						updatedAt: true,
						customFormatId: true,
						intentOperation: true,
						intendedScore: true,
						status: true,
						connectionGeneration: true,
						connectionStateToken: true,
					},
				});
				if (recoveryToken && retryIntents.length === 0) {
					throw new ConflictError(
						"The saved score recovery plan no longer exists. Refresh before making another change.",
					);
				}
				if (retryIntents.length > 0) {
					if (recoveryToken && createScoreRecoveryToken(retryIntents) !== recoveryToken) {
						throw new ConflictError(
							"The saved score recovery plan changed. Refresh before retrying it.",
						);
					}
					assertCurrentConnectionRows(retryIntents, connectionBindings, "score retry intent");
					const desiredScores = new Map<number, number>();
					for (const intent of retryIntents) {
						if (intent.intentOperation !== "SET_SCORE" || intent.intendedScore === null) {
							throw new ConflictError(
								"The saved recovery plan contains a different operation and requires manual reconciliation.",
							);
						}
						if (desiredScores.has(intent.customFormatId)) {
							throw new ConflictError(
								"Equivalent ARR aliases contain duplicate score recovery intent and require manual reconciliation.",
							);
						}
						desiredScores.set(intent.customFormatId, intent.intendedScore);
					}
					if (
						desiredScores.size !== scoreUpdates.length ||
						scoreUpdates.some((update) => desiredScores.get(update.customFormatId) !== update.score)
					) {
						throw new ConflictError(
							"Retry the complete saved score recovery plan for this quality profile; partial retries are not allowed.",
						);
					}
				}

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
					{
						status: "APPLIED",
						OR: createDeploymentConnectionPersistenceBindings(
							connectionContext.connectionReadBindings,
						),
					},
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
		const recoveryPlans = buildScoreRecoveryPlans(
			overrides.filter((override) => override.status !== "APPLIED"),
			connectionContext.connectionReadBindings,
		);

		return reply.status(200).send({
			success: true,
			overrides: appliedOverrides,
			recoveryPlans,
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
		const profileIdNum = parsePositiveSafeIntegerParam(profileId);
		const { customFormatId, templateId } = validateRequest(promoteOverrideSchema, request.body);

		if (profileIdNum === null) {
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
					createEndpointKey(userId, connectionContext.instance) !== endpointKey
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
							{
								status: "APPLIED",
								OR: createDeploymentConnectionPersistenceBindings(
									connectionContext.connectionReadBindings,
								),
							},
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
				assertCurrentConnectionRows(
					overrides,
					connectionContext.connectionReadBindings,
					"saved score override",
				);
				if (overrides.some((candidate) => candidate.score !== override.score)) {
					throw new ConflictError(
						"Equivalent records for this ARR instance have conflicting saved score overrides.",
					);
				}

				const connectionBindings = connectionContext.aliases
					.filter((alias) => connectionContext.equivalentInstanceIds.includes(alias.id))
					.flatMap(connectionBindingCandidates);
				const templateMappings = await request.server.prisma.templateQualityProfileMapping.findMany(
					{
						where: {
							qualityProfileId: profileIdNum,
							OR: createDeploymentConnectionPersistenceBindings(connectionBindings),
							template: { userId },
						},
						include: { template: true },
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
				const managedTrashIds = new Set(
					matchingMappings.flatMap((mapping) =>
						readPersistedManagedCustomFormatIdentities(mapping)
							.filter(
								(format) =>
									format.profileId === profileIdNum && format.resourceId === customFormatId,
							)
							.map((format) => format.trashId),
					),
				);
				if (managedTrashIds.size !== 1) {
					throw new ConflictError(
						"The Custom Format is not bound to one exact managed TRaSH identity for this profile.",
					);
				}
				const managedTrashId = [...managedTrashIds][0]!;
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
				const matchingCustomFormats = customFormats.filter((cf) => cf.trashId === managedTrashId);
				const customFormat = matchingCustomFormats[0];
				if (!customFormat || matchingCustomFormats.length !== 1) {
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
							OR: createDeploymentConnectionPersistenceBindings(connectionBindings),
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
								{
									status: "APPLIED",
									OR: createDeploymentConnectionPersistenceBindings(
										connectionContext.connectionReadBindings,
									),
								},
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
					{
						status: "APPLIED",
						OR: createDeploymentConnectionPersistenceBindings(
							connectionContext.connectionReadBindings,
						),
					},
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
		const recoveryPlans = buildScoreRecoveryPlans(
			overrides.filter((override) => override.status !== "APPLIED"),
			connectionContext.connectionReadBindings,
		);
		const appliedOverrideCount = appliedScores.size;

		return reply.status(200).send({
			success: true,
			overridesByProfile,
			totalOverrides: appliedOverrideCount,
			recoveryPlans,
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
			const profileIdNum = parsePositiveSafeIntegerParam(profileId);
			const customFormatIdNum = parsePositiveSafeIntegerParam(customFormatId);

			if (profileIdNum === null || customFormatIdNum === null) {
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
		const profileIdNum = parsePositiveSafeIntegerParam(profileId);
		const { customFormatIds } = validateRequest(bulkDeleteOverridesSchema, request.body);

		if (profileIdNum === null) {
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
