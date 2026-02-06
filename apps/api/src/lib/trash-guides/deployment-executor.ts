/**
 * TRaSH Guides Deployment Executor Service
 *
 * Executes deployment of Custom Formats from template to Radarr/Sonarr instances.
 * Handles both single and bulk deployments.
 */

import type { PrismaClient, ServiceType } from "../../lib/prisma.js";
import type { SonarrClient, RadarrClient } from "arr-sdk";
import type { ArrClientFactory } from "../arr/client-factory.js";
import type { CustomQualityConfig, } from "@arr/shared";
import { getSyncMetrics } from "./sync-metrics.js";

// SDK CustomFormat type for internal use
type SdkCustomFormat = Awaited<ReturnType<SonarrClient["customFormat"]["getAll"]>>[number];
type SdkQualityProfile = Awaited<ReturnType<SonarrClient["qualityProfile"]["getAll"]>>[number];

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
		created: string[]; // CF names
		updated: string[]; // CF names
		failed: string[]; // CF names
		orphaned: string[]; // CF names no longer in template (scores set to 0)
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

// ============================================================================
// Score Calculation Helper
// ============================================================================

interface ScoreCalculationResult {
	score: number;
	scoreSource: string;
}

interface TemplateCFForScoring {
	scoreOverride?: number | null;
	originalConfig?: {
		trash_scores?: Record<string, number>;
	};
}

// Types for extracted helper methods
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
	/**
	 * Effective quality config for this instance.
	 * Uses instance override if set, otherwise falls back to template default.
	 */
	effectiveQualityConfig: CustomQualityConfig | undefined;
	/** Whether using an instance override for quality config */
	usingQualityOverride: boolean;
}

interface TemplateCF {
	trashId: string;
	name: string;
	scoreOverride: number;
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR custom format config
	originalConfig: any;
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
	orphanedCFs: string[]; // CF names that were set to score 0
}

interface PreviousDeploymentCF {
	trashId: string;
	name: string;
}

// ============================================================================
// Quality Items Format Reversal (TRaSH Guides PR #2590)
// ============================================================================

/**
 * Feature flag for TRaSH Guides quality format change.
 *
 * TRaSH Guides PR #2590 changes the quality ordering in their JSON files:
 * - OLD format (current): Highest quality at index 0 (Remux → Unknown) - matches Sonarr/Radarr API
 * - NEW format (PR #2590): Lowest quality at index 0 (Unknown → Remux) - human-readable
 *
 * Sonarr/Radarr API expects highest quality first, so when PR #2590 is merged,
 * we need to reverse the quality items before sending to the API.
 *
 * HOW TO UPDATE WHEN PR #2590 IS MERGED:
 * 1. Change this flag to `true`
 * 2. Run tests to verify quality ordering is correct
 * 3. Test deployment with a profile to verify order matches expected
 *
 * See: https://github.com/TRaSH-Guides/Guides/pull/2590
 * See: https://github.com/Kha-kis/arr-dashboard/issues/85
 */
const TRASH_GUIDES_NEW_QUALITY_FORMAT_MERGED = false;

/**
 * Reverses quality items if TRaSH Guides uses NEW format (PR #2590).
 * Sonarr/Radarr API expects highest quality first (index 0).
 *
 * When TRASH_GUIDES_NEW_QUALITY_FORMAT_MERGED is false (current state):
 * - TRaSH JSON has highest quality first (matches API) - no reversal needed
 *
 * When TRASH_GUIDES_NEW_QUALITY_FORMAT_MERGED is true (after PR #2590 merges):
 * - TRaSH JSON has lowest quality first - reversal needed for API compatibility
 *
 * @param items Quality items from TRaSH template
 * @returns Items in correct order for API (highest quality first)
 */
function reverseQualityItemsIfNeeded<T>(items: T[]): T[] {
	if (!items || items.length === 0) {
		return items;
	}

	if (TRASH_GUIDES_NEW_QUALITY_FORMAT_MERGED) {
		console.log(
			"[DEPLOYMENT] TRaSH Guides NEW format active, reversing quality items for API compatibility",
		);
		return [...items].reverse();
	}

	return items;
}

/**
 * Calculates the resolved score for a Custom Format using priority rules:
 * 1. Instance-level override (manual changes in instance)
 * 2. Template-level override (user's wizard selection)
 * 3. TRaSH Guides score from profile's score set
 * 4. TRaSH Guides default score
 * 5. Fallback to 0
 */
