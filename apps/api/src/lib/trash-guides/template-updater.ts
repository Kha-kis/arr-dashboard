/**
 * TRaSH Guides Template Updater
 *
 * Manages synchronization between TRaSH Guides GitHub repository and user templates.
 * Detects when new versions are available and handles update logic based on user preferences.
 *
 * Note: This module intentionally uses `any` types for dynamic JSON data from external
 * TRaSH Guides API responses and template configurations. The data structures are determined
 * at runtime from external sources.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { PrismaClient } from "@prisma/client";
import type {
	TrashConfigType,
	TemplateConfig,
	TemplateCustomFormat,
	TemplateCustomFormatGroup,
	TrashCustomFormat,
	TrashCustomFormatGroup,
} from "@arr/shared";
import type { VersionTracker, VersionInfo } from "./version-tracker.js";
import type { TrashCacheManager } from "./cache-manager.js";
import type { TrashGitHubFetcher } from "./github-fetcher.js";
import type { DeploymentExecutorService } from "./deployment-executor.js";
import { dequal as deepEqual } from "dequal";

// ============================================================================
// Types
// ============================================================================

export interface TemplateUpdateInfo {
	templateId: string;
	templateName: string;
	currentCommit: string | null;
	latestCommit: string;
	hasUserModifications: boolean;
	// Number of instances with auto-sync enabled for this template
	autoSyncInstanceCount: number;
	canAutoSync: boolean;
	serviceType: "RADARR" | "SONARR";
}

export interface UpdateCheckResult {
	templatesWithUpdates: TemplateUpdateInfo[];
	latestCommit: VersionInfo;
	totalTemplates: number;
	outdatedTemplates: number;
}

export interface SyncResult {
	success: boolean;
	templateId: string;
	previousCommit: string | null;
	newCommit: string;
	errors?: string[];
	mergeStats?: MergeStats;
}

export interface MergeStats {
	customFormatsAdded: number;
	customFormatsRemoved: number;
	customFormatsUpdated: number;
	customFormatsPreserved: number;
	customFormatGroupsAdded: number;
	customFormatGroupsRemoved: number;
	customFormatGroupsUpdated: number;
	customFormatGroupsPreserved: number;
	userCustomizationsPreserved: string[];
}

export interface MergeResult {
	success: boolean;
	mergedConfig: TemplateConfig;
	stats: MergeStats;
	warnings: string[];
}

// ============================================================================
// Template Updater Class
// ============================================================================

export class TemplateUpdater {
	private prisma: PrismaClient;
	private versionTracker: VersionTracker;
	private cacheManager: TrashCacheManager;
	private githubFetcher: TrashGitHubFetcher;
	private deploymentExecutor?: DeploymentExecutorService;

	constructor(
		prisma: PrismaClient,
		versionTracker: VersionTracker,
		cacheManager: TrashCacheManager,
		githubFetcher: TrashGitHubFetcher,
		deploymentExecutor?: DeploymentExecutorService,
	) {
		this.prisma = prisma;
		this.versionTracker = versionTracker;
		this.cacheManager = cacheManager;
		this.githubFetcher = githubFetcher;
		this.deploymentExecutor = deploymentExecutor;
	}

	/**
	 * Check for available updates across all templates
	 */
	async checkForUpdates(): Promise<UpdateCheckResult> {
		// Get latest commit from GitHub
		const latestCommit = await this.versionTracker.getLatestCommit();

		// Get all active templates with their deployment mappings
		const templates = await this.prisma.trashTemplate.findMany({
			where: {
				deletedAt: null,
			},
			select: {
				id: true,
				name: true,
				serviceType: true,
				trashGuidesCommitHash: true,
				hasUserModifications: true,
				// Include deployment mappings to check for auto-sync instances
				qualityProfileMappings: {
					select: {
						syncStrategy: true,
					},
				},
			},
		});

		// Identify templates with available updates
		const templatesWithUpdates: TemplateUpdateInfo[] = [];

		for (const template of templates) {
			// Skip templates without commit hash (never synced with TRaSH Guides)
			if (!template.trashGuidesCommitHash) {
				continue;
			}

			// Check if template is outdated
			if (template.trashGuidesCommitHash !== latestCommit.commitHash) {
				// Count instances with auto-sync enabled for this template
				const autoSyncInstanceCount = template.qualityProfileMappings.filter(
					(m) => m.syncStrategy === "auto"
				).length;

				// Can auto-sync if has auto-sync instances and no user modifications
				const canAutoSync = autoSyncInstanceCount > 0 && !template.hasUserModifications;

				templatesWithUpdates.push({
					templateId: template.id,
					templateName: template.name,
					currentCommit: template.trashGuidesCommitHash,
					latestCommit: latestCommit.commitHash,
					hasUserModifications: template.hasUserModifications,
					autoSyncInstanceCount,
					canAutoSync,
					serviceType: template.serviceType as "RADARR" | "SONARR",
				});
			}
		}

		return {
			templatesWithUpdates,
			latestCommit,
			totalTemplates: templates.length,
			outdatedTemplates: templatesWithUpdates.length,
		};
	}

	/**
	 * Sync a specific template to the latest TRaSH Guides version.
	 * Performs a deterministic merge that:
	 * - Preserves user score overrides and condition customizations
	 * - Adopts new custom formats and groups from TRaSH Guides
	 * - Updates specifications (matching logic) from TRaSH Guides
	 * - Handles deletions by removing obsolete entries
	 */
	async syncTemplate(
		templateId: string,
		targetCommitHash?: string,
	): Promise<SyncResult> {
		// Get template
		const template = await this.prisma.trashTemplate.findUnique({
			where: { id: templateId },
		});

		if (!template) {
			return {
				success: false,
				templateId,
				previousCommit: null,
				newCommit: targetCommitHash || "",
				errors: ["Template not found"],
			};
		}

		// Determine target commit (default to latest)
		const targetCommit = targetCommitHash
			? await this.versionTracker.getCommitInfo(targetCommitHash)
			: await this.versionTracker.getLatestCommit();

		const previousCommit = template.trashGuidesCommitHash;
		const serviceType = template.serviceType as "RADARR" | "SONARR";

		try {
			// Parse existing config data safely
			let currentConfig: TemplateConfig = {
				customFormats: [],
				customFormatGroups: [],
			};
			try {
				currentConfig = JSON.parse(template.configData) as TemplateConfig;
			} catch (parseError) {
				console.warn(
					`[TemplateUpdater] Failed to parse configData for template ${templateId}: ${parseError instanceof Error ? parseError.message : String(parseError)}`
				);
			}

			// Fetch latest TRaSH Guides data from cache
			const fetchResult = await this.fetchLatestTrashData(serviceType);
			if (!fetchResult.success) {
				return {
					success: false,
					templateId,
					previousCommit,
					newCommit: targetCommit.commitHash,
					errors: [`Failed to fetch TRaSH data: ${fetchResult.error}`],
				};
			}

			// Perform merge: preserve user customizations, update specifications
			const mergeResult = this.mergeTemplateConfig(
				currentConfig,
				fetchResult.customFormats,
				fetchResult.customFormatGroups,
			);

			if (!mergeResult.success) {
				return {
					success: false,
					templateId,
					previousCommit,
					newCommit: targetCommit.commitHash,
					errors: ["Merge failed"],
				};
			}

			// Validate merged config
			const validationResult = this.validateMergedConfig(mergeResult.mergedConfig);
			if (!validationResult.valid) {
				return {
					success: false,
					templateId,
					previousCommit,
					newCommit: targetCommit.commitHash,
					errors: validationResult.errors,
				};
			}

			// Update template with merged config
			await this.prisma.trashTemplate.update({
				where: { id: templateId },
				data: {
					configData: JSON.stringify(mergeResult.mergedConfig),
					trashGuidesCommitHash: targetCommit.commitHash,
					lastSyncedAt: new Date(),
					// Preserve hasUserModifications - user customizations are kept
				},
			});

			return {
				success: true,
				templateId,
				previousCommit,
				newCommit: targetCommit.commitHash,
				mergeStats: mergeResult.stats,
			};
		} catch (error) {
			return {
				success: false,
				templateId,
				previousCommit,
				newCommit: targetCommit.commitHash,
				errors: [error instanceof Error ? error.message : String(error)],
			};
		}
	}

	/**
	 * Fetch latest TRaSH Guides custom formats and groups from cache
	 * @private
	 */
	private async fetchLatestTrashData(
		serviceType: "RADARR" | "SONARR",
	): Promise<{
		success: boolean;
		customFormats: TrashCustomFormat[];
		customFormatGroups: TrashCustomFormatGroup[];
		error?: string;
	}> {
		try {
			const [cfCache, groupCache] = await Promise.all([
				this.cacheManager.get<{ data: TrashCustomFormat[] }>(serviceType, "CUSTOM_FORMATS"),
				this.cacheManager.get<{ data: TrashCustomFormatGroup[] }>(serviceType, "CF_GROUPS"),
			]);

			const customFormats = cfCache?.data ?? [];
			const customFormatGroups = groupCache?.data ?? [];

			return {
				success: true,
				customFormats,
				customFormatGroups,
			};
		} catch (error) {
			return {
				success: false,
				customFormats: [],
				customFormatGroups: [],
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/**
	 * Merge current template config with latest TRaSH data.
	 *
	 * Merge strategy:
	 * - For existing CFs: Preserve user's scoreOverride and conditionsEnabled, update originalConfig
	 * - For new CFs: Add with TRaSH defaults
	 * - For removed CFs: Remove from template (TRaSH no longer maintains them)
	 * - For groups: Same strategy - preserve enabled state, update originalConfig
	 *
	 * @private
	 */
	private mergeTemplateConfig(
		currentConfig: TemplateConfig,
		latestCustomFormats: TrashCustomFormat[],
		latestCustomFormatGroups: TrashCustomFormatGroup[],
	): MergeResult {
		const stats: MergeStats = {
			customFormatsAdded: 0,
			customFormatsRemoved: 0,
			customFormatsUpdated: 0,
			customFormatsPreserved: 0,
			customFormatGroupsAdded: 0,
			customFormatGroupsRemoved: 0,
			customFormatGroupsUpdated: 0,
			customFormatGroupsPreserved: 0,
			userCustomizationsPreserved: [],
		};
		const warnings: string[] = [];

		// Build lookup maps for current config
		const currentCFMap = new Map<string, TemplateCustomFormat>(
			(currentConfig.customFormats || []).map((cf) => [cf.trashId, cf])
		);
		const currentGroupMap = new Map<string, TemplateCustomFormatGroup>(
			(currentConfig.customFormatGroups || []).map((g) => [g.trashId, g])
		);

		// Build lookup for latest TRaSH data
		const latestCFMap = new Map<string, TrashCustomFormat>(
			latestCustomFormats.map((cf) => [cf.trash_id, cf])
		);
		const latestGroupMap = new Map<string, TrashCustomFormatGroup>(
			latestCustomFormatGroups.map((g) => [g.trash_id, g])
		);

		// Merge Custom Formats
		const mergedCustomFormats: TemplateCustomFormat[] = [];

		for (const [trashId, latestCF] of latestCFMap) {
			const currentCF = currentCFMap.get(trashId);

			if (currentCF) {
				// Existing CF - preserve user customizations, update specifications
				const hasCustomScore = currentCF.scoreOverride !== undefined &&
					currentCF.scoreOverride !== (latestCF.score ?? 0);
				const hasCustomConditions = Object.values(currentCF.conditionsEnabled || {})
					.some((enabled) => !enabled);

				if (hasCustomScore) {
					stats.userCustomizationsPreserved.push(`${latestCF.name}: custom score`);
				}
				if (hasCustomConditions) {
					stats.userCustomizationsPreserved.push(`${latestCF.name}: custom conditions`);
				}

				// Check if specifications changed
				const specsChanged = !deepEqual(
					currentCF.originalConfig?.specifications ?? null,
					latestCF.specifications ?? null
				);

				if (specsChanged) {
					stats.customFormatsUpdated++;
				} else {
					stats.customFormatsPreserved++;
				}

				// Rebuild conditionsEnabled based on new specifications
				const newConditionsEnabled: Record<string, boolean> = {};
				for (const spec of latestCF.specifications || []) {
					// Preserve user's condition setting if the condition exists in both versions
					// Otherwise default to enabled
					newConditionsEnabled[spec.name] = currentCF.conditionsEnabled?.[spec.name] ?? true;
				}

				mergedCustomFormats.push({
					trashId: latestCF.trash_id,
					name: latestCF.name,
					score: currentCF.scoreOverride ?? latestCF.score ?? 0,
					scoreOverride: currentCF.scoreOverride,
					conditionsEnabled: newConditionsEnabled,
					originalConfig: latestCF,
				});
			} else {
				// New CF from TRaSH Guides
				stats.customFormatsAdded++;

				// Initialize all conditions as enabled
				const conditionsEnabled: Record<string, boolean> = {};
				for (const spec of latestCF.specifications || []) {
					conditionsEnabled[spec.name] = true;
				}

				mergedCustomFormats.push({
					trashId: latestCF.trash_id,
					name: latestCF.name,
					score: latestCF.score ?? 0,
					scoreOverride: undefined,
					conditionsEnabled,
					originalConfig: latestCF,
				});
			}
		}

		// Track removed CFs
		for (const [trashId, currentCF] of currentCFMap) {
			if (!latestCFMap.has(trashId)) {
				stats.customFormatsRemoved++;
				warnings.push(`Custom format "${currentCF.name}" (${trashId}) removed - no longer in TRaSH Guides`);
			}
		}

		// Merge Custom Format Groups
		const mergedCustomFormatGroups: TemplateCustomFormatGroup[] = [];

		for (const [trashId, latestGroup] of latestGroupMap) {
			const currentGroup = currentGroupMap.get(trashId);

			if (currentGroup) {
				// Existing group - preserve enabled state, update originalConfig
				const specsChanged = !deepEqual(
					currentGroup.originalConfig ?? null,
					latestGroup ?? null
				);

				if (specsChanged) {
					stats.customFormatGroupsUpdated++;
				} else {
					stats.customFormatGroupsPreserved++;
				}

				mergedCustomFormatGroups.push({
					trashId: latestGroup.trash_id,
					name: latestGroup.name,
					enabled: currentGroup.enabled,
					originalConfig: latestGroup,
				});
			} else {
				// New group from TRaSH Guides
				stats.customFormatGroupsAdded++;

				// Determine default enabled state from TRaSH data
				const defaultEnabled = latestGroup.default === true || latestGroup.default === "true";

				mergedCustomFormatGroups.push({
					trashId: latestGroup.trash_id,
					name: latestGroup.name,
					enabled: defaultEnabled,
					originalConfig: latestGroup,
				});
			}
		}

		// Track removed groups
		for (const [trashId, currentGroup] of currentGroupMap) {
			if (!latestGroupMap.has(trashId)) {
				stats.customFormatGroupsRemoved++;
				warnings.push(`Custom format group "${currentGroup.name}" (${trashId}) removed - no longer in TRaSH Guides`);
			}
		}

		// Build merged config, preserving other settings
		const mergedConfig: TemplateConfig = {
			...currentConfig,
			customFormats: mergedCustomFormats,
			customFormatGroups: mergedCustomFormatGroups,
		};

		return {
			success: true,
			mergedConfig,
			stats,
			warnings,
		};
	}

	/**
	 * Validate merged configuration meets schema requirements
	 * @private
	 */
	private validateMergedConfig(config: TemplateConfig): { valid: boolean; errors: string[] } {
		const errors: string[] = [];

		// Validate customFormats array exists and has proper structure
		if (!Array.isArray(config.customFormats)) {
			errors.push("customFormats must be an array");
		} else {
			for (const [index, cf] of config.customFormats.entries()) {
				if (!cf.trashId) {
					errors.push(`customFormats[${index}]: trashId is required`);
				}
				if (!cf.name) {
					errors.push(`customFormats[${index}]: name is required`);
				}
				if (!cf.conditionsEnabled || typeof cf.conditionsEnabled !== "object") {
					errors.push(`customFormats[${index}]: conditionsEnabled must be an object`);
				}
				if (!cf.originalConfig) {
					errors.push(`customFormats[${index}]: originalConfig is required`);
				}
			}
		}

		// Validate customFormatGroups array
		if (config.customFormatGroups && !Array.isArray(config.customFormatGroups)) {
			errors.push("customFormatGroups must be an array");
		} else if (config.customFormatGroups) {
			for (const [index, group] of config.customFormatGroups.entries()) {
				if (!group.trashId) {
					errors.push(`customFormatGroups[${index}]: trashId is required`);
				}
				if (!group.name) {
					errors.push(`customFormatGroups[${index}]: name is required`);
				}
				if (typeof group.enabled !== "boolean") {
					errors.push(`customFormatGroups[${index}]: enabled must be a boolean`);
				}
			}
		}

		return {
			valid: errors.length === 0,
			errors,
		};
	}

	/**
	 * Process automatic updates for templates with auto-sync enabled
	 * Also triggers automatic deployment to mapped instances after successful sync
	 */
	async processAutoUpdates(): Promise<{
		processed: number;
		successful: number;
		failed: number;
		results: SyncResult[];
	}> {
		const updateCheck = await this.checkForUpdates();

		// Filter templates eligible for auto-sync
		const autoSyncTemplates = updateCheck.templatesWithUpdates.filter(
			(t) => t.canAutoSync,
		);

		const results: SyncResult[] = [];
		let successful = 0;
		let failed = 0;

		for (const template of autoSyncTemplates) {
			const result = await this.syncTemplate(
				template.templateId,
				template.latestCommit,
			);

			results.push(result);

			if (result.success) {
				successful++;

				// Auto-deploy to mapped instances after successful sync
				try {
					await this.deployToMappedInstances(template.templateId);
				} catch (error) {
					// Log deployment error but don't fail the sync
					console.error(`Auto-deploy failed for template ${template.templateId}:`, error);
					// Optionally add deployment error to result
					if (!result.errors) {
						result.errors = [];
					}
					result.errors.push(
						`Auto-deploy failed: ${error instanceof Error ? error.message : String(error)}`
					);
				}
			} else {
				failed++;
			}
		}

		return {
			processed: autoSyncTemplates.length,
			successful,
			failed,
			results,
		};
	}

	/**
	 * Deploy template to all mapped instances
	 * @private
	 */
	private async deployToMappedInstances(templateId: string): Promise<void> {
		// Skip if deployment executor not provided
		if (!this.deploymentExecutor) {
			return;
		}

		// Get all instances mapped to this template
		const mappings = await this.prisma.templateQualityProfileMapping.findMany({
			where: { templateId },
			include: {
				instance: true,
			},
		});

		if (mappings.length === 0) {
			return; // No instances mapped, nothing to deploy
		}

		// Deploy to each mapped instance
		// Note: Using a system user ID for auto-deployments
		const SYSTEM_USER_ID = "system";
		for (const mapping of mappings) {
			try {
				const result = await this.deploymentExecutor.deploySingleInstance(
					templateId,
					mapping.instanceId,
					SYSTEM_USER_ID,
				);

				if (!result.success) {
					console.error(
						`Failed to auto-deploy template ${templateId} to instance ${mapping.instance.label}:`,
						result.errors
					);
				}
			} catch (error) {
				console.error(
					`Error auto-deploying template ${templateId} to instance ${mapping.instanceId}:`,
					error
				);
			}
		}
	}

	/**
	 * Get templates requiring user attention (not auto-synced or have user modifications)
	 */
	async getTemplatesNeedingAttention(): Promise<TemplateUpdateInfo[]> {
		const updateCheck = await this.checkForUpdates();

		// Templates that can't auto-sync need user attention
		return updateCheck.templatesWithUpdates.filter(
			(t) => !t.canAutoSync || t.hasUserModifications,
		);
	}

	/**
	 * Get diff comparison between template's current config and latest TRaSH Guides
	 */
	async getTemplateDiff(
		templateId: string,
		targetCommitHash?: string,
	): Promise<{
		templateId: string;
		templateName: string;
		currentCommit: string | null;
		latestCommit: string;
		summary: {
			totalChanges: number;
			addedCFs: number;
			removedCFs: number;
			modifiedCFs: number;
			unchangedCFs: number;
		};
		customFormatDiffs: Array<{
			trashId: string;
			name: string;
			changeType: "added" | "removed" | "modified" | "unchanged";
			currentScore?: number;
			newScore?: number;
			currentSpecifications?: any[];
			newSpecifications?: any[];
			hasSpecificationChanges: boolean;
		}>;
		customFormatGroupDiffs: Array<{
			trashId: string;
			name: string;
			changeType: "added" | "removed" | "modified" | "unchanged";
			customFormatDiffs: any[];
		}>;
		hasUserModifications: boolean;
	}> {
		// Get template
		const template = await this.prisma.trashTemplate.findUnique({
			where: { id: templateId },
		});

		if (!template) {
			throw new Error("Template not found");
		}

		// Determine target commit (default to latest)
		const targetCommit = targetCommitHash
			? await this.versionTracker.getCommitInfo(targetCommitHash)
			: await this.versionTracker.getLatestCommit();

		const serviceType = template.serviceType as "RADARR" | "SONARR";

		// Get latest cache data for comparison
		const customFormatsCache = await this.cacheManager.get(
			serviceType,
			"CUSTOM_FORMATS",
		);
		const cfGroupsCache = await this.cacheManager.get(serviceType, "CF_GROUPS");

		// Parse template config with error handling for corrupted data
		let templateConfig: {
			customFormats?: any[];
			customFormatGroups?: any[];
		} = {};
		try {
			templateConfig = JSON.parse(template.configData);
		} catch (parseError) {
			console.error(
				`Failed to parse configData for template "${template.name}" (id: ${template.id}): ${parseError instanceof Error ? parseError.message : "Unknown error"}`,
			);
			// Fall back to empty config - updater can continue with empty state
			templateConfig = {};
		}
		const currentCFs = new Map<string, any>(
			templateConfig.customFormats?.map((cf: any) => [cf.trashId, cf]) || [],
		);
		const currentGroups = new Map<string, any>(
			templateConfig.customFormatGroups?.map((g: any) => [g.trashId, g]) || [],
		);

		// Parse latest cache data
		const latestCFsData = ((customFormatsCache as any)?.data || []) as any[];
		const latestCFs = new Map(
			latestCFsData.map((cf: any) => [cf.trash_id, cf]),
		);
		const latestGroupsData = ((cfGroupsCache as any)?.data || []) as any[];
		const latestGroups = new Map(
			latestGroupsData.map((g: any) => [g.trash_id, g]),
		);

		// Compare Custom Formats
		const customFormatDiffs: any[] = [];
		let addedCFs = 0;
		let removedCFs = 0;
		let modifiedCFs = 0;
		let unchangedCFs = 0;

		// Check for added or modified CFs
		for (const [trashId, latestCF] of latestCFs) {
			const currentCF = currentCFs.get(trashId) as any;

			if (!currentCF) {
				// CF is new in latest
				customFormatDiffs.push({
					trashId,
					name: (latestCF as any).name,
					changeType: "added",
					newScore: 0, // Default score
					newSpecifications: (latestCF as any).specifications || [],
					hasSpecificationChanges: false,
				});
				addedCFs++;
			} else {
				// CF exists, check for modifications
				// Use deepEqual for deterministic comparison (handles different key ordering)
				const currentSpecs = currentCF.originalConfig?.specifications ?? null;
				const latestSpecs = (latestCF as any).specifications ?? null;
				const specificationsChanged = !deepEqual(currentSpecs, latestSpecs);

				if (specificationsChanged) {
					customFormatDiffs.push({
						trashId,
						name: (latestCF as any).name,
						changeType: "modified",
						currentScore: currentCF.scoreOverride,
						newScore: currentCF.scoreOverride, // Keep user's score
						currentSpecifications: currentCF.originalConfig?.specifications || [],
						newSpecifications: (latestCF as any).specifications || [],
						hasSpecificationChanges: true,
					});
					modifiedCFs++;
				} else {
					customFormatDiffs.push({
						trashId,
						name: (latestCF as any).name,
						changeType: "unchanged",
						currentScore: currentCF.scoreOverride,
						newScore: currentCF.scoreOverride,
						currentSpecifications: currentCF.originalConfig?.specifications || [],
						newSpecifications: (latestCF as any).specifications || [],
						hasSpecificationChanges: false,
					});
					unchangedCFs++;
				}
			}
		}

		// Check for removed CFs
		for (const [trashId, currentCF] of currentCFs) {
			if (!latestCFs.has(trashId)) {
				const cf = currentCF as any;
				customFormatDiffs.push({
					trashId,
					name: cf.name,
					changeType: "removed",
					currentScore: cf.scoreOverride,
					currentSpecifications: cf.originalConfig?.specifications || [],
					hasSpecificationChanges: false,
				});
				removedCFs++;
			}
		}

		// Compare Custom Format Groups
		const customFormatGroupDiffs: any[] = [];

		for (const [trashId, latestGroup] of latestGroups) {
			const currentGroup = currentGroups.get(trashId) as any;

			if (!currentGroup) {
				customFormatGroupDiffs.push({
					trashId,
					name: (latestGroup as any).name,
					changeType: "added",
					customFormatDiffs: [],
				});
			} else {
				// Simple comparison - just note if group exists
				customFormatGroupDiffs.push({
					trashId,
					name: (latestGroup as any).name,
					changeType: "unchanged",
					customFormatDiffs: [],
				});
			}
		}

		for (const [trashId, currentGroup] of currentGroups) {
			if (!latestGroups.has(trashId)) {
				const group = currentGroup as any;
				customFormatGroupDiffs.push({
					trashId,
					name: group.name,
					changeType: "removed",
					customFormatDiffs: [],
				});
			}
		}

		return {
			templateId,
			templateName: template.name,
			currentCommit: template.trashGuidesCommitHash,
			latestCommit: targetCommit.commitHash,
			summary: {
				totalChanges: addedCFs + removedCFs + modifiedCFs,
				addedCFs,
				removedCFs,
				modifiedCFs,
				unchangedCFs,
			},
			customFormatDiffs,
			customFormatGroupDiffs,
			hasUserModifications: template.hasUserModifications,
		};
	}

	/**
	 * Check if cache needs to be updated by comparing commit hashes.
	 * This method does NOT perform the update - use refreshAllCaches for that.
	 */
	async checkCacheNeedsUpdate(
		serviceType: "RADARR" | "SONARR",
		configType: TrashConfigType,
	): Promise<{ needsUpdate: boolean; error?: string }> {
		try {
			// Get latest commit from GitHub
			const latestCommit = await this.versionTracker.getLatestCommit();

			// Get current cache commit hash
			const currentCommitHash = await this.cacheManager.getCommitHash(
				serviceType,
				configType,
			);

			// Needs update if commits differ
			const needsUpdate = currentCommitHash !== latestCommit.commitHash;
			return { needsUpdate };
		} catch (error) {
			return {
				needsUpdate: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/**
	 * Refresh all caches for a service type
	 * This should be called by the scheduler to keep cache up-to-date
	 */
	async refreshAllCaches(serviceType: "RADARR" | "SONARR"): Promise<{
		refreshed: number;
		failed: number;
		errors: string[];
	}> {
		const configTypes: TrashConfigType[] = [
			"CUSTOM_FORMATS",
			"CF_GROUPS",
			"QUALITY_SIZE",
			"NAMING",
			"QUALITY_PROFILES",
			"CF_DESCRIPTIONS",
		];

		let refreshed = 0;
		let failed = 0;
		const errors: string[] = [];

		// Get latest commit for version tagging
		const latestCommit = await this.versionTracker.getLatestCommit();

		for (const configType of configTypes) {
			try {
				// Get current cache commit hash
				const currentCommitHash = await this.cacheManager.getCommitHash(
					serviceType,
					configType,
				);

				// Skip data fetch if already up-to-date, but still touch the cache
				// to update lastCheckedAt so it doesn't show as "stale" in the UI
				if (currentCommitHash === latestCommit.commitHash) {
					await this.cacheManager.touchCache(serviceType, configType);
					continue;
				}

				// Fetch fresh data from GitHub
				const data = await this.githubFetcher.fetchConfigs(serviceType, configType);

				// Update cache with new data and commit hash
				await this.cacheManager.set(
					serviceType,
					configType,
					data,
					latestCommit.commitHash,
				);

				refreshed++;
			} catch (error) {
				failed++;
				errors.push(
					`${configType}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		return { refreshed, failed, errors };
	}
}

// ============================================================================
// Factory Function
// ============================================================================

export function createTemplateUpdater(
	prisma: PrismaClient,
	versionTracker: VersionTracker,
	cacheManager: TrashCacheManager,
	githubFetcher: TrashGitHubFetcher,
	deploymentExecutor?: DeploymentExecutorService,
): TemplateUpdater {
	return new TemplateUpdater(prisma, versionTracker, cacheManager, githubFetcher, deploymentExecutor);
}
