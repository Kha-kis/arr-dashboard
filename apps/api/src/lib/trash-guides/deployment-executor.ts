/**
 * TRaSH Guides Deployment Executor Service
 *
 * Executes deployment of Custom Formats from template to Radarr/Sonarr instances.
 * Handles both single and bulk deployments.
 *
 * Orchestration only — delegates to:
 * - quality-profile-helpers.ts: shared profile utilities
 * - profile-creation-strategies.ts: 3 profile creation strategies
 * - deployment-history-manager.ts: history finalization
 * - cf-field-utils.ts: field transformation and trash ID extraction
 * - template-score-utils.ts: score calculation
 */

import type { CustomQualityConfig, NamingSelectedPresets, TrashConflictGroup } from "@arr/shared";
import type { RadarrClient, SonarrClient } from "arr-sdk";
import type { PrismaClient, ServiceType } from "../../lib/prisma.js";
import type { ArrClientFactory } from "../arr/client-factory.js";
import {
	AppValidationError,
	ConflictError,
	InstanceNotFoundError,
	TemplateNotFoundError,
} from "../errors.js";
import { loggers } from "../logger.js";
import { getErrorMessage } from "../utils/error-message.js";
import { createCacheManager } from "./cache-manager.js";
import { withCleanupTopologyMutationLease } from "../library-cleanup/cleanup-executor.js";
import { extractTrashId, transformFieldsToArray } from "./cf-field-utils.js";
import { checkMutualExclusions } from "./conflict-checker.js";
import type { CustomFormatRollbackState } from "./deployment-custom-format-state.js";
import {
	captureManagedCustomFormatIdentities,
	type ManagedCustomFormatIdentity,
	type OrphanedManagedCustomFormat,
	readPersistedManagedCustomFormatIdentities,
	resolveOrphanedManagedCustomFormats,
} from "./deployment-managed-format-state.js";
import {
	finalizeDeploymentHistory,
	finalizeDeploymentHistoryWithFailure,
	finalizeDeploymentHistoryWithPartialFailure,
} from "./deployment-history-manager.js";
import {
	type PreparedNamingDeployment,
	prepareNamingDeployment,
} from "./deployment-naming-state.js";
import { assertNoPendingDeploymentOperation } from "./deployment-operation-gate.js";
import { rebindLegacyDeploymentConnectionState } from "./deployment-legacy-rebind.js";
import { shouldRetainDeploymentBackup } from "./deployment-backup-state.js";
import {
	assertNoLegacyDeploymentConnectionMappings,
	assertDeploymentTargetOwnership,
	createDeploymentConnectionBindingCandidates,
	createDeploymentConnectionStateToken,
	createDeploymentEndpointKey,
	createDeploymentStateToken,
	createLegacyDeploymentConnectionBindings,
	createQualityProfileStateToken,
	createUpstreamResourceStateToken,
	getEquivalentServiceInstanceIds,
	isLegacyDeploymentConnectionMapping,
	resolveDeploymentTarget,
} from "./deployment-target.js";
import { createQualityProfileFromSchema } from "./profile-creation-strategies.js";
import {
	extractQualitiesFromSchema,
	normalizeQualityName,
	type TemplateCF,
} from "./quality-profile-helpers.js";
import { getSyncMetrics } from "./sync-metrics.js";
import { calculateScoreAndSource } from "./template-score-utils.js";

const log = loggers.deployment;

// SDK CustomFormat type for internal use
type SdkCustomFormat = Awaited<ReturnType<SonarrClient["customFormat"]["getAll"]>>[number];
type SdkQualityProfile =
	| Awaited<ReturnType<SonarrClient["qualityProfile"]["getAll"]>>[number]
	| Awaited<ReturnType<RadarrClient["qualityProfile"]["getAll"]>>[number];

// ============================================================================
// Types
// ============================================================================

export interface DeploymentResult {
	instanceId: string;
	instanceLabel: string;
	success: boolean;
	customFormatsCreated: number;
	customFormatsUpdated: number;
	customFormatsSkipped: number;
	errors: string[];
	warnings?: string[];
	qualityProfileApplied?: {
		action: "created" | "updated";
		profileId: number;
		profileName: string;
	};
	namingFieldsApplied?: number;
	details?: {
		created: string[];
		updated: string[];
		failed: string[];
		orphaned: string[];
	};
}

export interface BulkDeploymentResult {
	templateId: string;
	templateName: string;
	totalInstances: number;
	successfulInstances: number;
	failedInstances: number;
	results: DeploymentResult[];
}

interface PartialDeploymentResult {
	created: number;
	updated: number;
	skipped: number;
	details: NonNullable<DeploymentResult["details"]>;
	qualityProfile?: QualityProfileMutation;
}

function getPartialDeploymentResult(error: unknown): PartialDeploymentResult | undefined {
	if (!(error instanceof Error) || !("partialDeployment" in error)) {
		return undefined;
	}

	const partial = error.partialDeployment;
	if (
		!partial ||
		typeof partial !== "object" ||
		!("created" in partial) ||
		typeof partial.created !== "number" ||
		!("updated" in partial) ||
		typeof partial.updated !== "number" ||
		!("skipped" in partial) ||
		typeof partial.skipped !== "number" ||
		!("details" in partial) ||
		!partial.details ||
		typeof partial.details !== "object"
	) {
		return undefined;
	}

	return partial as PartialDeploymentResult;
}

interface ValidatedDeploymentData {
	template: {
		id: string;
		name: string;
		serviceType: string;
		configData: string;
		instanceOverrides: string | null;
		sourceQualityProfileName: string | null;
	};
	instance: {
		id: string;
		label: string;
		service: ServiceType;
		baseUrl: string;
		encryptedApiKey: string;
		encryptionIv: string;
		encryptedHttpAuthCredentials: string | null;
		httpAuthEncryptionIv: string | null;
		connectionGeneration: number;
	};
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR API config structure
	templateConfig: Record<string, any>;
	templateCFs: TemplateCF[];
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR API override structure
	overridesForInstance: Record<string, any>;
	effectiveQualityConfig: CustomQualityConfig | undefined;
	usingQualityOverride: boolean;
}

interface NamingBackupState {
	beforeConfig: Record<string, unknown>;
	status: "not_started" | "pending" | "applied";
	postStateToken: string | null;
	intendedPostStateToken: string | null;
}

interface QualityProfileMutation {
	action: "created" | "updated";
	profileId: number;
	profileName: string;
	postStateToken: string | null;
}

function toPublicQualityProfileMutation(
	mutation: QualityProfileMutation | undefined,
): DeploymentResult["qualityProfileApplied"] {
	if (!mutation) return undefined;
	return {
		action: mutation.action,
		profileId: mutation.profileId,
		profileName: mutation.profileName,
	};
}

interface QualityProfileBackupState {
	beforeProfile: SdkQualityProfile | null;
	status: "not_started" | "pending" | "applied";
	action: "created" | "updated";
	profileId: number | null;
	profileName: string;
	postStateToken: string | null;
	intendedPostStateToken: string | null;
}

interface DeploymentBackupData {
	schemaVersion: 2;
	endpointKey: string;
	connectionStateToken: string;
	customFormats: SdkCustomFormat[];
	customFormatDeployments: CustomFormatRollbackState[];
	managedCustomFormats: ManagedCustomFormatIdentity[];
	managedCustomFormatsCaptured: boolean;
	qualityProfileDeployment: QualityProfileBackupState;
	namingDeployment: NamingBackupState | null;
}

interface BackupAndHistoryResult {
	backup: { id: string; data: DeploymentBackupData; retentionExpiresAt: Date | null };
	historyId: string;
}

interface DeploymentDetails {
	created: string[];
	updated: string[];
	failed: string[];
	orphaned: string[];
}

interface DeployCustomFormatsResult {
	created: number;
	updated: number;
	skipped: number;
	details: DeploymentDetails;
	errors: string[];
}

interface SyncQualityProfileResult {
	errors: string[];
	orphanedCFs: string[];
	mutation?: QualityProfileMutation;
}

interface DeploymentConnectionBinding {
	instanceId: string;
	connectionGeneration: number;
	connectionStateToken: string;
}

interface DeploymentConnectionReadBinding {
	instanceId: string;
	connectionGeneration: number;
	connectionStateToken: string | null;
}

// ============================================================================
// Deployment Executor Service Class
// ============================================================================