function calculateScoreAndSource(
	templateCF: TemplateCFForScoring,
	scoreSet: string | undefined | null,
	instanceOverrideScore?: number,
): ScoreCalculationResult {
	// Priority 1: Instance-level override (manual changes)
	if (instanceOverrideScore !== undefined) {
		return { score: instanceOverrideScore, scoreSource: "instance override" };
	}

	// Priority 2: User's score override from wizard (template-level)
	if (templateCF.scoreOverride !== undefined && templateCF.scoreOverride !== null) {
		return { score: templateCF.scoreOverride, scoreSource: "template override" };
	}

	// Priority 3: TRaSH Guides score from profile's score set
	if (scoreSet && templateCF.originalConfig?.trash_scores?.[scoreSet] !== undefined) {
		return {
			score: templateCF.originalConfig.trash_scores[scoreSet],
			scoreSource: `TRaSH score set (${scoreSet})`,
		};
	}

	// Priority 4: TRaSH Guides default score
	if (templateCF.originalConfig?.trash_scores?.default !== undefined) {
		return {
			score: templateCF.originalConfig.trash_scores.default,
			scoreSource: "TRaSH default",
		};
	}

	// Priority 5: Fallback to 0
	return { score: 0, scoreSource: "default" };
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
	// Private Helper Methods (extracted for maintainability)
	// ============================================================================

	/**
	 * Validates template and instance access, parses configs, and applies instance overrides.
	 * Returns all data needed for deployment.
	 */
	private async validateAndPrepareDeployment(
		templateId: string,
		instanceId: string,
		userId: string,
	): Promise<ValidatedDeploymentData> {
		// Get template with ownership verification
		const template = await this.prisma.trashTemplate.findUnique({
			where: { id: templateId, userId },
		});

		if (!template) {
			throw new Error("Template not found or access denied");
		}

		// Get instance with ownership verification
		const instance = await this.prisma.serviceInstance.findFirst({
			where: {
				id: instanceId,
				userId,
			},
		});

		if (!instance) {
			throw new Error("Instance not found or access denied");
		}

		// Validate service type match (case-insensitive comparison)
		const templateServiceType = template.serviceType?.toUpperCase() ?? "";
		const instanceServiceType = instance.service?.toUpperCase() ?? "";
		if (
			!templateServiceType ||
			!instanceServiceType ||
			templateServiceType !== instanceServiceType
		) {
			throw new Error(
				`Service type mismatch: template is ${template.serviceType ?? "undefined"}, instance is ${instance.service ?? "undefined"}`,
			);
		}

		// Parse template config
		let templateConfig: Record<string, any>;
		try {
			templateConfig = JSON.parse(template.configData);
		} catch (parseError) {
			throw new Error(
				`Failed to parse template configData for template ${template.id}: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
			);
		}

		let templateCFs = (templateConfig.customFormats || []) as TemplateCF[];

		// Parse instance overrides
		let instanceOverrides: Record<string, any> = {};
		try {
			instanceOverrides = template.instanceOverrides ? JSON.parse(template.instanceOverrides) : {};
		} catch (parseError) {
			console.warn(
				`Failed to parse instanceOverrides for template ${template.id}, using empty object: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
			);
		}

		const overridesForInstance = instanceOverrides[instanceId] || {};

		// Apply instance-specific overrides to filter/modify CFs
		// Storage field names: cfScoreOverrides, cfSelectionOverrides
		if (overridesForInstance.cfScoreOverrides || overridesForInstance.cfSelectionOverrides) {
			templateCFs = templateCFs
				.map((cf) => {
					const cfOverride = overridesForInstance.cfSelectionOverrides?.[cf.trashId];
					const scoreOverride = overridesForInstance.cfScoreOverrides?.[cf.trashId];

					// Skip if CF is disabled for this instance
					if (cfOverride?.enabled === false) {
						return null;
					}

					// Apply score override if exists
					const finalScore = scoreOverride !== undefined ? scoreOverride : cf.scoreOverride;

					return {
						...cf,
						scoreOverride: finalScore,
					};
				})
				.filter((cf): cf is NonNullable<typeof cf> => cf !== null);
		}

		// Determine effective quality config: instance override takes precedence over template default
		const instanceQualityOverride = overridesForInstance.qualityConfigOverride as
			| CustomQualityConfig
			| undefined;
		const templateQualityConfig = templateConfig.customQualityConfig as
			| CustomQualityConfig
			| undefined;
		const effectiveQualityConfig = instanceQualityOverride ?? templateQualityConfig;
		const usingQualityOverride = instanceQualityOverride !== undefined;

		// Note: usingQualityOverride is returned in the result for callers to log if needed

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

	/**
	 * Creates backup snapshot and history records atomically.
	 */
	private async createBackupAndHistory(
		instance: { id: string },
		userId: string,
		preDeploymentCFs: SdkCustomFormat[],
		templateId: string,
	): Promise<BackupAndHistoryResult> {
		// Get user's backup retention settings
		const userSettings = await this.prisma.trashSettings.findUnique({
			where: { userId },
			select: { backupRetentionDays: true },
		});
		const retentionDays = userSettings?.backupRetentionDays ?? 30;

		// Calculate expiration date (null if retention is 0 = never expire)
		let expiresAt: Date | null = null;
		if (retentionDays > 0) {
			expiresAt = new Date();
			expiresAt.setDate(expiresAt.getDate() + retentionDays);
		}

		// Use transaction to ensure backup and history records are created atomically
		const { backup, history } = await this.prisma.$transaction(async (tx) => {
			const backupRecord = await tx.trashBackup.create({
				data: {
					instanceId: instance.id,
					userId,
					backupData: JSON.stringify(preDeploymentCFs),
					expiresAt,
				},
			});

			// Create deployment history record (TrashSyncHistory for legacy compatibility)
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

	/**
	 * Deploys Custom Formats to the instance (create/update loop).
	 */
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
				// Try to match by trashId first, then fall back to name
				let existingCF = existingCFMap.get(templateCF.trashId);
				if (!existingCF) {
					existingCF = existingCFByName.get(templateCF.name);
				}

				// Check conflict resolution - if user chose "keep_existing" for this CF, skip it
				if (existingCF && conflictResolutions?.[templateCF.trashId] === "keep_existing") {
					skipped++;
					continue;
				}

				if (existingCF?.id) {
					// Update existing CF
					// Transform specifications: convert fields from object to array format
					const specifications = (templateCF.originalConfig?.specifications || []).map(
						(spec: any) => {
							const transformedFields = this.transformFieldsToArray(spec.fields);
							return {
								...spec,
								fields: transformedFields,
							};
						},
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
					// Create new CF
					// Transform specifications: convert fields from object to array format
					const specifications = (templateCF.originalConfig?.specifications || []).map(
						(spec: any) => {
							const transformedFields = this.transformFieldsToArray(spec.fields);
							return {
								...spec,
								fields: transformedFields,
							};
						},
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
				console.error(`[DEPLOYMENT] Failed to deploy "${templateCF.name}":`, error);
				console.error("[DEPLOYMENT] Error details:", {
					message: error instanceof Error ? error.message : "Unknown error",
					stack: error instanceof Error ? error.stack : undefined,
					error: error,
				});
				errors.push(
					`Failed to deploy "${templateCF.name}": ${error instanceof Error ? error.message : "Unknown error"}`,
				);
				details.failed.push(templateCF.name);
				skipped++;
			}
		}

		return { created, updated, skipped, details, errors };
	}

	/**
	 * Syncs the quality profile with Custom Format scores.
	 * Creates profile if needed, updates CF scores, and maintains template mapping.
	 * Also handles orphaned CFs by setting their scores to 0.
	 */
	private async syncQualityProfile(
		client: SonarrClient | RadarrClient,
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

			// Find existing profile by name
			let targetProfile = qualityProfiles.find((p) => p.name === profileName);

			// Create quality profile if it doesn't exist
			if (!targetProfile) {
				targetProfile = await this.createQualityProfileFromSchema(
					client,
					templateConfig,
					templateCFs,
					profileName,
					effectiveQualityConfig,
				);
			}

			if (targetProfile) {
				// Get fresh CFs list with IDs
				const allCFs = await client.customFormat.getAll();
				const cfMap = new Map(allCFs.map((cf) => [cf.name, cf]));

				// Fetch instance-level quality profile score overrides
				const instanceOverrides = await this.prisma.instanceQualityProfileOverride.findMany({
					where: {
						instanceId,
						qualityProfileId: targetProfile.id,
					},
				});
				const overrideMap = new Map(
					instanceOverrides.map((override) => [override.customFormatId, override.score]),
				);

				// Build format items from template CFs
				const formatItems: Array<{ format: number; score: number }> = [];
				const scoreSet = templateConfig.qualityProfile?.trash_score_set;

				// Build map of existing scores in the profile for "keep_existing" resolution
				const existingScoreMap = new Map<number, number>();
				for (const item of targetProfile.formatItems || []) {
					if (item.format !== undefined && item.score !== undefined) {
						existingScoreMap.set(item.format, item.score);
					}
				}

				for (const templateCF of templateCFs) {
					const cf = cfMap.get(templateCF.name);
					if (cf?.id) {
						// Check if user chose "keep_existing" for this CF's conflicts
						// If so, preserve the instance's current score instead of template score
						if (conflictResolutions?.[templateCF.trashId] === "keep_existing") {
							const existingScore = existingScoreMap.get(cf.id);
							if (existingScore !== undefined) {
								formatItems.push({
									format: cf.id,
									score: existingScore,
								});
								continue;
							}
						}

						// Use helper to calculate score with instance override support
						const instanceOverrideScore = overrideMap.get(cf.id);
						const { score } = calculateScoreAndSource(templateCF, scoreSet, instanceOverrideScore);

						formatItems.push({
							format: cf.id,
							score,
						});
					}
				}

				// Identify orphaned CFs: were in previous deployment but not in current template
				// Set their scores to 0 to neutralize them without deleting (may be used by other templates)
				const currentTemplateCFNames = new Set(templateCFs.map((cf) => cf.name));
				const cfByName = new Map(allCFs.map((cf) => [cf.name, cf]));

				// Track already-added format IDs to prevent duplicates
				const addedFormatIds = new Set(formatItems.map((item) => item.format));

				for (const prevCF of previouslyDeployedCFs) {
					// If this CF was previously deployed but is no longer in the template
					if (!currentTemplateCFNames.has(prevCF.name)) {
						const instanceCF = cfByName.get(prevCF.name);
						// Only add if the format ID isn't already in formatItems
						if (instanceCF?.id && !addedFormatIds.has(instanceCF.id)) {
							// Set score to 0 to neutralize it
							formatItems.push({
								format: instanceCF.id,
								score: 0,
							});
							addedFormatIds.add(instanceCF.id);
							orphanedCFs.push(prevCF.name);
						}
					}
				}

				// Merge with existing formatItems to preserve CFs not in this template
				const existingFormatMap = new Map(
					(targetProfile.formatItems || []).map((item) => [item.format, item]),
				);

				for (const newItem of formatItems) {
					existingFormatMap.set(newItem.format, newItem);
				}

				// Build the updated profile
				let updatedProfile: any = {
					...targetProfile,
					formatItems: Array.from(existingFormatMap.values()),
				};

				// If this is a cloned profile template, also update quality items structure
				if (templateConfig.completeQualityProfile) {
					const clonedProfile = templateConfig.completeQualityProfile;
					const schema = await client.qualityProfile.getSchema();

					// Build quality items from cloned profile
					const normalizeQualityName = (name: string) => name.replace(/[\s-]/g, "").toLowerCase();
					const allAvailableQualities = new Map<number, any>();
					const qualitiesByName = new Map<string, any>();

					// Extract all qualities from schema - handles both individual items and group sub-items
					const extractQualities = (items: any[]) => {
						for (const item of items) {
							// Items with quality wrapper (individual quality items)
							if (item.quality) {
								allAvailableQualities.set(item.quality.id, item);
								qualitiesByName.set(normalizeQualityName(item.quality.name), item);
							}
							// Sub-items inside groups have id/name directly (no quality wrapper)
							// e.g. {"id":15,"name":"WEBRip-1080p","source":"webRip","resolution":1080,"allowed":true}
							else if (item.id !== undefined && item.name && !item.items) {
								// Wrap it in a quality structure for consistency
								const wrappedItem = {
									quality: {
										id: item.id,
										name: item.name,
										source: item.source,
										resolution: item.resolution,
									},
									items: [],
									allowed: item.allowed,
								};
								allAvailableQualities.set(item.id, wrappedItem);
								qualitiesByName.set(normalizeQualityName(item.name), wrappedItem);
							}
							// Recurse into groups
							if (item.items && Array.isArray(item.items)) {
								extractQualities(item.items);
							}
						}
					};
					extractQualities(schema.items || []);

					let customGroupId = 1000;
					const qualityItems: any[] = [];
					const sourceIdToNewId = new Map<number, number>(); // Maps source item IDs to new IDs

					for (const sourceItem of clonedProfile.items || []) {
						if (
							sourceItem.items &&
							Array.isArray(sourceItem.items) &&
							sourceItem.items.length > 0
						) {
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
										allowed: subItem.allowed,
									});
								}
							}
							if (groupQualities.length > 0) {
								const newGroupId = customGroupId++;
								// Map source group ID to new group ID for cutoff remapping
								if (sourceItem.id !== undefined) {
									sourceIdToNewId.set(sourceItem.id, newGroupId);
								}
								qualityItems.push({
									name: sourceItem.name,
									items: groupQualities,
									allowed: sourceItem.allowed,
									id: newGroupId,
								});
							}
						} else if (sourceItem.quality) {
							let targetQuality = allAvailableQualities.get(sourceItem.quality.id);
							if (!targetQuality && sourceItem.quality.name) {
								targetQuality = qualitiesByName.get(normalizeQualityName(sourceItem.quality.name));
							}
							if (targetQuality) {
								// Map source quality ID to target quality ID
								const newId = targetQuality.quality?.id ?? sourceItem.quality.id;
								if (sourceItem.quality.id !== undefined) {
									sourceIdToNewId.set(sourceItem.quality.id, newId);
								}
								qualityItems.push({
									...targetQuality,
									allowed: sourceItem.allowed,
								});
							}
						}
					}

					// Remap cutoff ID from source profile to new quality items
					let remappedCutoff = clonedProfile.cutoff;
					if (sourceIdToNewId.has(clonedProfile.cutoff)) {
						remappedCutoff = sourceIdToNewId.get(clonedProfile.cutoff)!;
					} else if (qualityItems.length > 0) {
						// Cutoff ID not found - use fallback
						const lastItem = qualityItems[qualityItems.length - 1];
						remappedCutoff = lastItem.id ?? lastItem.quality?.id ?? clonedProfile.cutoff;
					}

					// Update profile with cloned quality settings
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

				// Ensure profile ID exists before updating
				if (targetProfile.id === undefined) {
					throw new Error("Quality profile ID is missing");
				}
				// Use any cast - Sonarr/Radarr quality profile types differ in source values but are runtime-compatible
				await client.qualityProfile.update(targetProfile.id, updatedProfile as any);

				// Create/update mapping to track that this profile is managed by this template
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
			console.error("[DEPLOYMENT] Failed to update quality profile:", error);
			errors.push(
				`Failed to update quality profile: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}

		return { errors, orphanedCFs };
	}

	/**
	 * Creates a quality profile from schema with template configuration.
	 * Supports both TRaSH Guides profiles (qualityProfile) and cloned instance profiles (completeQualityProfile)
	 * @param effectiveQualityConfig - The quality config to use (may be instance override or template default)
	 */
	private async createQualityProfileFromSchema(
		client: SonarrClient | RadarrClient,
		templateConfig: Record<string, any>,
		templateCFs: TemplateCF[],
		profileName: string,
		effectiveQualityConfig?: CustomQualityConfig,
	): Promise<any> {
		try {
			// Get the quality profile schema to get proper structure
			const schema = await client.qualityProfile.getSchema();

			// Check if this is a cloned profile with complete quality profile data
			if (templateConfig.completeQualityProfile) {
				return await this.createQualityProfileFromClonedProfile(
					client,
					schema,
					templateConfig,
					templateCFs,
					profileName,
				);
			}

			// Check if custom quality config is enabled (use effectiveQualityConfig which may be instance override)
			const customQualityConfig =
				effectiveQualityConfig ??
				(templateConfig.customQualityConfig as CustomQualityConfig | undefined);
			if (customQualityConfig?.useCustomQualities && customQualityConfig.items.length > 0) {
				return await this.createQualityProfileFromCustomConfig(
					client,
					schema,
					templateConfig,
					templateCFs,
					profileName,
					customQualityConfig,
				);
			}

			// Normalize quality names for consistent matching (remove spaces/hyphens)
			const normalizeQualityName = (name: string) => name.replace(/[\s-]/g, "").toLowerCase();

			// Build a flat map of all individual qualities available in Radarr schema
			const allAvailableQualities = new Map<string, any>();
			const extractQualities = (items: any[]) => {
				for (const item of items) {
					if (item.quality) {
						// This is an individual quality
						allAvailableQualities.set(normalizeQualityName(item.quality.name), item);
					}
					// Recursively extract from nested items
					if (item.items && Array.isArray(item.items)) {
						extractQualities(item.items);
					}
				}
			};
			extractQualities(schema.items || []);

			// Build quality items according to TRaSH Guides structure
			const qualityItems: any[] = [];
			let customGroupId = 1000; // Start custom group IDs at 1000

			// TRaSH Guides PR #2590: Handle inverted quality ordering
			// NEW format has low quality first (Unknown→Remux), API expects high quality first
			// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR quality item structure
			const templateQualityItems: any[] = reverseQualityItemsIfNeeded(
				templateConfig.qualityProfile?.items || [],
			);

			for (const templateItem of templateQualityItems) {
				if (
					templateItem.items &&
					Array.isArray(templateItem.items) &&
					templateItem.items.length > 0
				) {
					// This is a quality GROUP from TRaSH (e.g., "WEB 720p" with nested qualities)

					const groupQualities: any[] = [];
					for (const qualityName of templateItem.items) {
						const quality = allAvailableQualities.get(normalizeQualityName(qualityName));
						if (quality) {
							groupQualities.push({
								...quality,
								allowed: false, // Individual items in groups have allowed=false, group controls it
							});
						}
						// Note: Silently skip qualities not available in instance
					}

					if (groupQualities.length > 0) {
						qualityItems.push({
							name: templateItem.name,
							items: groupQualities,
							allowed: templateItem.allowed,
							id: customGroupId++,
						});
					}
				} else {
					// This is an INDIVIDUAL quality from TRaSH (no nested items)
					const quality = allAvailableQualities.get(normalizeQualityName(templateItem.name));
					if (quality) {
						qualityItems.push({
							...quality,
							allowed: templateItem.allowed,
						});
					}
					// Note: Silently skip qualities not available in instance
				}
			}

			// Get fresh CFs list with IDs for score application
			const allCFs = await client.customFormat.getAll();

			// Apply CF scores from template to the schema's formatItems
			const scoreSet = templateConfig.qualityProfile?.trash_score_set;
			const formatItemsWithScores = (schema.formatItems || []).map((item: any) => {
				// Find corresponding template CF by matching format ID with CF name
				const cf = allCFs.find((cf) => cf.id === item.format);
				if (cf) {
					const templateCF = templateCFs.find((tcf) => tcf.name === cf.name);
					if (templateCF) {
						// Use helper to calculate score (no instance override in create flow)
						const { score } = calculateScoreAndSource(templateCF, scoreSet);
						return {
							...item,
							score,
						};
					}
				}
				return item; // Keep default score 0 for CFs not in template
			});

			// Find the cutoff quality ID from the template's cutoff name
			let cutoffId: number | null = null;
			if (templateConfig.qualityProfile?.cutoff) {
				const cutoffName = templateConfig.qualityProfile.cutoff;

				// Normalize names by removing spaces and hyphens for comparison
				const normalizeName = (name: string) => name.replace(/[\s-]/g, "").toLowerCase();

				const findQualityId = (items: any[], name: string): number | null => {
					const normalizedSearchName = normalizeName(name);

					for (const item of items) {
						// Check top-level quality
						const itemName = item.quality?.name || item.name;
						if (itemName && normalizeName(itemName) === normalizedSearchName) {
							return item.quality?.id || item.id;
						}
						// Check nested qualities (like WEB 2160p contains WEBDL-2160p, WEBRip-2160p)
						if (item.items && Array.isArray(item.items)) {
							for (const subItem of item.items) {
								const subItemName = subItem.quality?.name || subItem.name;
								if (subItemName && normalizeName(subItemName) === normalizedSearchName) {
									return item.id; // Return GROUP ID when cutoff is nested
								}
							}
						}
					}
					return null;
				};

				const foundCutoffId = findQualityId(qualityItems, cutoffName);
				if (foundCutoffId) {
					cutoffId = foundCutoffId;
				}
			}

			// If no cutoff found, use the highest quality item or first item
			if (cutoffId === null && qualityItems.length > 0) {
				const lastItem = qualityItems[qualityItems.length - 1];
				cutoffId = lastItem.id ?? lastItem.quality?.id ?? 1;
				console.warn(`[DEPLOYMENT] Could not resolve cutoff, defaulting to: ${cutoffId}`);
			}

			// Check if any CF scores are actually defined
			// If all scores are 0 or undefined, override minFormatScore to 0
			const hasDefinedScores = formatItemsWithScores.some(
				(item: any) => item.score && item.score !== 0,
			);
			const templateMinScore = templateConfig.qualityProfile?.minFormatScore ?? 0;
			const effectiveMinScore = !hasDefinedScores && templateMinScore > 0 ? 0 : templateMinScore;

			// Use schema as base and customize with template settings
			const profileToCreate = {
				...schema,
				name: profileName,
				upgradeAllowed: templateConfig.qualityProfile?.upgradeAllowed ?? true,
				cutoff: cutoffId ?? 1,
				items: qualityItems,
				minFormatScore: effectiveMinScore,
				cutoffFormatScore: templateConfig.qualityProfile?.cutoffFormatScore ?? 10000,
				minUpgradeFormatScore: templateConfig.qualityProfile?.minUpgradeFormatScore ?? 1,
				formatItems: formatItemsWithScores, // Apply template CF scores
				// Set language from template, defaulting to Original if not specified
				...(templateConfig.qualityProfile?.language
					? {
							language: {
								id:
									templateConfig.qualityProfile.language === "Original"
										? -2
										: templateConfig.qualityProfile.language === "Any"
											? -1
											: 1, // Default to English
								name: templateConfig.qualityProfile.language,
							},
						}
					: {
							language: { id: -2, name: "Original" }, // Default to Original
						}),
			};

			// Remove the id field if it exists (schema might include it)
			const { id: _unusedId, ...profileWithoutId } = profileToCreate as {
				id?: number;
			} & typeof profileToCreate;

			// Use any cast - Sonarr/Radarr quality profile types differ in source values but are runtime-compatible
			return await client.qualityProfile.create(profileWithoutId as any);
		} catch (createError) {
			console.error("[DEPLOYMENT] Failed to create quality profile:", createError);
			console.error("[DEPLOYMENT] Error details:", JSON.stringify(createError, null, 2));
			throw new Error(
				`Failed to create quality profile: ${createError instanceof Error ? createError.message : "Unknown error"}`,
			);
		}
	}

	/**
	 * Creates a quality profile from a cloned instance profile (completeQualityProfile).
	 * This preserves the exact quality item structure from the source instance.
	 */
	private async createQualityProfileFromClonedProfile(
		client: SonarrClient | RadarrClient,
		schema: any,
		templateConfig: Record<string, any>,
		templateCFs: TemplateCF[],
		profileName: string,
	): Promise<any> {
		const clonedProfile = templateConfig.completeQualityProfile;

		// Build a map of all qualities available in the target instance schema
		const normalizeQualityName = (name: string) => name.replace(/[\s-]/g, "").toLowerCase();
		const allAvailableQualities = new Map<number, any>();
		const qualitiesByName = new Map<string, any>();

		// Extract all qualities from schema - handles both individual items and group sub-items
		const extractQualities = (items: any[]) => {
			for (const item of items) {
				// Items with quality wrapper (individual quality items)
				if (item.quality) {
					allAvailableQualities.set(item.quality.id, item);
					qualitiesByName.set(normalizeQualityName(item.quality.name), item);
				}
				// Sub-items inside groups have id/name directly (no quality wrapper)
				// e.g. {"id":15,"name":"WEBRip-1080p","source":"webRip","resolution":1080,"allowed":true}
				else if (item.id !== undefined && item.name && !item.items) {
					// Wrap it in a quality structure for consistency
					const wrappedItem = {
						quality: {
							id: item.id,
							name: item.name,
							source: item.source,
							resolution: item.resolution,
						},
						items: [],
						allowed: item.allowed,
					};
					allAvailableQualities.set(item.id, wrappedItem);
					qualitiesByName.set(normalizeQualityName(item.name), wrappedItem);
				}
				// Recurse into groups
				if (item.items && Array.isArray(item.items)) {
					extractQualities(item.items);
				}
			}
		};
		extractQualities(schema.items);

		// Transform the cloned profile items to match the target instance's quality IDs
		// Also build a mapping from source IDs to new IDs for cutoff remapping
		let customGroupId = 1000;
		const qualityItems: any[] = [];
		const sourceIdToNewId = new Map<number, number>(); // Maps source item IDs to new IDs

		for (const sourceItem of clonedProfile.items || []) {
			if (sourceItem.items && Array.isArray(sourceItem.items) && sourceItem.items.length > 0) {
				// This is a quality GROUP
				const groupQualities: any[] = [];

				for (const subItem of sourceItem.items) {
					// Find matching quality in target instance by ID or name
					let targetQuality = allAvailableQualities.get(subItem.id);
					if (!targetQuality && subItem.name) {
						targetQuality = qualitiesByName.get(normalizeQualityName(subItem.name));
					}

					if (targetQuality) {
						groupQualities.push({
							quality: targetQuality.quality,
							items: [],
							allowed: subItem.allowed,
						});
					}
				}

				if (groupQualities.length > 0) {
					const newGroupId = customGroupId++;
					// Map source group ID to new group ID for cutoff remapping
					if (sourceItem.id !== undefined) {
						sourceIdToNewId.set(sourceItem.id, newGroupId);
					}
					qualityItems.push({
						name: sourceItem.name,
						items: groupQualities,
						allowed: sourceItem.allowed,
						id: newGroupId,
					});
				}
			} else if (sourceItem.quality) {
				// This is an individual quality
				let targetQuality = allAvailableQualities.get(sourceItem.quality.id);
				if (!targetQuality && sourceItem.quality.name) {
					targetQuality = qualitiesByName.get(normalizeQualityName(sourceItem.quality.name));
				}

				if (targetQuality) {
					// Map source quality ID to target quality ID
					const newId = targetQuality.quality?.id ?? sourceItem.quality.id;
					if (sourceItem.quality.id !== undefined) {
						sourceIdToNewId.set(sourceItem.quality.id, newId);
					}
					qualityItems.push({
						...targetQuality,
						allowed: sourceItem.allowed,
					});
				}
			}
		}

		// Remap cutoff ID from source profile to new quality items
		let remappedCutoff = clonedProfile.cutoff;
		if (sourceIdToNewId.has(clonedProfile.cutoff)) {
			remappedCutoff = sourceIdToNewId.get(clonedProfile.cutoff)!;
		} else {
			// Cutoff ID not found in mapping - try to find a valid fallback
			// This can happen if the cutoff quality was filtered out during transformation
			if (qualityItems.length > 0) {
				const lastItem = qualityItems[qualityItems.length - 1];
				remappedCutoff = lastItem.id ?? lastItem.quality?.id ?? 1;
				console.warn(
					`[DEPLOYMENT] Cutoff ID ${clonedProfile.cutoff} not found in remapped items, defaulting to: ${remappedCutoff}`,
				);
			}
		}

		// Get fresh CFs list with IDs for score application
		const allCFs = await client.customFormat.getAll();

		// Extract score set from template config (same as non-cloned profile method)
		const scoreSet = templateConfig.qualityProfile?.trash_score_set;

		// Apply CF scores from template to the schema's formatItems
		const formatItemsWithScores = schema.formatItems.map((item: any) => {
			const cf = allCFs.find((c) => c.id === item.format);
			if (cf) {
				const templateCF = templateCFs.find((tcf) => tcf.name === cf.name);
				if (templateCF) {
					// Use helper to calculate score (no instance override in create flow)
					const { score } = calculateScoreAndSource(templateCF, scoreSet);
					return { ...item, score };
				}
			}
			return item;
		});

		// Build the profile to create
		const profileToCreate = {
			...schema,
			name: profileName,
			upgradeAllowed: clonedProfile.upgradeAllowed,
			cutoff: remappedCutoff,
			items: qualityItems,
			minFormatScore: clonedProfile.minFormatScore ?? 0,
			cutoffFormatScore: clonedProfile.cutoffFormatScore ?? 10000,
			minUpgradeFormatScore: clonedProfile.minUpgradeFormatScore ?? 1,
			formatItems: formatItemsWithScores,
			...(clonedProfile.language && {
				language: clonedProfile.language,
			}),
		};

		// Remove the id field
		const { id: _unusedId, ...profileWithoutId } = profileToCreate as {
			id?: number;
		} & typeof profileToCreate;

		// Use any cast - Sonarr/Radarr quality profile types differ in source values but are runtime-compatible
		return await client.qualityProfile.create(profileWithoutId as any);
	}

	/**
	 * Creates a quality profile from custom quality configuration.
	 * This uses the user's customized quality items (order, groups, enabled state).
	 */
	private async createQualityProfileFromCustomConfig(
		client: SonarrClient | RadarrClient,
		schema: any,
		templateConfig: Record<string, any>,
		templateCFs: TemplateCF[],
		profileName: string,
		customQualityConfig: CustomQualityConfig,
	): Promise<any> {
		// Build a map of all qualities available in the target instance schema
		const normalizeQualityName = (name: string) => name.replace(/[\s-]/g, "").toLowerCase();
		const qualitiesByName = new Map<string, any>();

		// Extract all qualities from schema
		const extractQualities = (items: any[]) => {
			for (const item of items) {
				if (item.quality) {
					qualitiesByName.set(normalizeQualityName(item.quality.name), item);
				} else if (item.id !== undefined && item.name && !item.items) {
					const wrappedItem = {
						quality: {
							id: item.id,
							name: item.name,
							source: item.source,
							resolution: item.resolution,
						},
						items: [],
						allowed: item.allowed,
					};
					qualitiesByName.set(normalizeQualityName(item.name), wrappedItem);
				}
				if (item.items && Array.isArray(item.items)) {
					extractQualities(item.items);
				}
			}
		};
		extractQualities(schema.items);

		// Transform custom quality items to *arr format
		let customGroupId = 1000;
		const qualityItems: any[] = [];
		const itemIdMap = new Map<string, number>(); // Maps custom item IDs to *arr IDs

		for (const entry of customQualityConfig.items) {
			if (entry.type === "group") {
				// Quality group
				const group = entry.group;
				const groupQualities: any[] = [];

				for (const quality of group.qualities) {
					const targetQuality = qualitiesByName.get(normalizeQualityName(quality.name));
					if (targetQuality) {
						groupQualities.push({
							quality: targetQuality.quality,
							items: [],
							allowed: false, // Individual items in groups have allowed=false
						});
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
				// Individual quality
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
				}
			}
		}

		// Resolve cutoff ID from custom config
		let cutoffId: number | null = null;
		if (customQualityConfig.cutoffId) {
			const mappedId = itemIdMap.get(customQualityConfig.cutoffId);
			if (mappedId !== undefined) {
				cutoffId = mappedId;
			}
		}

		// If no cutoff found, use the last item (highest priority)
		if (cutoffId === null && qualityItems.length > 0) {
			const lastItem = qualityItems[qualityItems.length - 1];
			cutoffId = lastItem.id ?? lastItem.quality?.id ?? 1;
			console.warn(`[DEPLOYMENT] Custom quality cutoff not resolved, defaulting to: ${cutoffId}`);
		}

		// Get fresh CFs list with IDs for score application
		const allCFs = await client.customFormat.getAll();
		const scoreSet = templateConfig.qualityProfile?.trash_score_set;

		// Apply CF scores from template
		const formatItemsWithScores = schema.formatItems.map((item: any) => {
			const cf = allCFs.find((c: SdkCustomFormat) => c.id === item.format);
			if (cf) {
				const templateCF = templateCFs.find((tcf) => tcf.name === cf.name);
				if (templateCF) {
					const { score } = calculateScoreAndSource(templateCF, scoreSet);
					return { ...item, score };
				}
			}
			return item;
		});

		// Build the profile to create
		const profileToCreate = {
			...schema,
			name: profileName,
			upgradeAllowed: templateConfig.qualityProfile?.upgradeAllowed ?? true,
			cutoff: cutoffId ?? 1,
			items: qualityItems,
			minFormatScore: templateConfig.qualityProfile?.minFormatScore ?? 0,
			cutoffFormatScore: templateConfig.qualityProfile?.cutoffFormatScore ?? 10000,
			minUpgradeFormatScore: templateConfig.qualityProfile?.minUpgradeFormatScore ?? 1,
			formatItems: formatItemsWithScores,
		};

		// Remove the id field
		const { id: _unusedId, ...profileWithoutId } = profileToCreate as {
			id?: number;
		} & typeof profileToCreate;

		return await client.qualityProfile.create(profileWithoutId);
	}

	/**
	 * Finalizes deployment history records with results.
	 */
	private async finalizeDeploymentHistory(
		historyId: string | null,
		deploymentHistoryId: string | null,
		startTime: Date,
		details: DeploymentDetails,
		counts: { created: number; updated: number; skipped: number },
		errors: string[],
	): Promise<void> {
		const endTime = new Date();
		const duration = Math.floor((endTime.getTime() - startTime.getTime()) / 1000);

		// Update TrashSyncHistory
		// Note: counts.skipped includes both intentional skips (keep_existing) and failures
		// We use details.failed.length for actual failures, and compute intentional skips
		const intentionalSkips = counts.skipped - details.failed.length;
		if (historyId) {
			await this.prisma.trashSyncHistory.update({
				where: { id: historyId },
				data: {
					status: details.failed.length === 0 ? "SUCCESS" : "PARTIAL_SUCCESS",
					completedAt: endTime,
					duration,
					configsApplied: counts.created + counts.updated,
					configsFailed: details.failed.length,
					configsSkipped: intentionalSkips,
					appliedConfigs: JSON.stringify([...details.created, ...details.updated]),
					failedConfigs: details.failed.length > 0 ? JSON.stringify(details.failed) : null,
					errorLog: errors.length > 0 ? errors.join("\n") : null,
				},
			});
		}

		// Update TemplateDeploymentHistory
		if (deploymentHistoryId) {
			await this.prisma.templateDeploymentHistory.update({
				where: { id: deploymentHistoryId },
				data: {
					status: details.failed.length === 0 ? "SUCCESS" : "PARTIAL_SUCCESS",
					duration,
					appliedCFs: counts.created + counts.updated,
					failedCFs: details.failed.length,
					appliedConfigs: JSON.stringify(
						details.created
							.map((name) => ({ name, action: "created" }))
							.concat(details.updated.map((name) => ({ name, action: "updated" }))),
					),
					failedConfigs:
						details.failed.length > 0
							? JSON.stringify(details.failed.map((name) => ({ name, error: "Deployment failed" })))
							: null,
					errors: errors.length > 0 ? JSON.stringify(errors) : null,
				},
			});
		}
	}

	/**
	 * Updates deployment history with failure status.
	 */
	private async finalizeDeploymentHistoryWithFailure(
		historyId: string | null,
		deploymentHistoryId: string | null,
		startTime: Date,
		error: Error | unknown,
	): Promise<void> {
		const endTime = new Date();
		const duration = Math.floor((endTime.getTime() - startTime.getTime()) / 1000);
		const errorMessage = error instanceof Error ? error.message : "Unknown error";

		if (historyId) {
			await this.prisma.trashSyncHistory.update({
				where: { id: historyId },
				data: {
					status: "FAILED",
					completedAt: endTime,
					duration,
					errorLog: errorMessage,
				},
			});
		}

		if (deploymentHistoryId) {
			await this.prisma.templateDeploymentHistory.update({
				where: { id: deploymentHistoryId },
				data: {
					status: "FAILED",
					duration,
					errors: JSON.stringify([errorMessage]),
				},
			});
		}
	}

	// ============================================================================
	// Public Methods
	// ============================================================================

	/**
	 * Execute deployment to a single instance
	 * @param conflictResolutions - Map of trashId → resolution for CFs with conflicts
	 *   "use_template" = update CF to match template (default)
	 *   "keep_existing" = skip this CF, leave instance version unchanged
	 */
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

		// Start metrics tracking
		const metrics = getSyncMetrics();
		const completeMetrics = metrics.startOperation("deployment");

		try {
			// Step 1: Validate and prepare deployment data
			const { template, instance, templateConfig, templateCFs, effectiveQualityConfig } =
				await this.validateAndPrepareDeployment(templateId, instanceId, userId);

			// Step 2: Create backup snapshot before deployment
			const preDeploymentCFs = await this.getExistingCustomFormats(instance);

			// Step 3: Create backup and history records
			const { backup, historyId: syncHistoryId } = await this.createBackupAndHistory(
				instance,
				userId,
				preDeploymentCFs,
				templateId,
			);
			historyId = syncHistoryId;

			// Step 4: Create SDK client and test connection
			const client = this.clientFactory.create(instance) as SonarrClient | RadarrClient;
			try {
				await client.system.get();
			} catch (error) {
				throw new Error(
					`Instance unreachable: ${error instanceof Error ? error.message : "Unknown error"}`,
				);
			}

			// Step 5: Build maps for existing CFs
			const existingCFs = await client.customFormat.getAll();
			const existingCFMap = new Map<string, SdkCustomFormat>();
			const existingCFByName = new Map<string, SdkCustomFormat>();
			for (const cf of existingCFs) {
				const trashId = this.extractTrashId(cf);
				if (trashId) {
					existingCFMap.set(trashId, cf);
				}
				if (cf.name) {
					existingCFByName.set(cf.name, cf);
				}
			}

			// Step 6: Fetch previous deployment to identify orphaned CFs
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

			// Extract previously deployed CFs from the snapshot
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
					console.warn(
						"[DEPLOYMENT] Failed to parse previous deployment snapshot for orphan detection:",
						parseError,
					);
				}
			}

			// Step 7: Create TemplateDeploymentHistory record
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

			// Step 8: Deploy Custom Formats
			const cfResult = await this.deployCustomFormats(
				client,
				templateCFs,
				existingCFMap,
				existingCFByName,
				conflictResolutions,
			);

			// Step 9: Sync Quality Profile (handles orphaned CFs by setting scores to 0)
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

			// Combine errors from CF deployment and profile sync
			const allErrors = [...cfResult.errors, ...profileResult.errors];

			// Build warnings for orphaned CFs
			const warnings: string[] = [];
			if (profileResult.orphanedCFs.length > 0) {
				warnings.push(
					`${profileResult.orphanedCFs.length} Custom Format(s) removed from TRaSH Guides - scores set to 0: ${profileResult.orphanedCFs.join(", ")}`,
				);
			}

			// Add orphaned CFs to details
			cfResult.details.orphaned = profileResult.orphanedCFs;

			// Step 10: Finalize deployment history with success
			await this.finalizeDeploymentHistory(
				historyId,
				deploymentHistoryId,
				startTime,
				cfResult.details,
				{ created: cfResult.created, updated: cfResult.updated, skipped: cfResult.skipped },
				allErrors,
			);

			// Record metrics
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
			// Record failure metrics
			const errorMessage = error instanceof Error ? error.message : "Unknown error";
			const metricsResult = completeMetrics();
			metricsResult.recordFailure(errorMessage);

			// Update deployment history with failure
			await this.finalizeDeploymentHistoryWithFailure(
				historyId,
				deploymentHistoryId,
				startTime,
				error,
			);

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

	/**
	 * Execute bulk deployment to multiple instances
	 * Supports both global syncStrategy (applies to all) or per-instance strategies
	 */
	async deployBulkInstances(
		templateId: string,
		instanceIds: string[],
		userId: string,
		syncStrategy?: "auto" | "manual" | "notify",
		instanceSyncStrategies?: Record<string, "auto" | "manual" | "notify">,
	): Promise<BulkDeploymentResult> {
		// Get template info with ownership verification
		const template = await this.prisma.trashTemplate.findUnique({
			where: { id: templateId, userId },
		});

		if (!template) {
			throw new Error("Template not found or access denied");
		}

		// Deploy to all instances in parallel using Promise.allSettled for error isolation
		// Use per-instance strategy if provided, otherwise fall back to global strategy
		const deploymentPromises = instanceIds.map((instanceId) => {
			const strategy = instanceSyncStrategies?.[instanceId] ?? syncStrategy;
			return this.deploySingleInstance(templateId, instanceId, userId, strategy);
		});

		const settledResults = await Promise.allSettled(deploymentPromises);

		// Extract results, treating rejected promises as failed deployments
		const results: DeploymentResult[] = settledResults.map((settled, index) => {
			if (settled.status === "fulfilled") {
				return settled.value;
			}
			// Convert rejection to a failed deployment result
			const errorMessage =
				settled.reason instanceof Error ? settled.reason.message : "Deployment failed";
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

	/**
	 * Transform fields from TRaSH Guides object format to Radarr API array format
	 * TRaSH format: { value: 5 }
	 * Radarr format: [{ name: "value", value: 5 }]
	 */
	private transformFieldsToArray(fields: any): Array<{ name: string; value: unknown }> {
		// If fields is already an array, return it as-is
		if (Array.isArray(fields)) {
			return fields;
		}

		// If fields is undefined or null, return empty array
		if (!fields) {
			return [];
		}

		// Convert object format to array format
		const result = Object.entries(fields).map(([name, value]) => ({
			name,
			value,
		}));
		return result;
	}

	/**
	 * Extract trash_id from Custom Format
	 * Checks specifications for a field named "trash_id"
	 */
	/**
	 * Extract trash_id from Custom Format specifications.
	 * Returns null if no trash_id is found, allowing callers to distinguish
	 * between ID-based matching and name-based matching.
	 */
	private extractTrashId(cf: SdkCustomFormat): string | null {
		// Try to find trash_id in specifications
		for (const spec of cf.specifications || []) {
			if (spec.fields) {
				// Handle both array and object format
				if (Array.isArray(spec.fields)) {
					const trashIdField = spec.fields.find((f) => f.name === "trash_id");
					if (trashIdField) {
						return String(trashIdField.value);
					}
				} else if (typeof spec.fields === "object") {
					if ("trash_id" in spec.fields) {
						return String((spec.fields as any).trash_id);
					}
				}
			}
		}

		// No trash_id found - return null to allow explicit name-based matching
		return null;
	}

	/**
	 * Get existing custom formats from instance
	 */
	private async getExistingCustomFormats(instance: any): Promise<SdkCustomFormat[]> {
		const client = this.clientFactory.create(instance) as SonarrClient | RadarrClient;
		return await client.customFormat.getAll();
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
