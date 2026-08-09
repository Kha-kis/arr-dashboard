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
import { withCleanupTopologyMutationLease } from "../library-cleanup/cleanup-executor.js";
import { loggers } from "../logger.js";
import { getErrorMessage } from "../utils/error-message.js";
import { createCacheManager } from "./cache-manager.js";
import {
	buildCustomFormatIdentityIndex,
	extractTrashId,
	transformFieldsToArray,
} from "./cf-field-utils.js";
import { checkMutualExclusions } from "./conflict-checker.js";
import { shouldRetainDeploymentBackup } from "./deployment-backup-state.js";
import type { CustomFormatRollbackState } from "./deployment-custom-format-state.js";
import {
	finalizeDeploymentHistory,
	finalizeDeploymentHistoryWithFailure,
	finalizeDeploymentHistoryWithPartialFailure,
	isDeploymentResultUncertain,
} from "./deployment-history-manager.js";
import {
	captureManagedCustomFormatIdentities,
	type ManagedCustomFormatIdentity,
	type OrphanedManagedCustomFormat,
	readPersistedManagedCustomFormatIdentities,
	resolveOrphanedManagedCustomFormats,
} from "./deployment-managed-format-state.js";
import {
	type PreparedNamingDeployment,
	prepareNamingDeployment,
} from "./deployment-naming-state.js";
import { assertNoPendingDeploymentOperation } from "./deployment-operation-gate.js";
import {
	assertDeploymentTargetOwnership,
	createDeploymentConnectionBindingCandidates,
	createDeploymentConnectionStateToken,
	createDeploymentEndpointKey,
	createDeploymentStateToken,
	createLegacyDeploymentConnectionBindings,
	createQualityProfileStateToken,
	createUpstreamResourceStateToken,
	getEquivalentServiceInstanceIds,
	isCurrentDeploymentConnectionMapping,
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
type EndpointCredentialSource = {
	id: string;
	service: string;
	baseUrl: string;
	encryptedApiKey: string;
	encryptionIv: string;
	encryptedHttpAuthCredentials?: string | null;
	httpAuthEncryptionIv?: string | null;
	connectionGeneration?: number | null;
};
type EndpointMutationTarget =
	| EndpointCredentialSource
	| { service: string; baseUrl: string; credentialIdentity: string };

// ============================================================================
// Types
// ============================================================================

export interface DeploymentResult {
	instanceId: string;
	instanceLabel: string;
	success: boolean;
	status: "SUCCESS" | "FAILED" | "UNCERTAIN";
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
	uncertainInstances: number;
	results: DeploymentResult[];
}

interface PartialDeploymentResult {
	created: number;
	updated: number;
	skipped: number;
	details: NonNullable<DeploymentResult["details"]>;
	qualityProfile?: QualityProfileMutation;
	errors?: string[];
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
		typeof partial.details !== "object" ||
		("errors" in partial &&
			(!Array.isArray(partial.errors) ||
				partial.errors.some((message) => typeof message !== "string")))
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

function getSortedOverrideScoreEntries(
	scores: ReadonlyMap<number, number>,
): Array<[number, number]> {
	return [...scores.entries()].sort(([leftId], [rightId]) => leftId - rightId);
}

function assertIntendedWritableState(
	actual: unknown,
	intended: Record<string, unknown>,
	resourceLabel: string,
): void {
	if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
		throw new ConflictError(`${resourceLabel} returned an invalid post-write state.`);
	}
	const projectActualToIntendedShape = (actualValue: unknown, intendedValue: unknown): unknown => {
		if (Array.isArray(intendedValue)) {
			if (!Array.isArray(actualValue)) return actualValue;
			return actualValue.map((item, index) =>
				projectActualToIntendedShape(item, intendedValue[index]),
			);
		}
		if (intendedValue && typeof intendedValue === "object") {
			if (!actualValue || typeof actualValue !== "object" || Array.isArray(actualValue)) {
				return actualValue;
			}
			const actualRecord = actualValue as Record<string, unknown>;
			return Object.fromEntries(
				Object.entries(intendedValue as Record<string, unknown>).map(([key, value]) => [
					key,
					projectActualToIntendedShape(actualRecord[key], value),
				]),
			);
		}
		return actualValue;
	};
	const actualProjection = projectActualToIntendedShape(actual, intended);
	if (
		createUpstreamResourceStateToken(actualProjection) !==
		createUpstreamResourceStateToken(intended)
	) {
		throw new ConflictError(
			`${resourceLabel} did not match the intended post-write state. Resolve or roll back the interrupted deployment before retrying.`,
		);
	}
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
	resolvedResourceIds: Map<string, number>;
}

interface SyncQualityProfileResult {
	errors: string[];
	orphanedCFs: string[];
	mutation?: QualityProfileMutation;
	orphanedOverrideCleanup?: {
		userId: string;
		qualityProfileId: number;
		customFormatIds: number[];
		connectionReadBindings: DeploymentConnectionReadBinding[];
	};
	mappingFinalization?: {
		userId: string;
		templateId: string;
		instanceId: string;
		equivalentInstanceIds: string[];
		connectionBindings: DeploymentConnectionBinding[];
		connectionReadBindings: DeploymentConnectionReadBinding[];
		savedScoreOverrides: Array<[number, number]>;
		qualityProfileId: number;
		qualityProfileName: string;
		connectionGeneration: number;
		connectionStateToken: string;
		syncStrategy: "auto" | "manual" | "notify" | undefined;
	};
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

	private createCredentialIdentity(instance: EndpointCredentialSource): string {
		return typeof this.clientFactory.createConnectionCredentialIdentity === "function"
			? this.clientFactory.createConnectionCredentialIdentity(
					instance as Parameters<ArrClientFactory["createConnectionCredentialIdentity"]>[0],
				)
			: createDeploymentConnectionStateToken(instance);
	}

	private createEndpointKey(userId: string, instance: EndpointMutationTarget): string {
		const credentialIdentity =
			"credentialIdentity" in instance
				? instance.credentialIdentity
				: this.createCredentialIdentity(instance);
		return createDeploymentEndpointKey(userId, {
			service: instance.service,
			baseUrl: instance.baseUrl,
			credentialIdentity,
		});
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
		parentSyncHistoryId?: string,
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
			endpointKey: this.createEndpointKey(userId, instance),
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
			if (parentSyncHistoryId) {
				const linkedParent = await tx.trashSyncHistory.updateMany({
					where: {
						id: parentSyncHistoryId,
						userId,
						instanceId: instance.id,
						status: "RUNNING",
						backupId: null,
					},
					data: { backupId: backupRecord.id },
				});
				if (linkedParent.count !== 1) {
					throw new ConflictError(
						"The parent sync history changed before its deployment ledger could be linked.",
					);
				}
			}

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
		const resolvedResourceIds = new Map<string, number>();
		const throwWithPartialDeployment = (error: ConflictError): never => {
			Object.assign(error, {
				partialDeployment: {
					created,
					updated,
					skipped,
					details,
					errors: [...errors],
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
					if (existingCF.id !== undefined) {
						resolvedResourceIds.set(templateCF.trashId, existingCF.id);
					}
					skipped++;
					continue;
				}

				if (existingCF?.id) {
					resolvedResourceIds.set(templateCF.trashId, existingCF.id);
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
					assertIntendedWritableState(
						postWriteFormat,
						updatedCF as Record<string, unknown>,
						`Custom Format "${templateCF.name}"`,
					);
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
					mutationState.postStateToken = createUpstreamResourceStateToken(createdFormat);
					await persistMutationState(mutationState, false);
					const postWriteFormat = await client.customFormat.getById(createdFormat.id);
					assertIntendedWritableState(
						postWriteFormat,
						newCF as Record<string, unknown>,
						`Custom Format "${templateCF.name}"`,
					);
					mutationState.status = "applied";
					mutationState.postStateToken = createUpstreamResourceStateToken(postWriteFormat);
					await persistMutationState(mutationState, false);
					resolvedResourceIds.set(templateCF.trashId, createdFormat.id);
					created++;
					details.created.push(templateCF.name);
				}
			} catch (error) {
				if (upstreamMutationStarted) {
					log.error(
						{ err: error, cfName: templateCF.name },
						"Custom Format mutation could not be verified",
					);
					const uncertainError = new ConflictError(
						`Custom Format "${templateCF.name}" may have changed, but its post-write state could not be verified. Resolve or roll back the interrupted deployment before retrying.`,
					);
					Object.assign(uncertainError, { deploymentResultUncertain: true });
					throwWithPartialDeployment(uncertainError);
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

		return { created, updated, skipped, details, errors, resolvedResourceIds };
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
		resolvedCustomFormatIds: ReadonlyMap<string, number> = new Map(),
	): Promise<SyncQualityProfileResult> {
		const errors: string[] = [];
		const orphanedCFs: string[] = [];
		let mutation: QualityProfileMutation | undefined;
		let upstreamMutationStarted = false;
		let orphanedOverrideCleanup: SyncQualityProfileResult["orphanedOverrideCleanup"];
		let mappingFinalization: SyncQualityProfileResult["mappingFinalization"];
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
				targetProfile = await createQualityProfileFromSchema(
					client,
					templateConfig,
					templateCFs,
					profileName,
					effectiveQualityConfig,
					async () => {
						await persistProfileState({
							beforeProfile: null,
							status: "pending",
							action: "created",
							profileId: null,
							profileName,
							postStateToken: null,
							intendedPostStateToken: null,
						});
						upstreamMutationStarted = true;
					},
				);
				if (targetProfile?.id === undefined) {
					throw new Error("ARR created the quality profile without returning its ID");
				}
				const createdProfileStateToken = createQualityProfileStateToken(targetProfile);
				mutation = {
					action: "created",
					profileId: targetProfile.id,
					profileName: targetProfile.name ?? profileName,
					postStateToken: createdProfileStateToken,
				};
				await persistProfileState({
					beforeProfile: null,
					status: "pending",
					action: "created",
					profileId: targetProfile.id,
					profileName: targetProfile.name ?? profileName,
					postStateToken: createdProfileStateToken,
					intendedPostStateToken: null,
				});
			}

			if (targetProfile) {
				const formatItems: Array<{ format: number; score: number }> = [];
				const scoreSet = templateConfig.qualityProfile?.trash_score_set;

				const existingScoreMap = new Map<number, number>();
				for (const item of targetProfile.formatItems || []) {
					if (item.format !== undefined && item.score !== undefined) {
						existingScoreMap.set(item.format, item.score);
					}
				}

				for (const templateCF of templateCFs) {
					const customFormatId = resolvedCustomFormatIds.get(templateCF.trashId);
					if (customFormatId !== undefined) {
						const conflictResolution = conflictResolutions?.[templateCF.trashId];
						if (conflictResolution === "keep_existing") {
							const existingScore = existingScoreMap.get(customFormatId);
							if (existingScore !== undefined) {
								formatItems.push({ format: customFormatId, score: existingScore });
								continue;
							}
						}

						const instanceOverrideScore = instanceOverrideScores.get(customFormatId);
						const { score: templateScore } = calculateScoreAndSource(
							templateCF,
							scoreSet,
							instanceOverrideScore,
						);

						const existingScore = existingScoreMap.get(customFormatId);
						const previousManagedFormat = previousManagedFormats.find(
							(previous) =>
								previous.trashId === templateCF.trashId &&
								previous.resourceId === customFormatId &&
								previous.profileId === targetProfile.id,
						);
						const manuallyDriftedAfterDeployment =
							previousManagedFormat !== undefined &&
							existingScore !== previousManagedFormat.appliedScore;
						if (
							existingScore !== undefined &&
							existingScore !== templateScore &&
							!instanceOverrideScores.has(customFormatId) &&
							templateCF.scoreOverride === undefined &&
							conflictResolution !== "use_template" &&
							(previousManagedFormat === undefined || manuallyDriftedAfterDeployment)
						) {
							// Preserve genuine manual Radarr/Sonarr drift, but do not mistake
							// the score applied by the previous deployment for user intent.
							formatItems.push({ format: customFormatId, score: existingScore });
						} else {
							formatItems.push({ format: customFormatId, score: templateScore });
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
					createUpstreamResourceStateToken(getSortedOverrideScoreEntries(latestOverrideScores)) !==
						createUpstreamResourceStateToken(getSortedOverrideScoreEntries(instanceOverrideScores))
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
					postStateToken: createdProfile ? createQualityProfileStateToken(targetProfile) : null,
					intendedPostStateToken: createQualityProfileStateToken(updatedProfile),
				});
				upstreamMutationStarted = true;
				// biome-ignore lint/suspicious/noExplicitAny: Sonarr/Radarr profile types differ but are runtime-compatible
				await client.qualityProfile.update(targetProfile.id, updatedProfile as any);
				const postWriteProfile = (await client.qualityProfile.getById(
					targetProfile.id,
				)) as SdkQualityProfile;
				assertIntendedWritableState(
					postWriteProfile,
					updatedProfile as Record<string, unknown>,
					`Quality profile "${targetProfile.name ?? profileName}"`,
				);
				mutation = {
					action: createdProfile ? "created" : "updated",
					profileId: targetProfile.id,
					profileName: targetProfile.name ?? profileName,
					postStateToken: createQualityProfileStateToken(postWriteProfile),
				};
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
					orphanedOverrideCleanup = {
						userId,
						qualityProfileId: targetProfile.id,
						customFormatIds: orphanedManagedFormats.map((format) => format.resourceId),
						connectionReadBindings,
					};
				}

				// Mapping replacement is committed only with successful history
				// finalization. Until then, the previous mapping remains authoritative.
				mappingFinalization = {
					userId,
					templateId,
					instanceId,
					equivalentInstanceIds,
					connectionBindings,
					connectionReadBindings,
					savedScoreOverrides: getSortedOverrideScoreEntries(instanceOverrideScores),
					qualityProfileId: targetProfile.id,
					qualityProfileName: targetProfile.name ?? profileName,
					connectionGeneration: connectionBinding.connectionGeneration,
					connectionStateToken: connectionBinding.connectionStateToken,
					syncStrategy,
				};
			}
		} catch (error) {
			let resolvedError = error;
			if (upstreamMutationStarted && !isDeploymentResultUncertain(error)) {
				const uncertainError =
					error instanceof ConflictError
						? error
						: new ConflictError(
								`Quality profile "${profileName}" may have changed, but its post-write state could not be verified. Resolve or roll back the interrupted deployment before retrying.`,
							);
				Object.assign(uncertainError, { deploymentResultUncertain: true });
				resolvedError = uncertainError;
			}
			if (resolvedError instanceof ConflictError) {
				if (mutation) {
					const partialDeployment = {
						created: 0,
						updated: 0,
						skipped: 0,
						details: { created: [], updated: [], failed: [], orphaned: [] },
						qualityProfile: mutation,
					};
					Object.assign(resolvedError, {
						partialDeployment,
						details: {
							partialDeployment: {
								...partialDeployment,
								qualityProfile: toPublicQualityProfileMutation(mutation),
							},
						},
					});
				}
				throw resolvedError;
			}
			log.error({ err: resolvedError }, "Failed to update quality profile");
			errors.push(
				`Failed to update quality profile: ${getErrorMessage(resolvedError, "Unknown error")}`,
			);
		}

		return { errors, orphanedCFs, mutation, orphanedOverrideCleanup, mappingFinalization };
	}

	private async loadEquivalentInstanceOverrideScores(
		userId: string,
		connectionBindings: DeploymentConnectionReadBinding[],
		qualityProfileId: number,
	): Promise<Map<number, number>> {
		const instanceIds = [...new Set(connectionBindings.map((binding) => binding.instanceId))];
		const overrides = await this.prisma.instanceQualityProfileOverride.findMany({
			where: {
				userId,
				status: "APPLIED",
				qualityProfileId,
				instanceId: { in: instanceIds },
			},
		});
		const scores = new Map<number, number>();
		for (const override of overrides) {
			if (!isCurrentDeploymentConnectionMapping(override, connectionBindings)) {
				throw new ConflictError(
					"This ARR endpoint has a saved score override bound to an older connection. Reconcile the stale override before deploying.",
				);
			}
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

	private async finalizeSavedScoreOverrideState(
		database: PrismaClient,
		finalization: NonNullable<SyncQualityProfileResult["mappingFinalization"]>,
	): Promise<void> {
		const liveOverrides = await database.instanceQualityProfileOverride.findMany({
			where: {
				userId: finalization.userId,
				instanceId: { in: finalization.equivalentInstanceIds },
				qualityProfileId: finalization.qualityProfileId,
			},
		});
		const liveOverrideScores = new Map<number, number>();
		for (const override of liveOverrides) {
			if (
				override.status !== "APPLIED" ||
				!isCurrentDeploymentConnectionMapping(override, finalization.connectionReadBindings)
			) {
				throw new ConflictError(
					"Saved score override authority changed before deployment state could be finalized.",
				);
			}
			const existingScore = liveOverrideScores.get(override.customFormatId);
			if (existingScore !== undefined && existingScore !== override.score) {
				throw new ConflictError(
					"Saved score overrides changed before deployment state could be finalized.",
				);
			}
			liveOverrideScores.set(override.customFormatId, override.score);
		}
		if (
			createUpstreamResourceStateToken(getSortedOverrideScoreEntries(liveOverrideScores)) !==
			createUpstreamResourceStateToken(finalization.savedScoreOverrides)
		) {
			throw new ConflictError(
				"Saved score overrides changed before deployment state could be finalized.",
			);
		}

		await database.instanceQualityProfileOverride.deleteMany({
			where: {
				userId: finalization.userId,
				instanceId: { in: finalization.equivalentInstanceIds },
				qualityProfileId: finalization.qualityProfileId,
			},
		});
		for (const [customFormatId, score] of finalization.savedScoreOverrides) {
			await database.instanceQualityProfileOverride.create({
				data: {
					userId: finalization.userId,
					instanceId: finalization.instanceId,
					qualityProfileId: finalization.qualityProfileId,
					customFormatId,
					score,
					status: "APPLIED",
					connectionGeneration: finalization.connectionGeneration,
					connectionStateToken: finalization.connectionStateToken,
				},
			});
		}
	}

	// ============================================================================
	// Public Methods
	// ============================================================================

	async runWithEndpointMutation<T>(
		userId: string,
		instance: EndpointMutationTarget,
		operation: string,
		action: (endpointKey: string) => Promise<T>,
	): Promise<T> {
		const endpointKey = this.createEndpointKey(userId, instance);
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
		parentSyncHistoryId?: string,
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
			parentSyncHistoryId,
		);
	}

	async deploySingleInstanceFromAutomation(
		templateId: string,
		instanceId: string,
		userId: string,
		conflictResolutions?: Record<string, "use_template" | "keep_existing">,
		parentSyncHistoryId?: string,
	): Promise<DeploymentResult> {
		return this.deploySingleInstanceWithCapability(
			templateId,
			instanceId,
			userId,
			"auto",
			conflictResolutions,
			undefined,
			parentSyncHistoryId,
		);
	}

	private async deploySingleInstanceWithCapability(
		templateId: string,
		instanceId: string,
		userId: string,
		syncStrategy: "auto" | "manual" | "notify" | undefined,
		conflictResolutions: Record<string, "use_template" | "keep_existing"> | undefined,
		executionToken: string | undefined,
		parentSyncHistoryId?: string,
	): Promise<DeploymentResult> {
		const lockInstance = await this.prisma.serviceInstance.findFirst({
			where: { id: instanceId, userId },
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
					parentSyncHistoryId,
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
		let upstreamMutationStarted = false;
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

			upstreamMutationStarted = true;
			const putResponse = await this.clientFactory.rawRequest(instance, "/api/v3/config/naming", {
				method: "PUT",
				body: namingState.mergedConfig,
			});
			if (!putResponse.ok) {
				throw new Error(`Naming config PUT returned HTTP ${putResponse.status}`);
			}
			const postWriteResponse = await this.clientFactory.rawRequest(
				instance,
				"/api/v3/config/naming",
			);
			if (!postWriteResponse.ok) {
				throw new Error(
					`Naming config was applied, but its post-write state could not be verified: HTTP ${postWriteResponse.status}`,
				);
			}
			const postWriteConfig = (await postWriteResponse.json()) as Record<string, unknown>;
			assertIntendedWritableState(
				postWriteConfig,
				namingState.mergedConfig,
				"Naming configuration",
			);
			fieldsApplied = namingState.changedFields.length;

			log.info(
				{ instanceId: instance.id, fieldsApplied: namingState.changedFields.length },
				"Naming presets deployed via template",
			);
			return {
				fieldsApplied,
				postStateToken: createUpstreamResourceStateToken(postWriteConfig),
			};
		} catch (error) {
			if (upstreamMutationStarted) {
				const uncertainError =
					error instanceof ConflictError
						? error
						: new ConflictError(
								"Naming configuration may have changed, but its post-write state could not be verified. Resolve or roll back the interrupted deployment before retrying.",
							);
				Object.assign(uncertainError, { deploymentResultUncertain: true });
				throw uncertainError;
			}
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
		parentSyncHistoryId?: string,
	): Promise<DeploymentResult> {
		const startTime = new Date();
		let historyId: string | null = null;
		let deploymentHistoryId: string | null = null;
		let partialCFResult: DeployCustomFormatsResult | null = null;
		const warnings: string[] = [];
		let appliedProfileMutation: QualityProfileMutation | undefined;
		let instanceLabel = "Unknown";
		let namingFieldsApplied = 0;
		let deploymentPhase: "before_cf" | "custom_formats" | "quality_profile" | "post_profile" =
			"before_cf";

		const metrics = getSyncMetrics();
		const completeMetrics = metrics.startOperation("deployment");

		try {
			const { template, instance, templateConfig, templateCFs, effectiveQualityConfig } =
				await this.validateAndPrepareDeployment(templateId, instanceId, userId);
			instanceLabel = instance.label;
			if (expectedEndpointKey && this.createEndpointKey(userId, instance) !== expectedEndpointKey) {
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
			const equivalentAliases = serviceAliases.filter((alias) =>
				equivalentInstanceIds.includes(alias.id),
			);
			const connectionBindings = equivalentAliases.map((alias) => ({
				instanceId: alias.id,
				connectionGeneration: alias.connectionGeneration,
				connectionStateToken: createDeploymentConnectionStateToken(alias),
			}));
			const connectionReadBindings = equivalentAliases.flatMap((alias) =>
				createDeploymentConnectionBindingCandidates(alias, this.createCredentialIdentity(alias)),
			);
			await assertNoPendingDeploymentOperation(
				this.prisma,
				userId,
				equivalentInstanceIds,
				undefined,
				parentSyncHistoryId,
			);
			const [existingCFs, fetchedProfiles, qualityProfileMappings] = await Promise.all([
				client.customFormat.getAll(),
				client.qualityProfile.getAll(),
				this.prisma.templateQualityProfileMapping.findMany({
					where: { instanceId: { in: equivalentInstanceIds } },
					orderBy: { updatedAt: "desc" },
				}),
			]);
			const customFormatIndex = buildCustomFormatIdentityIndex(existingCFs);
			if (customFormatIndex.collisions.length > 0) {
				throw new ConflictError(
					`ARR returned ambiguous Custom Format identities (${customFormatIndex.collisions.join(", ")}). Resolve the duplicates before deploying.`,
				);
			}
			if (
				qualityProfileMappings.some(
					(mapping) =>
						!isLegacyDeploymentConnectionMapping(mapping) &&
						!isCurrentDeploymentConnectionMapping(mapping, connectionBindings),
				)
			) {
				throw new ConflictError(
					"This ARR endpoint has a deployment mapping bound to an older connection. Unlink or reconcile the stale mapping before deploying.",
				);
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
			if (!executionToken) {
				const eligibleAutomationMappings = templateMappings.filter(
					(mapping) =>
						mapping.syncStrategy === "auto" &&
						!isLegacyDeploymentConnectionMapping(mapping) &&
						isCurrentDeploymentConnectionMapping(mapping, connectionBindings),
				);
				if (eligibleAutomationMappings.length === 0) {
					throw new ConflictError(
						"Automatic deployment is no longer authorized for this ARR endpoint. Review the mapping, sync strategy, and connection before retrying.",
					);
				}
				if (
					templateMappings.some(
						(mapping) =>
							mapping.syncStrategy !== "auto" ||
							isLegacyDeploymentConnectionMapping(mapping) ||
							!isCurrentDeploymentConnectionMapping(mapping, connectionBindings),
					)
				) {
					throw new ConflictError(
						"Automatic deployment is blocked by a changed, stale, or legacy alias mapping for this ARR endpoint. Review and consolidate the deployment mappings first.",
					);
				}
			}
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
			}

			const { backup, historyId: syncHistoryId } = await this.createBackupAndHistory(
				instance,
				userId,
				existingCFs,
				templateId,
				preDeploymentQP,
				namingState,
				parentSyncHistoryId,
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
			const existingCFMap = customFormatIndex.byTrashId;
			const existingCFByName = customFormatIndex.byName;

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

			const retainedSyncStrategy = ["auto", "manual", "notify"].includes(
				qualityProfileMapping?.syncStrategy ?? "",
			)
				? (qualityProfileMapping?.syncStrategy as "auto" | "manual" | "notify")
				: undefined;
			const profileResult = await this.syncQualityProfile(
				client,
				templateConfig,
				templateCFs,
				templateId,
				instanceId,
				userId,
				syncStrategy ?? retainedSyncStrategy ?? "notify",
				conflictResolutions,
				profileName,
				authorizedTarget.profile,
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
				overrideReadBindings,
				previousManagedFormats,
				cfResult.resolvedResourceIds ?? new Map(),
			);
			appliedProfileMutation = profileResult.mutation;
			let deferredManagedMappingUpdate:
				| {
						managedProfileId: number;
						managedCustomFormats: ManagedCustomFormatIdentity[];
				  }
				| undefined;
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
					cfResult.resolvedResourceIds,
				);
				backup.data.managedCustomFormats = managedCustomFormats;
				backup.data.managedCustomFormatsCaptured = true;
				if (backup.data.qualityProfileDeployment.status === "pending") {
					backup.data.qualityProfileDeployment.status = "applied";
				}
				const capturedBackupData = JSON.stringify(backup.data);
				const backupUpdate = this.prisma.trashBackup.update({
					where: { id: backup.id },
					data: {
						backupData: capturedBackupData,
						expiresAt: shouldRetainDeploymentBackup(capturedBackupData)
							? null
							: backup.retentionExpiresAt,
					},
				});
				await backupUpdate;
				deferredManagedMappingUpdate = { managedProfileId, managedCustomFormats };
			}
			deploymentPhase = "post_profile";

			// Deploy naming presets if the template includes them
			let namingWarning: string | undefined;
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
						const uncertainError = new ConflictError(
							"Naming presets were applied, but rollback metadata could not be finalized. Resolve or roll back the interrupted deployment before retrying.",
						);
						Object.assign(uncertainError, { deploymentResultUncertain: true });
						throw uncertainError;
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

			const orphanedOverrideCleanup =
				allErrors.length === 0 ? profileResult.orphanedOverrideCleanup : undefined;
			const mappingFinalization =
				allErrors.length === 0 ? profileResult.mappingFinalization : undefined;
			const managedMappingUpdate =
				allErrors.length === 0 ? deferredManagedMappingUpdate : undefined;
			const requiresManagedFinalization = Boolean(
				mappingFinalization || orphanedOverrideCleanup || managedMappingUpdate,
			);
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
					mappingFinalization || orphanedOverrideCleanup || managedMappingUpdate
						? async (database) => {
								if (mappingFinalization) {
									const liveInstances = await database.serviceInstance.findMany({
										where: {
											id: { in: mappingFinalization.equivalentInstanceIds },
											userId: mappingFinalization.userId,
										},
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
									const expectedBindingByInstanceId = new Map(
										mappingFinalization.connectionBindings.map((binding) => [
											binding.instanceId,
											binding,
										]),
									);
									if (
										liveInstances.length !== expectedBindingByInstanceId.size ||
										liveInstances.some((liveInstance) => {
											const expected = expectedBindingByInstanceId.get(liveInstance.id);
											return (
												!expected ||
												expected.connectionGeneration !== liveInstance.connectionGeneration ||
												expected.connectionStateToken !==
													createDeploymentConnectionStateToken(liveInstance)
											);
										})
									) {
										throw new ConflictError(
											"The ARR service connection changed before deployment state could be finalized.",
										);
									}

									await this.finalizeSavedScoreOverrideState(database, mappingFinalization);

									await database.templateQualityProfileMapping.deleteMany({
										where: {
											templateId: mappingFinalization.templateId,
											instanceId: { in: mappingFinalization.equivalentInstanceIds },
										},
									});
									await database.templateQualityProfileMapping.upsert({
										where: {
											instanceId_qualityProfileId: {
												instanceId: mappingFinalization.instanceId,
												qualityProfileId: mappingFinalization.qualityProfileId,
											},
										},
										create: {
											templateId: mappingFinalization.templateId,
											instanceId: mappingFinalization.instanceId,
											qualityProfileId: mappingFinalization.qualityProfileId,
											qualityProfileName: mappingFinalization.qualityProfileName,
											connectionGeneration: mappingFinalization.connectionGeneration,
											connectionStateToken: mappingFinalization.connectionStateToken,
											syncStrategy: mappingFinalization.syncStrategy || "notify",
											lastSyncedAt: new Date(),
										},
										update: {
											templateId: mappingFinalization.templateId,
											qualityProfileName: mappingFinalization.qualityProfileName,
											connectionGeneration: mappingFinalization.connectionGeneration,
											connectionStateToken: mappingFinalization.connectionStateToken,
											...(mappingFinalization.syncStrategy && {
												syncStrategy: mappingFinalization.syncStrategy,
											}),
											lastSyncedAt: new Date(),
											updatedAt: new Date(),
										},
									});
								}
								if (managedMappingUpdate) {
									await database.templateQualityProfileMapping.updateMany({
										where: {
											templateId,
											instanceId,
											qualityProfileId: managedMappingUpdate.managedProfileId,
										},
										data: {
											managedCustomFormats: JSON.stringify(
												managedMappingUpdate.managedCustomFormats,
											),
											managedCustomFormatsCaptured: true,
										},
									});
								}
								if (!orphanedOverrideCleanup) return;
								await database.instanceQualityProfileOverride.deleteMany({
									where: {
										userId: orphanedOverrideCleanup.userId,
										qualityProfileId: orphanedOverrideCleanup.qualityProfileId,
										customFormatId: { in: orphanedOverrideCleanup.customFormatIds },
										OR: orphanedOverrideCleanup.connectionReadBindings,
									},
								});
							}
						: undefined,
				);
			} catch (historyError) {
				log.error(
					{ err: historyError, templateId, instanceId },
					"Deployment succeeded but history finalization failed",
				);
				if (requiresManagedFinalization) {
					allErrors.push(
						"ARR changes were applied, but managed deployment state could not be finalized. The prior mapping and saved score overrides were preserved; retry this deployment or roll it back before making further changes.",
					);
				} else {
					warnings.push(
						"Deployment completed, but its history record could not be finalized. Check the server logs.",
					);
				}
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
				status: allErrors.length === 0 ? "SUCCESS" : "FAILED",
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
			const partialErrors = partialCFResult?.errors ?? thrownPartialResult?.errors ?? [];
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
						partialErrors,
						namingFieldsApplied,
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

			if (
				error instanceof ConflictError &&
				!isDeploymentResultUncertain(error) &&
				(!partialDetails || !partialCounts)
			) {
				throw error;
			}

			return {
				instanceId,
				instanceLabel,
				success: false,
				status: isDeploymentResultUncertain(error) ? "UNCERTAIN" : "FAILED",
				customFormatsCreated: partialCounts?.created ?? 0,
				customFormatsUpdated: partialCounts?.updated ?? 0,
				customFormatsSkipped: partialCounts?.skipped ?? 0,
				errors: [...partialErrors, errorMessage],
				...(partialProfile && {
					qualityProfileApplied: toPublicQualityProfileMutation(partialProfile),
				}),
				...(namingFieldsApplied > 0 && { namingFieldsApplied }),
				...(partialDetails && { details: partialDetails }),
			};
		}
	}

	async deployBulkInstances(
		templateId: string,
		instanceIds: string[],
		userId: string,
		syncStrategy?: "auto" | "manual" | "notify",
		instanceSyncStrategies?: Record<string, "auto" | "manual" | "notify">,
		executionTokens: Record<string, string> = {},
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
		return withCleanupTopologyMutationLease({ prisma: this.prisma, log }, userId, async () => {
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
			if (selectedInstances.length !== instanceIds.length) {
				throw new AppValidationError(
					"One or more selected service instances no longer exist or are not authorized.",
				);
			}
			const selectedById = new Map(selectedInstances.map((instance) => [instance.id, instance]));
			const endpointOwners = new Map<string, string>();
			for (const instanceId of instanceIds) {
				const instance = selectedById.get(instanceId)!;
				const endpointKey = createDeploymentEndpointKey(userId, instance);
				const existingInstanceId = endpointOwners.get(endpointKey);
				if (existingInstanceId && existingInstanceId !== instance.id) {
					throw new AppValidationError(
						"Bulk deployment includes multiple service records for the same ARR endpoint. Select only one record for each endpoint.",
					);
				}
				endpointOwners.set(endpointKey, instance.id);
			}

			const results: DeploymentResult[] = [];
			for (let index = 0; index < instanceIds.length; index++) {
				const instanceId = instanceIds[index]!;
				const instance = selectedById.get(instanceId)!;
				try {
					const strategy = instanceSyncStrategies?.[instanceId] ?? syncStrategy;
					results.push(
						await this.runWithEndpointMutation(userId, instance, "Deployment", (endpointKey) =>
							this.executeSingleDeployment(
								templateId,
								instanceId,
								userId,
								strategy,
								undefined,
								executionTokens[instanceId],
								endpointKey,
							),
						),
					);
				} catch (error) {
					const partialDeployment = getPartialDeploymentResult(error);
					results.push({
						instanceId,
						instanceLabel: `Instance ${index + 1}`,
						success: false,
						status: isDeploymentResultUncertain(error) ? "UNCERTAIN" : "FAILED",
						customFormatsCreated: partialDeployment?.created ?? 0,
						customFormatsUpdated: partialDeployment?.updated ?? 0,
						customFormatsSkipped: partialDeployment?.skipped ?? 0,
						errors: [
							...(partialDeployment?.errors ?? []),
							getErrorMessage(error, "Deployment failed"),
						],
						qualityProfileApplied: toPublicQualityProfileMutation(
							partialDeployment?.qualityProfile,
						),
						details: partialDeployment?.details,
					});
				}
			}

			return {
				templateId,
					templateName: template.name,
					totalInstances: instanceIds.length,
					successfulInstances: results.filter((result) => result.status === "SUCCESS").length,
					failedInstances: results.filter((result) => result.status === "FAILED").length,
					uncertainInstances: results.filter((result) => result.status === "UNCERTAIN").length,
					results,
				};
			});
	}
}