export class DeploymentExecutorService {
	private prisma: PrismaClient;
	private clientFactory: ArrClientFactory;
	private activeMutationEndpoints = new Set<string>();

	constructor(prisma: PrismaClient, clientFactory: ArrClientFactory) {
		this.prisma = prisma;
		this.clientFactory = clientFactory;
	}

	private createCredentialIdentity(
		instance: Parameters<ArrClientFactory["createConnectionCredentialIdentity"]>[0],
	): string {
		return typeof this.clientFactory.createConnectionCredentialIdentity === "function"
			? this.clientFactory.createConnectionCredentialIdentity(instance)
			: createDeploymentConnectionStateToken(instance);
	}

	// ============================================================================
	// Private Helper Methods
	// ============================================================================

	private async validateAndPrepareDeployment(
		templateId: string,
		instanceId: string,
		userId: string,
	): Promise<ValidatedDeploymentData> {
		const template = await this.prisma.trashTemplate.findUnique({
			where: { id: templateId, userId },
		});

		if (!template) {
			throw new TemplateNotFoundError(templateId);
		}

		const instance = await this.prisma.serviceInstance.findFirst({
			where: { id: instanceId, userId },
		});

		if (!instance) {
			throw new InstanceNotFoundError(instanceId);
		}

		const templateServiceType = template.serviceType?.toUpperCase() ?? "";
		const instanceServiceType = instance.service?.toUpperCase() ?? "";
		if (
			!templateServiceType ||
			!instanceServiceType ||
			templateServiceType !== instanceServiceType
		) {
			throw new AppValidationError(
				`Service type mismatch: template is ${template.serviceType ?? "undefined"}, instance is ${instance.service ?? "undefined"}`,
			);
		}

		// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR API config structure
		let templateConfig: Record<string, any>;
		try {
			templateConfig = JSON.parse(template.configData);
		} catch (parseError) {
			throw new Error(
				`Failed to parse template configData for template ${template.id}: ${getErrorMessage(parseError)}`,
			);
		}

		let templateCFs = (templateConfig.customFormats || []) as TemplateCF[];

		// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR API override structure
		let instanceOverrides: Record<string, any> = {};
		try {
			instanceOverrides = template.instanceOverrides ? JSON.parse(template.instanceOverrides) : {};
		} catch (parseError) {
			log.warn(
				{ templateId: template.id, err: parseError },
				"Failed to parse instanceOverrides, using empty object",
			);
		}

		const overridesForInstance = instanceOverrides[instanceId] || {};

		if (overridesForInstance.cfScoreOverrides || overridesForInstance.cfSelectionOverrides) {
			templateCFs = templateCFs
				.map((cf) => {
					const cfOverride = overridesForInstance.cfSelectionOverrides?.[cf.trashId];
					const scoreOverride = overridesForInstance.cfScoreOverrides?.[cf.trashId];

					if (cfOverride?.enabled === false) {
						return null;
					}

					const finalScore = scoreOverride !== undefined ? scoreOverride : cf.scoreOverride;

					return {
						...cf,
						scoreOverride: finalScore,
					};
				})
				.filter((cf): cf is NonNullable<typeof cf> => cf !== null);
		}

		const instanceQualityOverride = overridesForInstance.qualityConfigOverride as
			| CustomQualityConfig
			| undefined;
		const templateQualityConfig = templateConfig.customQualityConfig as
			| CustomQualityConfig
			| undefined;
		const effectiveQualityConfig = instanceQualityOverride ?? templateQualityConfig;
		const usingQualityOverride = instanceQualityOverride !== undefined;

		return {
			template: {
				id: template.id,
				name: template.name,
				serviceType: template.serviceType,
				configData: template.configData,
				instanceOverrides: template.instanceOverrides,
				sourceQualityProfileName: template.sourceQualityProfileName,
			},
			instance: {
				id: instance.id,
				label: instance.label,
				service: instance.service,
				baseUrl: instance.baseUrl,
				encryptedApiKey: instance.encryptedApiKey,
				encryptionIv: instance.encryptionIv,
				encryptedHttpAuthCredentials: instance.encryptedHttpAuthCredentials,
				httpAuthEncryptionIv: instance.httpAuthEncryptionIv,
				connectionGeneration: instance.connectionGeneration,
			},
			templateConfig,
			templateCFs,
			overridesForInstance,
			effectiveQualityConfig,
			usingQualityOverride,
		};
	}

	private async createBackupAndHistory(
		instance: {
			id: string;
			service: string;
			baseUrl: string;
			encryptedApiKey: string;
			encryptionIv: string;
			encryptedHttpAuthCredentials?: string | null;
			httpAuthEncryptionIv?: string | null;
		},
		userId: string,
		preDeploymentCFs: SdkCustomFormat[],
		templateId: string,
		// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR quality profile snapshot
		preDeploymentQP?: any,
		preDeploymentNaming?: PreparedNamingDeployment,
	): Promise<BackupAndHistoryResult> {
		const userSettings = await this.prisma.trashSettings.findUnique({
			where: { userId },
			select: { backupRetentionDays: true },
		});
		const retentionDays = userSettings?.backupRetentionDays ?? 30;

		let expiresAt: Date | null = null;
		if (retentionDays > 0) {
			expiresAt = new Date();
			expiresAt.setDate(expiresAt.getDate() + retentionDays);
		}

		const backupData: DeploymentBackupData = {
			schemaVersion: 2,
			endpointKey: createDeploymentEndpointKey(userId, instance),
			connectionStateToken: createDeploymentConnectionStateToken(instance),
			customFormats: preDeploymentCFs,
			customFormatDeployments: [],
			managedCustomFormats: [],
			managedCustomFormatsCaptured: false,
			qualityProfileDeployment: {
				beforeProfile: preDeploymentQP ?? null,
				status: "not_started",
				action: preDeploymentQP ? "updated" : "created",
				profileId: preDeploymentQP?.id ?? null,
				profileName: preDeploymentQP?.name ?? "Pending quality profile",
				postStateToken: null,
				intendedPostStateToken: null,
			},
			namingDeployment:
				preDeploymentNaming && preDeploymentNaming.changedFields.length > 0
					? {
							beforeConfig: preDeploymentNaming.currentConfig,
							status: "not_started",
							postStateToken: null,
							intendedPostStateToken: createUpstreamResourceStateToken(
								preDeploymentNaming.mergedConfig,
							),
						}
					: null,
		};

		const { backup, history } = await this.prisma.$transaction(async (tx) => {
			const backupRecord = await tx.trashBackup.create({
				data: {
					instanceId: instance.id,
					userId,
					backupData: JSON.stringify(backupData),
					expiresAt,
				},
			});

			const historyRecord = await tx.trashSyncHistory.create({
				data: {
					instanceId: instance.id,
					templateId,
					userId,
					syncType: "MANUAL",
					status: "IN_PROGRESS",
					backupId: backupRecord.id,
					appliedConfigs: "[]",
					configsApplied: 0,
					configsFailed: 0,
					configsSkipped: 0,
				},
			});

			return { backup: backupRecord, history: historyRecord };
		});

		return {
			backup: { id: backup.id, data: backupData, retentionExpiresAt: expiresAt },
			historyId: history.id,
		};
	}

