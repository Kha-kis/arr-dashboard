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

import type { PrismaClient, ServiceType } from "../../lib/prisma.js";
import type { SonarrClient, RadarrClient } from "arr-sdk";
import type { ArrClientFactory } from "../arr/client-factory.js";
import type { CustomQualityConfig } from "@arr/shared";
import { InstanceNotFoundError, TemplateNotFoundError, AppValidationError } from "../errors.js";
import { getSyncMetrics } from "./sync-metrics.js";
import { calculateScoreAndSource } from "./template-score-utils.js";
import {
	normalizeQualityName,
	extractQualitiesFromSchema,
	type TemplateCF,
} from "./quality-profile-helpers.js";
import { createQualityProfileFromSchema } from "./profile-creation-strategies.js";
import {
	finalizeDeploymentHistory,
	finalizeDeploymentHistoryWithFailure,
} from "./deployment-history-manager.js";
import { transformFieldsToArray, extractTrashId } from "./cf-field-utils.js";
import { loggers } from "../logger.js";
import { getErrorMessage } from "../utils/error-message.js";

const log = loggers.deployment;

// SDK CustomFormat type for internal use
type SdkCustomFormat = Awaited<ReturnType<SonarrClient["customFormat"]["getAll"]>>[number];

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

interface ValidatedDeploymentData {
	template: {
		id: string;
		name: string;
		serviceType: string;
		configData: string;
		instanceOverrides: string | null;
	};
	instance: {
		id: string;
		label: string;
		service: ServiceType;
		baseUrl: string;
		encryptedApiKey: string;
		encryptionIv: string;
	};
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR API config structure
	templateConfig: Record<string, any>;
	templateCFs: TemplateCF[];
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR API override structure
	overridesForInstance: Record<string, any>;
	effectiveQualityConfig: CustomQualityConfig | undefined;
	usingQualityOverride: boolean;
}

interface BackupAndHistoryResult {
	backup: { id: string };
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
}

interface PreviousDeploymentCF {
	trashId: string;
	name: string;
}

// ============================================================================
// Deployment Executor Service Class
// ============================================================================

export class DeploymentExecutorService {
	private prisma: PrismaClient;
	private clientFactory: ArrClientFactory;