	private async deployCustomFormats(
		client: SonarrClient | RadarrClient,
		templateCFs: TemplateCF[],
		existingCFMap: Map<string, SdkCustomFormat>,
		existingCFByName: Map<string, SdkCustomFormat>,
		conflictResolutions: Record<string, "use_template" | "keep_existing"> | undefined,
		persistMutationState: (
			state: CustomFormatRollbackState,
			append: boolean,
		) => Promise<void> = async () => {},
	): Promise<DeployCustomFormatsResult> {
		const errors: string[] = [];
		const details: DeploymentDetails = {
			created: [],
			updated: [],
			failed: [],
			orphaned: [],
		};
		let created = 0;
		let updated = 0;
		let skipped = 0;
		const throwWithPartialDeployment = (error: ConflictError): never => {
			Object.assign(error, {
				partialDeployment: {
					created,
					updated,
					skipped,
					details,
				},
			});
			throw error;
		};

		for (const templateCF of templateCFs) {
			let upstreamMutationStarted = false;
			try {
				let existingCF = existingCFMap.get(templateCF.trashId);
				if (!existingCF) {
					existingCF = existingCFByName.get(templateCF.name);
				}

				const cfResolution =
					conflictResolutions?.[templateCF.trashId] ?? conflictResolutions?.[templateCF.name];
				if (existingCF && cfResolution === "keep_existing") {
					skipped++;
					continue;
				}

				if (existingCF?.id) {
					const freshExistingCF = await client.customFormat.getById(existingCF.id);
					if (
						createUpstreamResourceStateToken(freshExistingCF) !==
						createUpstreamResourceStateToken(existingCF)
					) {
						throw new ConflictError(
							`Custom Format "${templateCF.name}" changed during deployment. Refresh the preview and try again.`,
						);
					}
					const specifications = (templateCF.originalConfig?.specifications || []).map((spec) => ({
						...spec,
						fields: transformFieldsToArray(spec.fields),
					}));

					const updatedCF = {
						...freshExistingCF,
						name: templateCF.name,
						specifications,
					};
					const mutationState: CustomFormatRollbackState = {
						beforeFormat: freshExistingCF as unknown as Record<string, unknown>,
						action: "updated",
						resourceId: existingCF.id,
						name: templateCF.name,
						status: "pending",
						postStateToken: null,
						intendedPostStateToken: createUpstreamResourceStateToken(updatedCF),
					};
					await persistMutationState(mutationState, true);

					upstreamMutationStarted = true;
					await client.customFormat.update(
						existingCF.id,
						updatedCF as unknown as Parameters<typeof client.customFormat.update>[1],
					);
					const postWriteFormat = await client.customFormat.getById(existingCF.id);
					mutationState.status = "applied";
					mutationState.postStateToken = createUpstreamResourceStateToken(postWriteFormat);
					await persistMutationState(mutationState, false);
					updated++;
					details.updated.push(templateCF.name);
				} else {
					const freshFormats = await client.customFormat.getAll();
					const appearedDuringDeployment = freshFormats.find(
						(format) =>
							extractTrashId(format) === templateCF.trashId || format.name === templateCF.name,
					);
					if (appearedDuringDeployment) {
						throw new ConflictError(
							`Custom Format "${templateCF.name}" appeared during deployment. Refresh the preview and try again.`,
						);
					}
					const specifications = (templateCF.originalConfig?.specifications || []).map((spec) => ({
						...spec,
						fields: transformFieldsToArray(spec.fields),
					}));

					const newCF = {
						name: templateCF.name,
						includeCustomFormatWhenRenaming:
							templateCF.originalConfig?.includeCustomFormatWhenRenaming ?? false,
						specifications,
					};
					const mutationState: CustomFormatRollbackState = {
						beforeFormat: null,
						action: "created",
						resourceId: null,
						name: templateCF.name,
						status: "pending",
						postStateToken: null,
						intendedPostStateToken: null,
					};
					await persistMutationState(mutationState, true);

					upstreamMutationStarted = true;
					const createdFormat = await client.customFormat.create(
						newCF as unknown as Parameters<typeof client.customFormat.create>[0],
					);
					if (createdFormat.id === undefined) {
						throw new Error("ARR created the Custom Format without returning its ID");
					}
					mutationState.resourceId = createdFormat.id;
					await persistMutationState(mutationState, false);
					const postWriteFormat = await client.customFormat.getById(createdFormat.id);
					mutationState.status = "applied";
					mutationState.postStateToken = createUpstreamResourceStateToken(postWriteFormat);
					await persistMutationState(mutationState, false);
					created++;
					details.created.push(templateCF.name);
				}
			} catch (error) {
				if (upstreamMutationStarted) {
					log.error(
						{ err: error, cfName: templateCF.name },
						"Custom Format mutation could not be verified",
					);
					throwWithPartialDeployment(
						new ConflictError(
							`Custom Format "${templateCF.name}" may have changed, but its post-write state could not be verified. Resolve or roll back the interrupted deployment before retrying.`,
						),
					);
				}
				if (error instanceof ConflictError) {
					throwWithPartialDeployment(error);
				}
				log.error({ err: error, cfName: templateCF.name }, "Failed to deploy custom format");
				errors.push(
					`Failed to deploy "${templateCF.name}": ${getErrorMessage(error, "Unknown error")}`,
				);
				details.failed.push(templateCF.name);
			}
		}

		return { created, updated, skipped, details, errors };
	}

	private async syncQualityProfile(
		client: SonarrClient | RadarrClient,
		// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR template config
		templateConfig: Record<string, any>,
		templateCFs: TemplateCF[],
		templateId: string,
		instanceId: string,
		userId: string,
		syncStrategy: "auto" | "manual" | "notify" | undefined,
		conflictResolutions: Record<string, "use_template" | "keep_existing"> | undefined,
		profileName: string,
		resolvedTargetProfile: SdkQualityProfile | undefined,
		reviewedTargetProfileToken: string | undefined,
		orphanedManagedFormats: OrphanedManagedCustomFormat[],
		instanceOverrideScores: ReadonlyMap<number, number>,
		equivalentInstanceIds: string[],
		effectiveQualityConfig?: CustomQualityConfig,
		persistProfileState: (state: QualityProfileBackupState) => Promise<void> = async () => {},
		connectionBindings: DeploymentConnectionBinding[] = equivalentInstanceIds.map((id) => ({
			instanceId: id,
			connectionGeneration: 0,
			connectionStateToken: "",
		})),
		connectionReadBindings: DeploymentConnectionReadBinding[] = connectionBindings,
		previousManagedFormats: ManagedCustomFormatIdentity[] = [],
	): Promise<SyncQualityProfileResult> {
		const errors: string[] = [];
		const orphanedCFs: string[] = [];
		let mutation: QualityProfileMutation | undefined;
		const connectionBinding = connectionBindings.find(
			(binding) => binding.instanceId === instanceId,
		) ?? {
			instanceId,
			connectionGeneration: 0,
			connectionStateToken: "",
		};

		try {
			let targetProfile = resolvedTargetProfile;
			let createdProfile = false;
			if (targetProfile?.id !== undefined) {
				const freshTargetProfile = (await client.qualityProfile.getById(
					targetProfile.id,
				)) as SdkQualityProfile;
				if (freshTargetProfile.id !== targetProfile.id) {
					throw new ConflictError(
						"The target quality profile identity changed during deployment. Refresh the preview and try again.",
					);
				}
				if (
					reviewedTargetProfileToken &&
					createQualityProfileStateToken(freshTargetProfile) !== reviewedTargetProfileToken
				) {
					throw new ConflictError(
						"The target quality profile changed during deployment. Refresh the preview and review the deployment again.",
					);
				}
				targetProfile = freshTargetProfile;
			}

			if (!targetProfile) {
				const currentProfiles = await client.qualityProfile.getAll();
				if (currentProfiles.some((profile) => profile.name === profileName)) {
					throw new ConflictError(
						`Quality profile "${profileName}" appeared during deployment. Refresh the preview and try again.`,
					);
				}
				createdProfile = true;
				await persistProfileState({
					beforeProfile: null,
					status: "pending",
					action: "created",
					profileId: null,
					profileName,
					postStateToken: null,
					intendedPostStateToken: null,
				});
				targetProfile = await createQualityProfileFromSchema(
					client,
					templateConfig,
					templateCFs,
					profileName,
					effectiveQualityConfig,
				);
				if (targetProfile?.id === undefined) {
					throw new Error("ARR created the quality profile without returning its ID");
				}
				mutation = {
					action: "created",
					profileId: targetProfile.id,
					profileName: targetProfile.name ?? profileName,
					postStateToken: null,
				};
				await persistProfileState({
					beforeProfile: null,
					status: "pending",
					action: "created",
					profileId: targetProfile.id,
					profileName: targetProfile.name ?? profileName,
					postStateToken: null,
					intendedPostStateToken: null,
				});
			}

			if (targetProfile) {
				const allCFs = await client.customFormat.getAll();
				const cfMap = new Map(allCFs.map((cf) => [cf.name, cf]));

				const formatItems: Array<{ format: number; score: number }> = [];
				const scoreSet = templateConfig.qualityProfile?.trash_score_set;

				const existingScoreMap = new Map<number, number>();
				for (const item of targetProfile.formatItems || []) {
					if (item.format !== undefined && item.score !== undefined) {
						existingScoreMap.set(item.format, item.score);
					}
				}

				for (const templateCF of templateCFs) {
					const cf = cfMap.get(templateCF.name);
					if (cf?.id) {
						const conflictResolution = conflictResolutions?.[templateCF.trashId];
						if (conflictResolution === "keep_existing") {
							const existingScore = existingScoreMap.get(cf.id);
							if (existingScore !== undefined) {
								formatItems.push({ format: cf.id, score: existingScore });
								continue;
							}
						}

						const instanceOverrideScore = instanceOverrideScores.get(cf.id);
						const { score: templateScore } = calculateScoreAndSource(
							templateCF,
							scoreSet,
							instanceOverrideScore,
						);

						const existingScore = existingScoreMap.get(cf.id);
						const previousManagedFormat = previousManagedFormats.find(
							(previous) =>
								previous.trashId === templateCF.trashId &&
								previous.resourceId === cf.id &&
								previous.profileId === targetProfile.id,
						);
						const manuallyDriftedAfterDeployment =
							previousManagedFormat !== undefined &&
							existingScore !== previousManagedFormat.appliedScore;
						if (
							existingScore !== undefined &&
							existingScore !== templateScore &&
							!instanceOverrideScores.has(cf.id) &&
							templateCF.scoreOverride === undefined &&
							conflictResolution !== "use_template" &&
							(previousManagedFormat === undefined || manuallyDriftedAfterDeployment)
						) {
							// Preserve genuine manual Radarr/Sonarr drift, but do not mistake
							// the score applied by the previous deployment for user intent.
							formatItems.push({ format: cf.id, score: existingScore });
						} else {
							formatItems.push({ format: cf.id, score: templateScore });
						}
					}
				}

				// Handle orphaned CFs
				const addedFormatIds = new Set(formatItems.map((item) => item.format));

				for (const orphaned of orphanedManagedFormats) {
					if (addedFormatIds.has(orphaned.resourceId)) continue;
					formatItems.push({
						format: orphaned.resourceId,
						score: 0,
					});
					addedFormatIds.add(orphaned.resourceId);
					orphanedCFs.push(orphaned.name);
				}

				// Merge with existing formatItems
				const existingFormatMap = new Map(
					(targetProfile.formatItems || []).map((item) => [item.format, item]),
				);
				for (const newItem of formatItems) {
					existingFormatMap.set(newItem.format, newItem);
				}

				// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR quality profile
				let updatedProfile: any = {
					...targetProfile,
					formatItems: Array.from(existingFormatMap.values()),
				};

				// Cache schema to avoid redundant API call when both cloned profile and quality override are active
				// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR schema type varies by service
				let cachedSchema: any = null;

				// Update quality items for cloned profiles
				if (templateConfig.completeQualityProfile) {
					const clonedProfile = templateConfig.completeQualityProfile;
					cachedSchema = await client.qualityProfile.getSchema();
					const schema = cachedSchema;

					const currentAllowedStates = new Map<string, boolean>();
					for (const item of targetProfile.items || []) {
						if (item.quality?.name) {
							currentAllowedStates.set(
								normalizeQualityName(item.quality.name),
								item.allowed ?? false,
							);
						}
						if (item.name && item.items && Array.isArray(item.items) && item.items.length > 0) {
							currentAllowedStates.set(normalizeQualityName(item.name), item.allowed ?? false);
							for (const sub of item.items) {
								if (sub.quality?.name) {
									currentAllowedStates.set(
										normalizeQualityName(sub.quality.name),
										sub.allowed ?? false,
									);
								}
							}
						}
					}

					const { byId: allAvailableQualities, byName: qualitiesByName } =
						extractQualitiesFromSchema(schema.items || []);

					let customGroupId = 1000;
					// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR quality item
					const qualityItems: any[] = [];
					const sourceIdToNewId = new Map<number, number>();

					for (const sourceItem of clonedProfile.items || []) {
						if (
							sourceItem.items &&
							Array.isArray(sourceItem.items) &&
							sourceItem.items.length > 0
						) {
							// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR quality item
							const groupQualities: any[] = [];
							for (const subItem of sourceItem.items) {
								let targetQuality = allAvailableQualities.get(subItem.id);
								if (!targetQuality && subItem.name) {
									targetQuality = qualitiesByName.get(normalizeQualityName(subItem.name));
								}
								if (targetQuality) {
									groupQualities.push({
										quality: targetQuality.quality,
										items: [],
										allowed:
											currentAllowedStates.get(normalizeQualityName(subItem.name || "")) ??
											subItem.allowed,
									});
								}
							}
							if (groupQualities.length > 0) {
								const newGroupId = customGroupId++;
								if (sourceItem.id !== undefined) {
									sourceIdToNewId.set(sourceItem.id, newGroupId);
								}
								qualityItems.push({
									name: sourceItem.name,
									items: groupQualities,
									allowed:
										currentAllowedStates.get(normalizeQualityName(sourceItem.name || "")) ??
										sourceItem.allowed,
									id: newGroupId,
								});
							}
						} else if (sourceItem.quality) {
							let targetQuality = allAvailableQualities.get(sourceItem.quality.id);
							if (!targetQuality && sourceItem.quality.name) {
								targetQuality = qualitiesByName.get(normalizeQualityName(sourceItem.quality.name));
							}
							if (targetQuality) {
								const newId = targetQuality.quality?.id ?? sourceItem.quality.id;
								if (sourceItem.quality.id !== undefined) {
									sourceIdToNewId.set(sourceItem.quality.id, newId);
								}
								qualityItems.push({
									...targetQuality,
									allowed:
										currentAllowedStates.get(normalizeQualityName(sourceItem.quality.name || "")) ??
										sourceItem.allowed,
								});
							}
						}
					}

					let remappedCutoff = clonedProfile.cutoff;
					if (sourceIdToNewId.has(clonedProfile.cutoff)) {
						remappedCutoff = sourceIdToNewId.get(clonedProfile.cutoff)!;
					} else if (qualityItems.length > 0) {
						const lastItem = qualityItems[qualityItems.length - 1];
						remappedCutoff = lastItem.id ?? lastItem.quality?.id ?? 1;
					}

					updatedProfile = {
						...updatedProfile,
						upgradeAllowed: clonedProfile.upgradeAllowed,
						cutoff: remappedCutoff,
						items: qualityItems,
						minFormatScore: clonedProfile.minFormatScore ?? updatedProfile.minFormatScore,
						cutoffFormatScore: clonedProfile.cutoffFormatScore ?? updatedProfile.cutoffFormatScore,
						minUpgradeFormatScore:
							clonedProfile.minUpgradeFormatScore ?? updatedProfile.minUpgradeFormatScore,
						...(clonedProfile.language && { language: clonedProfile.language }),
					};
				}

				// Apply instance-specific quality override (takes precedence over cloned profile settings)
				if (effectiveQualityConfig?.useCustomQualities && effectiveQualityConfig.items.length > 0) {
					const overrideSchema = cachedSchema ?? (await client.qualityProfile.getSchema());
					const { byName: qualitiesByName } = extractQualitiesFromSchema(
						overrideSchema.items || [],
					);

					let customGroupId = 1000;
					// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR quality item
					const qualityItems: any[] = [];
					const itemIdMap = new Map<string, number>();

					for (const entry of effectiveQualityConfig.items) {
						if (entry.type === "group") {
							const group = entry.group;
							// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR quality item
							const groupQualities: any[] = [];

							for (const quality of group.qualities) {
								const targetQuality = qualitiesByName.get(normalizeQualityName(quality.name));
								if (targetQuality) {
									groupQualities.push({
										quality: targetQuality.quality,
										items: [],
										allowed: false,
									});
								} else {
									log.warn(
										{ qualityName: quality.name, instanceId },
										"Quality override references unknown quality in group — item skipped",
									);
								}
							}

							if (groupQualities.length > 0) {
								const newGroupId = customGroupId++;
								itemIdMap.set(group.id, newGroupId);
								qualityItems.push({
									name: group.name,
									items: groupQualities,
									allowed: group.allowed,
									id: newGroupId,
								});
							}
						} else {
							const item = entry.item;
							const targetQuality = qualitiesByName.get(normalizeQualityName(item.name));
							if (targetQuality) {
								const qualityId = targetQuality.quality?.id;
								if (qualityId !== undefined) {
									itemIdMap.set(item.id, qualityId);
								}
								qualityItems.push({
									...targetQuality,
									allowed: item.allowed,
								});
							} else {
								log.warn(
									{ qualityName: item.name, instanceId },
									"Quality override references unknown quality — item skipped",
								);
							}
						}
					}

					let cutoffId: number | null = null;
					if (effectiveQualityConfig.cutoffId) {
						const mappedId = itemIdMap.get(effectiveQualityConfig.cutoffId);
						if (mappedId !== undefined) {
							cutoffId = mappedId;
						}
					}

					if (cutoffId === null && qualityItems.length > 0) {
						const lastItem = qualityItems[qualityItems.length - 1];
						const resolvedId = lastItem.id ?? lastItem.quality?.id ?? null;
						if (resolvedId === null) {
							log.warn(
								{ instanceId, qualityItemCount: qualityItems.length },
								"Could not resolve cutoff from quality items — falling back to ID 1",
							);
							cutoffId = 1;
						} else {
							cutoffId = resolvedId;
						}
					}

					updatedProfile = {
						...updatedProfile,
						cutoff: cutoffId ?? updatedProfile.cutoff,
						items: qualityItems,
					};
				}

				if (targetProfile.id === undefined) {
					throw new Error("Quality profile ID is missing");
				}
				const [latestTargetProfile, latestOverrideScores] = await Promise.all([
					client.qualityProfile.getById(targetProfile.id) as Promise<SdkQualityProfile>,
					this.loadEquivalentInstanceOverrideScores(
						userId,
						connectionReadBindings,
						targetProfile.id,
					),
				]);
				if (
					createQualityProfileStateToken(latestTargetProfile) !==
						createQualityProfileStateToken(targetProfile) ||
					createUpstreamResourceStateToken([...latestOverrideScores.entries()]) !==
						createUpstreamResourceStateToken([...instanceOverrideScores.entries()])
				) {
					throw new ConflictError(
						"The target quality profile or its saved score overrides changed during deployment. Refresh the preview and try again.",
					);
				}

				await persistProfileState({
					beforeProfile: createdProfile ? null : targetProfile,
					status: "pending",
					action: createdProfile ? "created" : "updated",
					profileId: targetProfile.id,
					profileName: targetProfile.name ?? profileName,
					postStateToken: null,
					intendedPostStateToken: createQualityProfileStateToken(updatedProfile),
				});
				// biome-ignore lint/suspicious/noExplicitAny: Sonarr/Radarr profile types differ but are runtime-compatible
				await client.qualityProfile.update(targetProfile.id, updatedProfile as any);
				mutation = {
					action: createdProfile ? "created" : "updated",
					profileId: targetProfile.id,
					profileName: targetProfile.name ?? profileName,
					postStateToken: null,
				};
				const postWriteProfile = (await client.qualityProfile.getById(
					targetProfile.id,
				)) as SdkQualityProfile;
				mutation.postStateToken = createQualityProfileStateToken(postWriteProfile);
				await persistProfileState({
					beforeProfile: createdProfile ? null : targetProfile,
					// Keep the ledger non-terminal until mapping and complete managed
					// identity capture are committed with the backup.
					status: "pending",
					action: mutation.action,
					profileId: mutation.profileId,
					profileName: mutation.profileName,
					postStateToken: mutation.postStateToken,
					intendedPostStateToken: createQualityProfileStateToken(updatedProfile),
				});
				if (orphanedManagedFormats.length > 0) {
					await this.prisma.instanceQualityProfileOverride.deleteMany({
						where: {
							userId,
							qualityProfileId: targetProfile.id,
							customFormatId: {
								in: orphanedManagedFormats.map((format) => format.resourceId),
							},
							OR: connectionReadBindings,
						},
					});
				}

				// Clean up stale mappings for this template across every equivalent
				// service record. A recovered mapping may belong to an alias rather
				// than the record used for this deployment.
				await this.prisma.$transaction([
					this.prisma.templateQualityProfileMapping.deleteMany({
						where: {
							templateId,
							instanceId: { in: equivalentInstanceIds },
							qualityProfileId: { not: targetProfile.id },
						},
					}),
					this.prisma.templateQualityProfileMapping.upsert({
						where: {
							instanceId_qualityProfileId: {
								instanceId,
								qualityProfileId: targetProfile.id,
							},
						},
						create: {
							templateId,
							instanceId,
							qualityProfileId: targetProfile.id,
							qualityProfileName: targetProfile.name ?? profileName,
							connectionGeneration: connectionBinding.connectionGeneration,
							connectionStateToken: connectionBinding.connectionStateToken,
							syncStrategy: syncStrategy || "notify",
							lastSyncedAt: new Date(),
						},
						update: {
							templateId,
							qualityProfileName: targetProfile.name ?? profileName,
							connectionGeneration: connectionBinding.connectionGeneration,
							connectionStateToken: connectionBinding.connectionStateToken,
							...(syncStrategy && { syncStrategy }),
							lastSyncedAt: new Date(),
							updatedAt: new Date(),
						},
					}),
				]);
			}
		} catch (error) {
			if (error instanceof ConflictError) {
				throw error;
			}
			log.error({ err: error }, "Failed to update quality profile");
			errors.push(`Failed to update quality profile: ${getErrorMessage(error, "Unknown error")}`);
		}

		return { errors, orphanedCFs, mutation };
	}