	constructor(prisma: PrismaClient, clientFactory: ArrClientFactory) {
		this.prisma = prisma;
		this.clientFactory = clientFactory;
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
			},
			instance: {
				id: instance.id,
				label: instance.label,
				service: instance.service,
				baseUrl: instance.baseUrl,
				encryptedApiKey: instance.encryptedApiKey,
				encryptionIv: instance.encryptionIv,
			},
			templateConfig,
			templateCFs,
			overridesForInstance,
			effectiveQualityConfig,
			usingQualityOverride,
		};
	}

	private async createBackupAndHistory(
		instance: { id: string },
		userId: string,
		preDeploymentCFs: SdkCustomFormat[],
		templateId: string,
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

		const { backup, history } = await this.prisma.$transaction(async (tx) => {
			const backupRecord = await tx.trashBackup.create({
				data: {
					instanceId: instance.id,
					userId,
					backupData: JSON.stringify(preDeploymentCFs),
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

		return { backup: { id: backup.id }, historyId: history.id };
	}

	private async deployCustomFormats(
		client: SonarrClient | RadarrClient,
		templateCFs: TemplateCF[],
		existingCFMap: Map<string, SdkCustomFormat>,
		existingCFByName: Map<string, SdkCustomFormat>,
		conflictResolutions: Record<string, "use_template" | "keep_existing"> | undefined,
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

		for (const templateCF of templateCFs) {
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
					// biome-ignore lint/suspicious/noExplicitAny: Dynamic TRaSH spec format
					const specifications = (templateCF.originalConfig?.specifications || []).map(
						(spec: any) => ({
							...spec,
							fields: transformFieldsToArray(spec.fields),
						}),
					);

					const updatedCF = {
						...existingCF,
						name: templateCF.name,
						specifications,
					};

					await client.customFormat.update(
						existingCF.id,
						updatedCF as unknown as Parameters<typeof client.customFormat.update>[1],
					);
					updated++;
					details.updated.push(templateCF.name);
				} else {
					// biome-ignore lint/suspicious/noExplicitAny: Dynamic TRaSH spec format
					const specifications = (templateCF.originalConfig?.specifications || []).map(
						(spec: any) => ({
							...spec,
							fields: transformFieldsToArray(spec.fields),
						}),
					);

					const newCF = {
						name: templateCF.name,
						includeCustomFormatWhenRenaming: false,
						specifications,
					};

					await client.customFormat.create(
						newCF as unknown as Parameters<typeof client.customFormat.create>[0],
					);
					created++;
					details.created.push(templateCF.name);
				}
			} catch (error) {
				log.error(
					{ err: error, cfName: templateCF.name },
					"Failed to deploy custom format",
				);
				errors.push(
					`Failed to deploy "${templateCF.name}": ${getErrorMessage(error, "Unknown error")}`,
				);
				details.failed.push(templateCF.name);
				skipped++;
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
		_userId: string,
		syncStrategy: "auto" | "manual" | "notify" | undefined,
		conflictResolutions: Record<string, "use_template" | "keep_existing"> | undefined,
		profileName: string,
		previouslyDeployedCFs: PreviousDeploymentCF[],
		effectiveQualityConfig?: CustomQualityConfig,
	): Promise<SyncQualityProfileResult> {
		const errors: string[] = [];
		const orphanedCFs: string[] = [];

		try {
			const qualityProfiles = await client.qualityProfile.getAll();

			let targetProfile = qualityProfiles.find((p) => p.name === profileName);

			if (!targetProfile) {
				targetProfile = await createQualityProfileFromSchema(
					client,
					templateConfig,
					templateCFs,
					profileName,
					effectiveQualityConfig,
				);
			}

			if (targetProfile) {
				const allCFs = await client.customFormat.getAll();
				const cfMap = new Map(allCFs.map((cf) => [cf.name, cf]));

				const instanceOverrides = await this.prisma.instanceQualityProfileOverride.findMany({
					where: { instanceId, qualityProfileId: targetProfile.id },
				});
				const overrideMap = new Map(
					instanceOverrides.map((override) => [override.customFormatId, override.score]),
				);

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
						if (conflictResolutions?.[templateCF.trashId] === "keep_existing") {
							const existingScore = existingScoreMap.get(cf.id);
							if (existingScore !== undefined) {
								formatItems.push({ format: cf.id, score: existingScore });
								continue;
							}
						}

						const instanceOverrideScore = overrideMap.get(cf.id);
						const { score: templateScore } = calculateScoreAndSource(
							templateCF,
							scoreSet,
							instanceOverrideScore,
						);

						const existingScore = existingScoreMap.get(cf.id);
						if (
							existingScore !== undefined &&
							existingScore !== templateScore &&
							!overrideMap.has(cf.id) &&
							templateCF.scoreOverride === undefined
						) {
							// Preserve manual Radarr/Sonarr tweaks only when no explicit override is set
							formatItems.push({ format: cf.id, score: existingScore });
						} else {
							formatItems.push({ format: cf.id, score: templateScore });
						}
					}
				}

				// Handle orphaned CFs
				const currentTemplateCFNames = new Set(templateCFs.map((cf) => cf.name));
				const cfByName = new Map(allCFs.map((cf) => [cf.name, cf]));
				const addedFormatIds = new Set(formatItems.map((item) => item.format));

				for (const prevCF of previouslyDeployedCFs) {
					if (!currentTemplateCFNames.has(prevCF.name)) {
						const instanceCF = cfByName.get(prevCF.name);
						if (instanceCF?.id && !addedFormatIds.has(instanceCF.id)) {
							formatItems.push({
								format: instanceCF.id,
								score: overrideMap.get(instanceCF.id) ?? 0,
							});
							addedFormatIds.add(instanceCF.id);
							orphanedCFs.push(prevCF.name);
						}
					}
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
										allowed: currentAllowedStates.get(
											normalizeQualityName(subItem.name || ""),
										) ?? subItem.allowed,
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
									allowed: currentAllowedStates.get(
										normalizeQualityName(sourceItem.name || ""),
									) ?? sourceItem.allowed,
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
									allowed: currentAllowedStates.get(
										normalizeQualityName(sourceItem.quality.name || ""),
									) ?? sourceItem.allowed,
								});
							}
						}
					}

					let remappedCutoff = clonedProfile.cutoff;
					if (sourceIdToNewId.has(clonedProfile.cutoff)) {
						remappedCutoff = sourceIdToNewId.get(clonedProfile.cutoff)!;
					} else if (qualityItems.length > 0) {
						const lastItem = qualityItems[qualityItems.length - 1];
						remappedCutoff = lastItem.id ?? lastItem.quality?.id ?? clonedProfile.cutoff;
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
					const overrideSchema = cachedSchema ?? await client.qualityProfile.getSchema();
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
								const targetQuality = qualitiesByName.get(
									normalizeQualityName(quality.name),
								);
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
							const targetQuality = qualitiesByName.get(
								normalizeQualityName(item.name),
							);
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
				// biome-ignore lint/suspicious/noExplicitAny: Sonarr/Radarr profile types differ but are runtime-compatible
				await client.qualityProfile.update(targetProfile.id, updatedProfile as any);

				await this.prisma.templateQualityProfileMapping.upsert({
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
						syncStrategy: syncStrategy || "notify",
						lastSyncedAt: new Date(),
					},
					update: {
						templateId,
						qualityProfileName: targetProfile.name ?? profileName,
						...(syncStrategy && { syncStrategy }),
						lastSyncedAt: new Date(),
						updatedAt: new Date(),
					},
				});
			}
		} catch (error) {
			log.error({ err: error }, "Failed to update quality profile");
			errors.push(
				`Failed to update quality profile: ${getErrorMessage(error, "Unknown error")}`,
			);
		}

		return { errors, orphanedCFs };
	}

	// ============================================================================
	// Public Methods
	// ============================================================================

	async deploySingleInstance(
		templateId: string,
		instanceId: string,
		userId: string,
		syncStrategy?: "auto" | "manual" | "notify",
		conflictResolutions?: Record<string, "use_template" | "keep_existing">,
	): Promise<DeploymentResult> {
		const startTime = new Date();
		let historyId: string | null = null;
		let deploymentHistoryId: string | null = null;

		const metrics = getSyncMetrics();
		const completeMetrics = metrics.startOperation("deployment");

		try {
			const { template, instance, templateConfig, templateCFs, effectiveQualityConfig } =
				await this.validateAndPrepareDeployment(templateId, instanceId, userId);

			const preDeploymentCFs = await this.getExistingCustomFormats(instance);

			const { backup, historyId: syncHistoryId } = await this.createBackupAndHistory(
				instance,
				userId,
				preDeploymentCFs,
				templateId,
			);
			historyId = syncHistoryId;

			const client = this.clientFactory.create(instance) as SonarrClient | RadarrClient;
			try {
				await client.system.get();
			} catch (error) {
				throw new Error(
					`Instance unreachable: ${getErrorMessage(error, "Unknown error")}`,
				);
			}

			const existingCFs = await client.customFormat.getAll();
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

			const previousDeployment = await this.prisma.templateDeploymentHistory.findFirst({
				where: {
					templateId,
					instanceId,
					status: "SUCCESS",
					templateSnapshot: { not: null },
				},
				orderBy: { deployedAt: "desc" },
				select: { templateSnapshot: true },
			});

			let previouslyDeployedCFs: PreviousDeploymentCF[] = [];
			if (previousDeployment?.templateSnapshot) {
				try {
					const prevConfig = JSON.parse(previousDeployment.templateSnapshot);
					previouslyDeployedCFs = (prevConfig.customFormats || []).map(
						(cf: { trashId: string; name: string }) => ({
							trashId: cf.trashId,
							name: cf.name,
						}),
					);
				} catch (parseError) {
					log.warn(
						{ err: parseError },
						"Failed to parse previous deployment snapshot for orphan detection",
					);
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

			const cfResult = await this.deployCustomFormats(
				client,
				templateCFs,
				existingCFMap,
				existingCFByName,
				conflictResolutions,
			);

			const profileName = template.name || "TRaSH Guides HD/UHD";
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
				previouslyDeployedCFs,
				effectiveQualityConfig,
			);

			const allErrors = [...cfResult.errors, ...profileResult.errors];

			const warnings: string[] = [];
			if (profileResult.orphanedCFs.length > 0) {
				warnings.push(
					`${profileResult.orphanedCFs.length} Custom Format(s) removed from TRaSH Guides - scores set to 0: ${profileResult.orphanedCFs.join(", ")}`,
				);
			}

			cfResult.details.orphaned = profileResult.orphanedCFs;

			await finalizeDeploymentHistory(
				this.prisma,
				historyId,
				deploymentHistoryId,
				startTime,
				cfResult.details,
				{ created: cfResult.created, updated: cfResult.updated, skipped: cfResult.skipped },
				allErrors,
			);

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
				details: cfResult.details,
			};
		} catch (error) {
			const errorMessage = getErrorMessage(error, "Unknown error");
			const metricsResult = completeMetrics();
			metricsResult.recordFailure(errorMessage);

			try {
				await finalizeDeploymentHistoryWithFailure(
					this.prisma,
					historyId,
					deploymentHistoryId,
					startTime,
					error,
				);
			} catch (historyError) {
				log.error(
					{ err: historyError, originalError: errorMessage },
					"Failed to record deployment failure in history",
				);
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
		syncStrategy?: "auto" | "manual" | "notify",
		instanceSyncStrategies?: Record<string, "auto" | "manual" | "notify">,
	): Promise<BulkDeploymentResult> {
		const template = await this.prisma.trashTemplate.findUnique({
			where: { id: templateId, userId },
		});

		if (!template) {
			throw new TemplateNotFoundError(templateId);
		}

		const deploymentPromises = instanceIds.map((instanceId) => {
			const strategy = instanceSyncStrategies?.[instanceId] ?? syncStrategy;
			return this.deploySingleInstance(templateId, instanceId, userId, strategy);
		});

		const settledResults = await Promise.allSettled(deploymentPromises);

		const results: DeploymentResult[] = settledResults.map((settled, index) => {
			if (settled.status === "fulfilled") {
				return settled.value;
			}
			const errorMessage =
				getErrorMessage(settled.reason, "Deployment failed");
			return {
				instanceId: instanceIds[index] ?? `unknown-${index}`,
				instanceLabel: `Instance ${index + 1}`,
				success: false,
				customFormatsCreated: 0,
				customFormatsUpdated: 0,
				customFormatsSkipped: 0,
				errors: [errorMessage],
			};
		});

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

	// biome-ignore lint/suspicious/noExplicitAny: Dynamic instance type
	private async getExistingCustomFormats(instance: any): Promise<SdkCustomFormat[]> {
		const client = this.clientFactory.create(instance) as SonarrClient | RadarrClient;
		return client.customFormat.getAll();
	}
}

// ============================================================================
// Factory Function
// ============================================================================

export function createDeploymentExecutorService(
	prisma: PrismaClient,
	clientFactory: ArrClientFactory,
): DeploymentExecutorService {
	return new DeploymentExecutorService(prisma, clientFactory);
}