	private async loadEquivalentInstanceOverrideScores(
		userId: string,
		connectionBindings: DeploymentConnectionReadBinding[],
		qualityProfileId: number,
	): Promise<Map<number, number>> {
		const overrides = await this.prisma.instanceQualityProfileOverride.findMany({
			where: {
				userId,
				status: "APPLIED",
				qualityProfileId,
				OR: connectionBindings,
			},
		});
		const scores = new Map<number, number>();
		for (const override of overrides) {
			const existingScore = scores.get(override.customFormatId);
			if (existingScore !== undefined && existingScore !== override.score) {
				throw new ConflictError(
					"Duplicate records for this ARR instance have conflicting saved Custom Format score overrides. Resolve the duplicate instance settings before deploying.",
				);
			}
			scores.set(override.customFormatId, override.score);
		}
		return scores;
	}

	// ============================================================================
	// Public Methods
	// ============================================================================

	async runWithEndpointMutation<T>(
		userId: string,
		instance: Parameters<typeof createDeploymentEndpointKey>[1],
		operation: string,
		action: (endpointKey: string) => Promise<T>,
	): Promise<T> {
		const endpointKey = createDeploymentEndpointKey(userId, instance);
		if (this.activeMutationEndpoints.has(endpointKey)) {
			throw new AppValidationError(
				`${operation} cannot start while another deployment or rollback is active for this ARR endpoint.`,
			);
		}

		this.activeMutationEndpoints.add(endpointKey);
		try {
			return await action(endpointKey);
		} finally {
			this.activeMutationEndpoints.delete(endpointKey);
		}
	}

	async deploySingleInstance(
		templateId: string,
		instanceId: string,
		userId: string,
		syncStrategy?: "auto" | "manual" | "notify",
		conflictResolutions?: Record<string, "use_template" | "keep_existing">,
		executionToken?: string,
	): Promise<DeploymentResult> {
		if (!executionToken) {
			throw new AppValidationError(
				"A fresh deployment preview token is required for user-triggered execution.",
			);
		}
		return this.deploySingleInstanceWithCapability(
			templateId,
			instanceId,
			userId,
			syncStrategy,
			conflictResolutions,
			executionToken,
		);
	}

	/** Explicit tokenless capability reserved for trusted schedulers. */
	async deploySingleInstanceFromAutomation(
		templateId: string,
		instanceId: string,
		userId: string,
		syncStrategy?: "auto" | "manual" | "notify",
		conflictResolutions?: Record<string, "use_template" | "keep_existing">,
	): Promise<DeploymentResult> {
		return this.deploySingleInstanceWithCapability(
			templateId,
			instanceId,
			userId,
			syncStrategy,
			conflictResolutions,
			undefined,
		);
	}

	private async deploySingleInstanceWithCapability(
		templateId: string,
		instanceId: string,
		userId: string,
		syncStrategy: "auto" | "manual" | "notify" | undefined,
		conflictResolutions: Record<string, "use_template" | "keep_existing"> | undefined,
		executionToken: string | undefined,
	): Promise<DeploymentResult> {
		const lockInstance = await this.prisma.serviceInstance.findFirst({
			where: { id: instanceId, userId },
			select: { service: true, baseUrl: true },
		});
		if (!lockInstance) {
			throw new InstanceNotFoundError(instanceId);
		}
		return withCleanupTopologyMutationLease({ prisma: this.prisma, log }, userId, () =>
			this.runWithEndpointMutation(userId, lockInstance, "Deployment", (endpointKey) =>
				this.executeSingleDeployment(
					templateId,
					instanceId,
					userId,
					syncStrategy,
					conflictResolutions,
					executionToken,
					endpointKey,
				),
			),
		);
	}

	/**
	 * Deploy naming presets to an instance using the TRaSH cache data.
	 * Resolves preset names to format strings, then PUTs the merged config.
	 */
	private async deployNamingPresets(
		namingState: PreparedNamingDeployment,
		instance: ValidatedDeploymentData["instance"],
		beforeWrite?: () => Promise<void>,
	): Promise<{ fieldsApplied: number; error?: string; postStateToken?: string }> {
		let fieldsApplied = 0;
		try {
			if (namingState.changedFields.length === 0) {
				return { fieldsApplied: 0 };
			}

			const currentResponse = await this.clientFactory.rawRequest(
				instance,
				"/api/v3/config/naming",
			);
			if (!currentResponse.ok) {
				return {
					fieldsApplied: 0,
					error: `Failed to read naming config: HTTP ${currentResponse.status}`,
				};
			}
			const currentConfig = (await currentResponse.json()) as Record<string, unknown>;
			if (
				createUpstreamResourceStateToken(currentConfig) !==
				createUpstreamResourceStateToken(namingState.currentConfig)
			) {
				throw new ConflictError(
					"Naming configuration changed during deployment. Refresh the preview and try again.",
				);
			}
			await beforeWrite?.();

			const putResponse = await this.clientFactory.rawRequest(instance, "/api/v3/config/naming", {
				method: "PUT",
				body: namingState.mergedConfig,
			});
			if (!putResponse.ok) {
				return {
					fieldsApplied: 0,
					error: `Failed to apply naming config: HTTP ${putResponse.status}`,
				};
			}
			fieldsApplied = namingState.changedFields.length;

			const postWriteResponse = await this.clientFactory.rawRequest(
				instance,
				"/api/v3/config/naming",
			);
			if (!postWriteResponse.ok) {
				return {
					fieldsApplied,
					error: `Naming config was applied, but its post-write state could not be verified: HTTP ${postWriteResponse.status}`,
				};
			}
			const postWriteConfig = (await postWriteResponse.json()) as Record<string, unknown>;

			log.info(
				{ instanceId: instance.id, fieldsApplied: namingState.changedFields.length },
				"Naming presets deployed via template",
			);
			return {
				fieldsApplied,
				postStateToken: createUpstreamResourceStateToken(postWriteConfig),
			};
		} catch (error) {
			if (error instanceof ConflictError) throw error;
			return {
				fieldsApplied,
				error: `Naming deployment failed: ${getErrorMessage(error, "Unknown error")}`,
			};
		}
	}

	private async executeSingleDeployment(
		templateId: string,
		instanceId: string,
		userId: string,
		syncStrategy?: "auto" | "manual" | "notify",
		conflictResolutions?: Record<string, "use_template" | "keep_existing">,
		executionToken?: string,
		expectedEndpointKey?: string,
	): Promise<DeploymentResult> {
		const startTime = new Date();
		let historyId: string | null = null;
		let deploymentHistoryId: string | null = null;
		let partialCFResult: DeployCustomFormatsResult | null = null;
		const warnings: string[] = [];
		let appliedProfileMutation: QualityProfileMutation | undefined;
		let deploymentPhase: "before_cf" | "custom_formats" | "quality_profile" | "post_profile" =
			"before_cf";

		const metrics = getSyncMetrics();
		const completeMetrics = metrics.startOperation("deployment");

		try {
			const { template, instance, templateConfig, templateCFs, effectiveQualityConfig } =
				await this.validateAndPrepareDeployment(templateId, instanceId, userId);
			if (
				expectedEndpointKey &&
				createDeploymentEndpointKey(userId, instance) !== expectedEndpointKey
			) {
				throw new ConflictError(
					"The ARR service connection changed while deployment was starting. Refresh the preview and try again.",
				);
			}

			const client = this.clientFactory.create(instance) as SonarrClient | RadarrClient;
			try {
				await client.system.get();
			} catch (error) {
				throw new Error(`Instance unreachable: ${getErrorMessage(error, "Unknown error")}`);
			}

			// Resolve and authorize the exact upstream target before any write or history mutation.
			const serviceAliases = await this.prisma.serviceInstance.findMany({
				where: { userId, service: instance.service },
				select: {
					id: true,
					service: true,
					baseUrl: true,
					encryptedApiKey: true,
					encryptionIv: true,
					encryptedHttpAuthCredentials: true,
					httpAuthEncryptionIv: true,
					connectionGeneration: true,
				},
			});
			const credentialIdentity = this.createCredentialIdentity(instance);
			const equivalentInstanceIds = getEquivalentServiceInstanceIds(
				serviceAliases.map((alias) => ({
					...alias,
					credentialIdentity: this.createCredentialIdentity(alias),
				})),
				{ ...instance, credentialIdentity },
			);
			if (!equivalentInstanceIds.includes(instanceId)) {
				equivalentInstanceIds.push(instanceId);
			}
			const connectionBindings = serviceAliases
				.filter((alias) => equivalentInstanceIds.includes(alias.id))
				.map((alias) => ({
					instanceId: alias.id,
					connectionGeneration: alias.connectionGeneration,
					connectionStateToken: createDeploymentConnectionStateToken(alias),
				}));
			const connectionReadBindings = serviceAliases
				.filter((alias) => equivalentInstanceIds.includes(alias.id))
				.flatMap(createDeploymentConnectionBindingCandidates);
			await assertNoPendingDeploymentOperation(this.prisma, userId, equivalentInstanceIds);

			const [existingCFs, fetchedProfiles, qualityProfileMappings] = await Promise.all([
				client.customFormat.getAll(),
				client.qualityProfile.getAll(),
				this.prisma.templateQualityProfileMapping.findMany({
					where: {
						OR: [
							...connectionReadBindings,
							...createLegacyDeploymentConnectionBindings(equivalentInstanceIds),
						],
					},
					orderBy: { updatedAt: "desc" },
				}),
			]);
			const legacyMappings = qualityProfileMappings.filter(isLegacyDeploymentConnectionMapping);
			if (legacyMappings.length > 0 && !executionToken) {
				assertNoLegacyDeploymentConnectionMappings(legacyMappings);
			}
			const allProfiles = fetchedProfiles as SdkQualityProfile[];
			const templateMappings = qualityProfileMappings.filter(
				(mapping) => mapping.templateId === templateId,
			);
			if (new Set(templateMappings.map((mapping) => mapping.qualityProfileId)).size > 1) {
				throw new ConflictError(
					"This template has conflicting quality-profile mappings for duplicate records of the same ARR instance. Unlink the stale deployment before continuing.",
				);
			}
			const qualityProfileMapping =
				templateMappings.find((mapping) => mapping.instanceId === instanceId) ??
				templateMappings[0];
			const selectedMappingIsLegacy = Boolean(
				qualityProfileMapping && isLegacyDeploymentConnectionMapping(qualityProfileMapping),
			);
			const resolvedTarget = resolveDeploymentTarget({
				profiles: allProfiles,
				mapping: qualityProfileMapping,
				sourceProfileId: templateConfig.completeQualityProfile?.sourceProfileId,
				isSourceInstance: equivalentInstanceIds.includes(
					templateConfig.completeQualityProfile?.sourceInstanceId ?? "",
				),
				sourceProfileName: template.sourceQualityProfileName,
				templateName: template.name,
			});
			if (resolvedTarget.matchedBy === "mapping_name" && !executionToken) {
				throw new ConflictError(
					"The mapped quality profile was recreated. Review a fresh deployment preview before relinking it.",
				);
			}
			assertDeploymentTargetOwnership({
				target: resolvedTarget,
				templateId,
				existingMappings: qualityProfileMappings,
			});
			const preDeploymentQP =
				resolvedTarget.profile?.id !== undefined
					? ((await client.qualityProfile.getById(resolvedTarget.profile.id)) as SdkQualityProfile)
					: null;
			if (preDeploymentQP?.id !== resolvedTarget.profile?.id) {
				throw new ConflictError(
					"The target quality profile identity changed before its full rollback snapshot was captured.",
				);
			}
			const authorizedTarget = { ...resolvedTarget, profile: preDeploymentQP ?? undefined };
			const profileName = resolvedTarget.profileName;
			const reviewedTargetProfileToken = executionToken
				? createQualityProfileStateToken(authorizedTarget.profile ?? null)
				: undefined;
			const namingSelection = templateConfig.namingSelection as NamingSelectedPresets | undefined;
			const namingState = namingSelection
				? await prepareNamingDeployment(this.prisma, this.clientFactory, instance, namingSelection)
				: undefined;
			const overrideReadBindings = selectedMappingIsLegacy
				? [
						...connectionReadBindings,
						...createLegacyDeploymentConnectionBindings(equivalentInstanceIds),
					]
				: connectionReadBindings;
			const instanceOverrideScores =
				authorizedTarget.profile?.id !== undefined
					? await this.loadEquivalentInstanceOverrideScores(
							userId,
							overrideReadBindings,
							authorizedTarget.profile.id,
						)
					: new Map<number, number>();
			let previousManagedFormats: ManagedCustomFormatIdentity[] = [];
			try {
				previousManagedFormats =
					selectedMappingIsLegacy && !qualityProfileMapping?.managedCustomFormatsCaptured
						? []
						: readPersistedManagedCustomFormatIdentities(qualityProfileMapping);
			} catch (parseError) {
				throw new ConflictError(
					`The previous deployment's Custom Format identity metadata is unavailable or invalid: ${getErrorMessage(parseError)}`,
				);
			}
			const orphanResolution = await resolveOrphanedManagedCustomFormats(
				client,
				templateCFs,
				previousManagedFormats,
				authorizedTarget.profile,
			);
			warnings.push(...orphanResolution.warnings);
			const currentProfileScores = new Map(
				(authorizedTarget.profile?.formatItems ?? []).map((item) => [item.format, item.score]),
			);
			const orphanedFormatScoreChanges = orphanResolution.formats.map((format) => ({
				instanceId: format.resourceId,
				name: format.name,
				score:
					currentProfileScores.get(format.resourceId) ??
					instanceOverrideScores.get(format.resourceId) ??
					0,
			}));

			if (executionToken) {
				const currentToken = createDeploymentStateToken({
					template: {
						id: template.id,
						name: template.name,
						configData: template.configData,
						instanceOverrides: template.instanceOverrides,
						sourceQualityProfileName: template.sourceQualityProfileName,
					},
					instanceId,
					connection: {
						service: instance.service,
						baseUrl: instance.baseUrl,
						credentialIdentity: [
							instance.encryptedApiKey,
							instance.encryptionIv,
							instance.encryptedHttpAuthCredentials,
							instance.httpAuthEncryptionIv,
						].join(":"),
					},
					target: authorizedTarget,
					customFormats: existingCFs,
					namingConfig: namingState?.currentConfig,
					namingPayload: namingState?.mergedConfig,
					savedScoreOverrides: [...instanceOverrideScores.entries()].sort(
						([left], [right]) => left - right,
					),
					orphanedFormatScoreChanges,
				});
				if (currentToken !== executionToken) {
					throw new ConflictError(
						"The template or instance changed after this preview. Refresh the preview and review the deployment again.",
					);
				}

				if (selectedMappingIsLegacy && qualityProfileMapping) {
					const mappingsToRebind = templateMappings.filter(isLegacyDeploymentConnectionMapping);
					await rebindLegacyDeploymentConnectionState(
						this.prisma,
						userId,
						mappingsToRebind,
						qualityProfileMapping.qualityProfileId,
						connectionBindings,
					);
				}
			}
			const { backup, historyId: syncHistoryId } = await this.createBackupAndHistory(
				instance,
				userId,
				existingCFs,
				templateId,
				preDeploymentQP,
				namingState,
			);
			const persistBackupLedger = async (): Promise<void> => {
				const backupData = JSON.stringify(backup.data);
				await this.prisma.trashBackup.update({
					where: { id: backup.id },
					data: {
						backupData,
						expiresAt: shouldRetainDeploymentBackup(backupData) ? null : backup.retentionExpiresAt,
					},
				});
			};
			historyId = syncHistoryId;
			const existingCFMap = new Map<string, SdkCustomFormat>();
			const existingCFByName = new Map<string, SdkCustomFormat>();
			for (const cf of existingCFs) {
				const trashId = extractTrashId(cf);
				if (trashId) {
					existingCFMap.set(trashId, cf);
				}
				if (cf.name) {
					existingCFByName.set(cf.name, cf);
				}
			}

			const deploymentHistory = await this.prisma.templateDeploymentHistory.create({
				data: {
					templateId,
					instanceId,
					userId,
					deployedBy: userId,
					status: "IN_PROGRESS",
					totalCFs: templateCFs.length,
					appliedCFs: 0,
					failedCFs: 0,
					conflictsCount: 0,
					backupId: backup.id,
					canRollback: true,
					templateSnapshot: template.configData,
				},
			});
			deploymentHistoryId = deploymentHistory.id;

			deploymentPhase = "custom_formats";
			const cfResult = await this.deployCustomFormats(
				client,
				templateCFs,
				existingCFMap,
				existingCFByName,
				conflictResolutions,
				async (state, append) => {
					if (append) backup.data.customFormatDeployments.push(state);
					try {
						await persistBackupLedger();
					} catch (error) {
						if (append) {
							backup.data.customFormatDeployments = backup.data.customFormatDeployments.filter(
								(entry) => entry !== state,
							);
						}
						throw error;
					}
				},
			);
			partialCFResult = cfResult;
			deploymentPhase = "quality_profile";

			const profileResult = await this.syncQualityProfile(
				client,
				templateConfig,
				templateCFs,
				templateId,
				instanceId,
				userId,
				syncStrategy,
				conflictResolutions,
				profileName,
				preDeploymentQP ?? undefined,
				reviewedTargetProfileToken,
				orphanResolution.formats,
				instanceOverrideScores,
				equivalentInstanceIds,
				effectiveQualityConfig,
				async (state) => {
					backup.data.qualityProfileDeployment = state;
					await persistBackupLedger();
				},
				connectionBindings,
				connectionReadBindings,
				previousManagedFormats,
			);
			appliedProfileMutation = profileResult.mutation;
			if (profileResult.errors.length === 0) {
				const managedProfileId = appliedProfileMutation?.profileId ?? preDeploymentQP?.id;
				if (managedProfileId === undefined) {
					throw new ConflictError(
						"The managed quality profile identity could not be captured after deployment.",
					);
				}
				const managedProfile = (await client.qualityProfile.getById(
					managedProfileId,
				)) as SdkQualityProfile;
				const managedCustomFormats = await captureManagedCustomFormatIdentities(
					client,
					templateCFs,
					managedProfile,
				);
				backup.data.managedCustomFormats = managedCustomFormats;
				backup.data.managedCustomFormatsCaptured = true;
				if (backup.data.qualityProfileDeployment.status === "pending") {
					backup.data.qualityProfileDeployment.status = "applied";
				}
				const capturedBackupData = JSON.stringify(backup.data);
				await this.prisma.$transaction([
					this.prisma.templateQualityProfileMapping.updateMany({
						where: {
							templateId,
							qualityProfileId: managedProfileId,
							OR: connectionBindings,
						},
						data: {
							managedCustomFormats: JSON.stringify(managedCustomFormats),
							managedCustomFormatsCaptured: true,
						},
					}),
					this.prisma.trashBackup.update({
						where: { id: backup.id },
						data: {
							backupData: capturedBackupData,
							expiresAt: shouldRetainDeploymentBackup(capturedBackupData)
								? null
								: backup.retentionExpiresAt,
						},
					}),
				]);
			}
			deploymentPhase = "post_profile";

			// Deploy naming presets if the template includes them
			let namingWarning: string | undefined;
			let namingFieldsApplied = 0;
			if (namingState && profileResult.errors.length === 0) {
				const namingResult = await this.deployNamingPresets(namingState, instance, async () => {
					if (!backup.data.namingDeployment) {
						throw new Error("Naming rollback metadata is unavailable");
					}
					backup.data.namingDeployment.status = "pending";
					await persistBackupLedger();
				});
				namingFieldsApplied = namingResult.fieldsApplied;
				if (namingResult.error) {
					profileResult.errors.push(namingResult.error);
				} else if (
					namingResult.fieldsApplied > 0 &&
					namingResult.postStateToken &&
					backup.data.namingDeployment
				) {
					backup.data.namingDeployment.status = "applied";
					backup.data.namingDeployment.postStateToken = namingResult.postStateToken;
					try {
						await persistBackupLedger();
						namingWarning = `Naming presets applied (${namingResult.fieldsApplied} field(s) updated)`;
					} catch (backupError) {
						log.error(
							{ err: backupError, backupId: backup.id, instanceId },
							"Naming presets applied but rollback metadata could not be finalized",
						);
						profileResult.errors.push(
							"Naming presets were applied, but rollback metadata could not be finalized. Check the server logs before attempting a rollback.",
						);
					}
				}
			}

			const allErrors = [...cfResult.errors, ...profileResult.errors];

			if (namingWarning) {
				warnings.push(namingWarning);
			}
			if (profileResult.orphanedCFs.length > 0) {
				warnings.push(
					`${profileResult.orphanedCFs.length} Custom Format(s) removed from TRaSH Guides - scores set to 0: ${profileResult.orphanedCFs.join(", ")}`,
				);
			}

			// Check for mutually exclusive CF selections using upstream conflict data
			try {
				const conflictCacheManager = createCacheManager(this.prisma);
				const conflictGroups = await conflictCacheManager.get<TrashConflictGroup[]>(
					instance.service.toUpperCase() as "RADARR" | "SONARR",
					"CONFLICTS",
				);
				if (conflictGroups && conflictGroups.length > 0) {
					const selectedIds = new Set(templateCFs.map((cf) => cf.trashId.toLowerCase()));
					const exclusionWarnings = checkMutualExclusions(selectedIds, conflictGroups);
					for (const w of exclusionWarnings) {
						warnings.push(w.message);
					}
				}
			} catch (conflictCheckError) {
				log.debug(
					{ err: conflictCheckError },
					"CF conflict check skipped — data may not be cached",
				);
			}

			cfResult.details.orphaned = profileResult.orphanedCFs;

			try {
				await finalizeDeploymentHistory(
					this.prisma,
					historyId,
					deploymentHistoryId,
					startTime,
					cfResult.details,
					{ created: cfResult.created, updated: cfResult.updated, skipped: cfResult.skipped },
					allErrors,
					appliedProfileMutation,
					namingFieldsApplied,
				);
			} catch (historyError) {
				log.error(
					{ err: historyError, templateId, instanceId },
					"Deployment succeeded but history finalization failed",
				);
				warnings.push(
					"Deployment completed, but its history record could not be finalized. Check the server logs.",
				);
			}

			const metricsResult = completeMetrics();
			if (allErrors.length === 0) {
				metricsResult.recordSuccess();
			} else {
				metricsResult.recordFailure(allErrors[0]);
			}

			return {
				instanceId,
				instanceLabel: instance.label,
				success: allErrors.length === 0,
				customFormatsCreated: cfResult.created,
				customFormatsUpdated: cfResult.updated,
				customFormatsSkipped: cfResult.skipped,
				errors: allErrors,
				warnings: warnings.length > 0 ? warnings : undefined,
				qualityProfileApplied: toPublicQualityProfileMutation(appliedProfileMutation),
				namingFieldsApplied,
				details: cfResult.details,
			};
		} catch (error) {
			const errorMessage = getErrorMessage(error, "Unknown error");
			const metricsResult = completeMetrics();
			metricsResult.recordFailure(errorMessage);
			const thrownPartialResult = getPartialDeploymentResult(error);
			const partialDetails = partialCFResult?.details ?? thrownPartialResult?.details;
			const partialProfile = appliedProfileMutation ?? thrownPartialResult?.qualityProfile;
			const partialCounts = partialCFResult
				? {
						created: partialCFResult.created,
						updated: partialCFResult.updated,
						skipped: partialCFResult.skipped,
					}
				: thrownPartialResult
					? {
							created: thrownPartialResult.created,
							updated: thrownPartialResult.updated,
							skipped: thrownPartialResult.skipped,
						}
					: undefined;

			try {
				if (partialDetails && partialCounts && deploymentPhase !== "before_cf") {
					await finalizeDeploymentHistoryWithPartialFailure(
						this.prisma,
						historyId,
						deploymentHistoryId,
						startTime,
						partialDetails,
						partialCounts,
						error,
						partialProfile,
					);
				} else {
					await finalizeDeploymentHistoryWithFailure(
						this.prisma,
						historyId,
						deploymentHistoryId,
						startTime,
						error,
					);
				}
			} catch (historyError) {
				log.error(
					{ err: historyError, originalError: errorMessage },
					"Failed to record deployment failure in history",
				);
			}

			if (error instanceof ConflictError) {
				if (partialDetails && partialCounts) {
					const partialDeployment = {
						...partialCounts,
						details: partialDetails,
						...(partialProfile && { qualityProfile: partialProfile }),
					};
					const publicPartialDeployment = {
						...partialCounts,
						details: partialDetails,
						...(partialProfile && {
							qualityProfile: toPublicQualityProfileMutation(partialProfile),
						}),
					};
					Object.assign(error, {
						partialDeployment,
						details: { partialDeployment: publicPartialDeployment },
					});
				}
				throw error;
			}

			return {
				instanceId,
				instanceLabel: "Unknown",
				success: false,
				customFormatsCreated: 0,
				customFormatsUpdated: 0,
				customFormatsSkipped: 0,
				errors: [errorMessage],
			};
		}
	}

	async deployBulkInstances(
		templateId: string,
		instanceIds: string[],
		userId: string,
		syncStrategy: "auto" | "manual" | "notify" | undefined,
		instanceSyncStrategies: Record<string, "auto" | "manual" | "notify"> | undefined,
		executionTokens: Record<string, string>,
	): Promise<BulkDeploymentResult> {
		if (new Set(instanceIds).size !== instanceIds.length) {
			throw new AppValidationError(
				"Bulk deployment contains the same service instance more than once.",
			);
		}
		for (const instanceId of instanceIds) {
			if (!executionTokens[instanceId]) {
				throw new AppValidationError(
					"A fresh deployment preview token is required for every user-triggered bulk target.",
				);
			}
		}
		const template = await this.prisma.trashTemplate.findUnique({
			where: { id: templateId, userId },
		});

		if (!template) {
			throw new TemplateNotFoundError(templateId);
		}

		const selectedInstances = await this.prisma.serviceInstance.findMany({
			where: { id: { in: instanceIds }, userId },
			select: { id: true, service: true, baseUrl: true },
		});
		const endpointOwners = new Map<string, string>();
		for (const instance of selectedInstances) {
			const endpointKey = createDeploymentEndpointKey(userId, instance);
			const existingInstanceId = endpointOwners.get(endpointKey);
			if (existingInstanceId && existingInstanceId !== instance.id) {
				throw new AppValidationError(
					"Bulk deployment includes multiple service records for the same ARR endpoint. Select only one record for each endpoint.",
				);
			}
			endpointOwners.set(endpointKey, instance.id);
		}

		// The cleanup topology lease is per user. Run bulk targets sequentially so
		// individual deployments do not contend with one another for that lease.
		const results: DeploymentResult[] = [];
		for (let i = 0; i < instanceIds.length; i++) {
			const instanceId = instanceIds[i]!;
			try {
				const strategy = instanceSyncStrategies?.[instanceId] ?? syncStrategy;
				results.push(
					await this.deploySingleInstance(
						templateId,
						instanceId,
						userId,
						strategy,
						undefined,
						executionTokens[instanceId],
					),
				);
			} catch (error) {
				const partialDeployment = getPartialDeploymentResult(error);
				results.push({
					instanceId,
					instanceLabel: `Instance ${i + 1}`,
					success: false,
					customFormatsCreated: partialDeployment?.created ?? 0,
					customFormatsUpdated: partialDeployment?.updated ?? 0,
					customFormatsSkipped: partialDeployment?.skipped ?? 0,
					errors: [getErrorMessage(error, "Deployment failed")],
					qualityProfileApplied: toPublicQualityProfileMutation(partialDeployment?.qualityProfile),
					details: partialDeployment?.details,
				});
			}
		}

		const successfulInstances = results.filter((r) => r.success).length;
		const failedInstances = results.filter((r) => !r.success).length;

		return {
			templateId,
			templateName: template.name,
			totalInstances: instanceIds.length,
			successfulInstances,
			failedInstances,
			results,
		};
	}
}
