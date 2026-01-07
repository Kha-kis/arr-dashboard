/**
 * TRaSH Guides Template Updater
 *
 * Manages synchronization between TRaSH Guides GitHub repository and user templates.
 * Detects when new versions are available and handles update logic based on user preferences.
 */

import type {
	AutoSyncChangeLogEntry,
	CustomFormatDiff,
	CustomFormatGroupDiff,
	GroupCustomFormat,
	SuggestedCFAddition,
	SuggestedScoreChange,
	TemplateConfig,
	TemplateCustomFormat,
	TemplateCustomFormatGroup,
	TemplateDiffResult,
	TrashConfigType,
	TrashCustomFormat,
	TrashCustomFormatGroup,
	TrashQualityProfile,
} from "@arr/shared";
import type { PrismaClient } from "@prisma/client";
import { dequal as deepEqual } from "dequal";
import type { TrashCacheManager } from "./cache-manager.js";
import type { DeploymentExecutorService } from "./deployment-executor.js";
import type { TrashGitHubFetcher } from "./github-fetcher.js";
import { getSyncMetrics } from "./sync-metrics.js";
import type { VersionInfo, VersionTracker } from "./version-tracker.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Pending CF Group addition that requires user approval
 */
export interface PendingCFGroupAddition {
	trashId: string;
	name: string;
	groupName: string;
	groupTrashId: string;
	recommendedScore: number;
}

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
	// CF Group additions that need user approval (for auto-sync strategy)
	needsApproval?: boolean;
	pendingCFGroupAdditions?: PendingCFGroupAddition[];
	// True if this template was recently auto-synced (is current, not pending)
	isRecentlyAutoSynced?: boolean;
	// Timestamp of the last auto-sync, if isRecentlyAutoSynced is true
	lastAutoSyncTimestamp?: string;
}

export interface UpdateCheckResult {
	templatesWithUpdates: TemplateUpdateInfo[];
	latestCommit: VersionInfo;
	totalTemplates: number;
	outdatedTemplates: number;
}

/**
 * Score conflict when auto-sync can't update a score due to user override
 */
export interface ScoreConflict {
	trashId: string;
	name: string;
	currentScore: number;
	recommendedScore: number;
	userHasOverride: boolean;
}

export interface SyncResult {
	success: boolean;
	templateId: string;
	previousCommit: string | null;
	newCommit: string;
	errors?: string[];
	errorType?: "not_found" | "not_authorized" | "sync_failed";
	mergeStats?: MergeStats;
	// Score conflicts that couldn't be auto-applied due to user overrides
	scoreConflicts?: ScoreConflict[];
}

export interface MergeStats {
	customFormatsAdded: number;
	customFormatsRemoved: number;
	customFormatsUpdated: number;
	customFormatsPreserved: number;
	customFormatsDeprecated: number; // CFs no longer in TRaSH but kept (user-added or deleteRemovedCFs=false)
	customFormatGroupsAdded: number;
	customFormatGroupsRemoved: number;
	customFormatGroupsUpdated: number;
	customFormatGroupsPreserved: number;
	customFormatGroupsDeprecated: number;
	userCustomizationsPreserved: string[];
	// Score update tracking
	scoresUpdated: number;
	scoresSkippedDueToOverride: number;
	// Detailed change tracking for changelog
	addedCFDetails: Array<{ trashId: string; name: string; score: number }>;
	removedCFDetails: Array<{ trashId: string; name: string }>;
	updatedCFDetails: Array<{ trashId: string; name: string }>;
	deprecatedCFDetails: Array<{ trashId: string; name: string; reason: string }>;
	scoreChangeDetails: Array<{ trashId: string; name: string; oldScore: number; newScore: number }>;
}

export interface MergeResult {
	success: boolean;
	mergedConfig: TemplateConfig;
	stats: MergeStats;
	warnings: string[];
	// Score conflicts when user has override but recommended score differs
	scoreConflicts: ScoreConflict[];
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
	 * Check for available updates across templates owned by the specified user.
	 * For templates with auto-sync strategy, also detects CF Group additions that need approval.
	 */
	async checkForUpdates(userId: string): Promise<UpdateCheckResult> {
		// Get latest commit from GitHub with error handling
		let latestCommit: VersionInfo;
		try {
			latestCommit = await this.versionTracker.getLatestCommit();
		} catch (error) {
			console.error(
				`[TemplateUpdater] Failed to get latest commit from GitHub: ${error instanceof Error ? error.message : String(error)}`,
			);
			// Return empty result when version tracker fails
			return {
				templatesWithUpdates: [],
				latestCommit: { commitHash: "", commitDate: "", commitMessage: "", commitUrl: "" },
				totalTemplates: 0,
				outdatedTemplates: 0,
			};
		}

		// Get all active templates owned by this user with their deployment mappings
		const templates = await this.prisma.trashTemplate.findMany({
			where: {
				userId,
				deletedAt: null,
			},
			select: {
				id: true,
				name: true,
				serviceType: true,
				trashGuidesCommitHash: true,
				hasUserModifications: true,
				configData: true, // Need config to check for CF Group additions
				changeLog: true, // Need changelog to detect recent auto-syncs
				lastSyncedAt: true, // Track when template was last synced
				// Include deployment mappings to check for auto-sync instances
				qualityProfileMappings: {
					select: {
						syncStrategy: true,
					},
				},
			},
		});

		// Pre-fetch cache data for both service types to check CF Group additions
		const cacheByServiceType = new Map<
			string,
			{
				cfGroups: TrashCustomFormatGroup[];
				customFormats: TrashCustomFormat[];
			}
		>();

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
					(m) => m.syncStrategy === "auto",
				).length;

				// Can auto-sync if has auto-sync instances and no user modifications
				const canAutoSync = autoSyncInstanceCount > 0 && !template.hasUserModifications;

				const serviceType = template.serviceType as "RADARR" | "SONARR";

				// Check for CF Group additions that need approval (only for auto-sync templates)
				let pendingCFGroupAdditions: PendingCFGroupAddition[] | undefined;
				let needsApproval = false;

				if (autoSyncInstanceCount > 0) {
					// Lazy-load cache data for this service type
					if (!cacheByServiceType.has(serviceType)) {
						const [cfGroups, customFormats] = await Promise.all([
							this.cacheManager.get<TrashCustomFormatGroup[]>(serviceType, "CF_GROUPS"),
							this.cacheManager.get<TrashCustomFormat[]>(serviceType, "CUSTOM_FORMATS"),
						]);
						cacheByServiceType.set(serviceType, {
							cfGroups: cfGroups ?? [],
							customFormats: customFormats ?? [],
						});
					}

					const cache = cacheByServiceType.get(serviceType);
					if (!cache) continue;
					pendingCFGroupAdditions = this.detectCFGroupAdditions(
						template.configData,
						cache.cfGroups,
						cache.customFormats,
					);

					// Needs approval if there are CF Group additions
					needsApproval = pendingCFGroupAdditions.length > 0;
				}

				templatesWithUpdates.push({
					templateId: template.id,
					templateName: template.name,
					currentCommit: template.trashGuidesCommitHash,
					latestCommit: latestCommit.commitHash,
					hasUserModifications: template.hasUserModifications,
					autoSyncInstanceCount,
					canAutoSync: canAutoSync && !needsApproval, // Can't auto-sync if needs approval
					serviceType,
					needsApproval,
					pendingCFGroupAdditions: pendingCFGroupAdditions?.length
						? pendingCFGroupAdditions
						: undefined,
				});
			} else {
				// Template is up-to-date - check if it was recently auto-synced
				// Include templates that have auto-sync instances and were synced in the last 24 hours
				const autoSyncInstanceCount = template.qualityProfileMappings.filter(
					(m) => m.syncStrategy === "auto",
				).length;

				if (autoSyncInstanceCount > 0 && template.lastSyncedAt) {
					const lastSyncedAt = template.lastSyncedAt;
					const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

					if (lastSyncedAt > twentyFourHoursAgo) {
						// Check changelog for recent auto_sync entry
						let hasRecentAutoSync = false;
						let lastAutoSyncTimestamp: string | undefined;

						if (template.changeLog) {
							try {
								const changelog = JSON.parse(template.changeLog) as Array<{
									changeType?: string;
									timestamp?: string;
									toCommitHash?: string;
								}>;
								// Find most recent auto_sync entry that matches current commit
								const autoSyncEntry = changelog
									.filter(
										(entry) =>
											entry.changeType === "auto_sync" &&
											entry.toCommitHash === template.trashGuidesCommitHash,
									)
									.sort(
										(a, b) =>
											new Date(b.timestamp ?? 0).getTime() - new Date(a.timestamp ?? 0).getTime(),
									)[0];

								if (autoSyncEntry?.timestamp) {
									hasRecentAutoSync = true;
									lastAutoSyncTimestamp = autoSyncEntry.timestamp;
								}
							} catch {
								// If changelog parsing fails, fall back to lastSyncedAt
								hasRecentAutoSync = true;
								lastAutoSyncTimestamp = lastSyncedAt.toISOString();
							}
						} else {
							// No changelog but was recently synced
							hasRecentAutoSync = true;
							lastAutoSyncTimestamp = lastSyncedAt.toISOString();
						}

						if (hasRecentAutoSync) {
							const serviceType = template.serviceType as "RADARR" | "SONARR";
							templatesWithUpdates.push({
								templateId: template.id,
								templateName: template.name,
								currentCommit: template.trashGuidesCommitHash,
								latestCommit: latestCommit.commitHash,
								hasUserModifications: template.hasUserModifications,
								autoSyncInstanceCount,
								canAutoSync: false, // Already synced
								serviceType,
								isRecentlyAutoSynced: true,
								lastAutoSyncTimestamp,
							});
						}
					}
				}
			}
		}

		// Count outdated templates (those that are not recently auto-synced)
		const outdatedCount = templatesWithUpdates.filter((t) => !t.isRecentlyAutoSynced).length;

		return {
			templatesWithUpdates,
			latestCommit,
			totalTemplates: templates.length,
			outdatedTemplates: outdatedCount,
		};
	}

	/**
	 * Detect CFs that were added to template's CF Groups but not yet in the template.
	 * These need user approval before auto-sync can proceed.
	 * @private
	 */
	private detectCFGroupAdditions(
		configDataJson: string,
		latestCFGroups: TrashCustomFormatGroup[],
		latestCustomFormats: TrashCustomFormat[],
	): PendingCFGroupAddition[] {
		const pending: PendingCFGroupAddition[] = [];

		// Parse template config
		let config: TemplateConfig;
		try {
			config = JSON.parse(configDataJson) as TemplateConfig;
		} catch {
			return pending;
		}

		// Build lookup for CFs already in template
		const templateCFIds = new Set((config.customFormats || []).map((cf) => cf.trashId));

		// Build lookup for CF Groups in template
		const templateGroupIds = new Set((config.customFormatGroups || []).map((g) => g.trashId));

		// Build lookup for latest CFs
		const latestCFMap = new Map(latestCustomFormats.map((cf) => [cf.trash_id, cf]));

		// Build lookup for latest CF Groups
		const latestGroupMap = new Map(latestCFGroups.map((g) => [g.trash_id, g]));

		// Extended CF type with trash_scores
		type TrashCFWithScores = TrashCustomFormat & { trash_scores?: Record<string, number> };

		// Get score set from template config
		const scoreSet =
			(config.qualityProfile as { trash_score_set?: string } | undefined)?.trash_score_set ||
			"default";

		// Helper to get recommended score
		const getRecommendedScore = (cf: TrashCFWithScores): number => {
			if (cf.trash_scores) {
				if (scoreSet && cf.trash_scores[scoreSet] !== undefined) {
					return cf.trash_scores[scoreSet];
				}
				if (cf.trash_scores.default !== undefined) {
					return cf.trash_scores.default;
				}
			}
			return cf.score ?? 0;
		};

		// Check each CF Group that's in the template
		for (const groupTrashId of templateGroupIds) {
			const latestGroup = latestGroupMap.get(groupTrashId);
			if (!latestGroup?.custom_formats) continue;

			// Check each CF in the latest version of this group
			for (const cfRef of latestGroup.custom_formats) {
				const cfTrashId = typeof cfRef === "string" ? cfRef : (cfRef as GroupCustomFormat).trash_id;

				// Skip if CF is already in template
				if (templateCFIds.has(cfTrashId)) continue;

				// Get full CF data
				const fullCF = latestCFMap.get(cfTrashId) as TrashCFWithScores | undefined;
				if (!fullCF) continue;

				pending.push({
					trashId: cfTrashId,
					name: fullCF.name,
					groupName: latestGroup.name,
					groupTrashId: latestGroup.trash_id,
					recommendedScore: getRecommendedScore(fullCF),
				});
			}
		}

		return pending;
	}

	/**
	 * Sync a specific template to the latest TRaSH Guides version.
	 * Performs a deterministic merge that:
	 * - Preserves user score overrides and condition customizations
	 * - Adopts new custom formats and groups from TRaSH Guides
	 * - Updates specifications (matching logic) from TRaSH Guides
	 * - Handles deletions by removing obsolete entries
	 *
	 * @param options.includeQualityProfileCFs - If true, auto-add new CFs from linked Quality Profile (used by auto-sync)
	 * @param options.applyScoreUpdates - If true, apply recommended scores from trash_scores (respects user overrides)
	 */
	async syncTemplate(
		templateId: string,
		targetCommitHash?: string,
		userId?: string,
		options?: {
			includeQualityProfileCFs?: boolean;
			applyScoreUpdates?: boolean;
		},
	): Promise<SyncResult> {
		// Start metrics tracking
		const metrics = getSyncMetrics();
		const completeMetrics = metrics.startOperation("template_update");

		// First check if template exists at all
		const templateExists = await this.prisma.trashTemplate.findUnique({
			where: { id: templateId },
			select: { id: true, userId: true },
		});

		if (!templateExists) {
			completeMetrics().recordFailure("Template not found");
			return {
				success: false,
				templateId,
				previousCommit: null,
				newCommit: targetCommitHash || "",
				errors: ["Template not found"],
				errorType: "not_found",
			};
		}

		// Verify ownership if userId is provided
		if (userId && templateExists.userId !== userId) {
			completeMetrics().recordFailure("Not authorized");
			return {
				success: false,
				templateId,
				previousCommit: null,
				newCommit: targetCommitHash || "",
				errors: ["Not authorized to modify this template"],
				errorType: "not_authorized",
			};
		}

		// Get full template data
		const template = await this.prisma.trashTemplate.findUnique({
			where: { id: templateId },
		});

		if (!template) {
			completeMetrics().recordFailure("Template not found");
			return {
				success: false,
				templateId,
				previousCommit: null,
				newCommit: targetCommitHash || "",
				errors: ["Template not found"],
				errorType: "not_found",
			};
		}

		// Determine target commit (default to latest) with error handling
		let targetCommit: VersionInfo;
		try {
			targetCommit = targetCommitHash
				? await this.versionTracker.getCommitInfo(targetCommitHash)
				: await this.versionTracker.getLatestCommit();
		} catch (error) {
			const errorMsg = `Failed to get commit info from GitHub: ${error instanceof Error ? error.message : String(error)}`;
			completeMetrics().recordFailure(errorMsg);
			return {
				success: false,
				templateId,
				previousCommit: template.trashGuidesCommitHash,
				newCommit: targetCommitHash || "",
				errors: [errorMsg],
				errorType: "sync_failed",
			};
		}

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
					`[TemplateUpdater] Failed to parse configData for template ${templateId}: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
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
					errorType: "sync_failed",
				};
			}

			// Validate that cache data matches the target commit to prevent data/version mismatch
			if (fetchResult.cacheCommitHash && fetchResult.cacheCommitHash !== targetCommit.commitHash) {
				return {
					success: false,
					templateId,
					previousCommit,
					newCommit: targetCommit.commitHash,
					errors: [
						`Cache/version mismatch: cache contains data for commit ${fetchResult.cacheCommitHash}, but syncing to ${targetCommit.commitHash}. Please refresh the cache and try again.`,
					],
					errorType: "sync_failed",
				};
			}

			// Build set of CFs to include in sync
			const currentCFTrashIds = new Set(
				(currentConfig.customFormats || []).map((cf) => cf.trashId),
			);

			// If includeQualityProfileCFs is true (auto-sync), also include CFs from the linked Quality Profile
			const qualityProfileCFIds = new Set<string>();
			if (options?.includeQualityProfileCFs && template.sourceQualityProfileTrashId) {
				// Fetch quality profiles from cache to find the linked profile's CFs
				const qualityProfilesCache = await this.cacheManager.get(serviceType, "QUALITY_PROFILES");
				const qualityProfilesData = (qualityProfilesCache as TrashQualityProfile[] | null) ?? [];
				const linkedProfile = qualityProfilesData.find(
					(p) => p.trash_id === template.sourceQualityProfileTrashId,
				);

				if (linkedProfile?.formatItems) {
					// formatItems maps CF name to trash_id
					for (const cfTrashId of Object.values(linkedProfile.formatItems)) {
						qualityProfileCFIds.add(cfTrashId);
					}
				}
			}

			// Filter custom formats:
			// - Always include CFs already in the template (update specs)
			// - If includeQualityProfileCFs, also include new CFs from linked Quality Profile
			const filteredCustomFormats = fetchResult.customFormats.filter((cf) => {
				// Always include CFs that are already in the template
				if (currentCFTrashIds.has(cf.trash_id)) {
					return true;
				}
				// Include new CFs from Quality Profile if auto-sync option is enabled
				if (options?.includeQualityProfileCFs && qualityProfileCFIds.has(cf.trash_id)) {
					return true;
				}
				return false;
			});

			// Filter CF Groups - only include groups already in the template
			// (We don't auto-add CF Groups, only CFs from the Quality Profile)
			const currentGroupTrashIds = new Set(
				(currentConfig.customFormatGroups || []).map((g) => g.trashId),
			);
			const filteredCFGroups = fetchResult.customFormatGroups.filter((group) => {
				// Only include groups that are already in the template
				return currentGroupTrashIds.has(group.trash_id);
			});

			// Get score set from template's quality profile config
			const templateQualityProfile = currentConfig.qualityProfile as
				| { trash_score_set?: string }
				| undefined;
			const scoreSet = templateQualityProfile?.trash_score_set || "default";

			// Perform merge: preserve user customizations, update specifications
			// Read deleteRemovedCFs from template config, default to false (conservative - matches Recyclarr behavior)
			const deleteRemovedCFs = currentConfig.syncSettings?.deleteRemovedCFs ?? false;
			const mergeResult = this.mergeTemplateConfig(
				currentConfig,
				filteredCustomFormats,
				filteredCFGroups,
				{
					applyScoreUpdates: options?.applyScoreUpdates,
					scoreSet,
					deleteRemovedCFs,
					targetCommitHash: targetCommit.commitHash,
				},
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

			// Construct auto-sync changelog entry with detailed change data from MergeStats
			const autoSyncChangeLogEntry: AutoSyncChangeLogEntry = {
				changeType: "auto_sync",
				timestamp: new Date().toISOString(),
				fromCommitHash: previousCommit,
				toCommitHash: targetCommit.commitHash,
				customFormatsAdded: mergeResult.stats.addedCFDetails,
				customFormatsRemoved: mergeResult.stats.removedCFDetails,
				customFormatsUpdated: mergeResult.stats.updatedCFDetails,
				scoreChanges: mergeResult.stats.scoreChangeDetails,
				summaryStats: {
					customFormatsAdded: mergeResult.stats.customFormatsAdded,
					customFormatsRemoved: mergeResult.stats.customFormatsRemoved,
					customFormatsUpdated: mergeResult.stats.customFormatsUpdated,
					customFormatsPreserved: mergeResult.stats.customFormatsPreserved,
					customFormatGroupsAdded: mergeResult.stats.customFormatGroupsAdded,
					customFormatGroupsRemoved: mergeResult.stats.customFormatGroupsRemoved,
					customFormatGroupsUpdated: mergeResult.stats.customFormatGroupsUpdated,
					customFormatGroupsPreserved: mergeResult.stats.customFormatGroupsPreserved,
					scoresUpdated: mergeResult.stats.scoresUpdated,
					scoresSkippedDueToOverride: mergeResult.stats.scoresSkippedDueToOverride,
					userCustomizationsPreserved: mergeResult.stats.userCustomizationsPreserved,
				},
			};

			// Parse existing changelog with error handling
			let existingChangeLog: unknown[] = [];
			if (template.changeLog) {
				try {
					const parsed = JSON.parse(template.changeLog);
					existingChangeLog = Array.isArray(parsed) ? parsed : [];
				} catch (parseError) {
					console.warn(
						`[TemplateUpdater] Failed to parse changeLog for template ${templateId}: ${parseError instanceof Error ? parseError.message : String(parseError)}. Resetting to empty array.`,
					);
					existingChangeLog = [];
				}
			}

			// Append new changelog entry
			const updatedChangeLog = [...existingChangeLog, autoSyncChangeLogEntry];

			// Update template with merged config and changelog
			// Note: Changelog entry is added BEFORE updating trashGuidesCommitHash in the same transaction
			await this.prisma.trashTemplate.update({
				where: { id: templateId },
				data: {
					changeLog: JSON.stringify(updatedChangeLog),
					configData: JSON.stringify(mergeResult.mergedConfig),
					trashGuidesCommitHash: targetCommit.commitHash,
					lastSyncedAt: new Date(),
					// Preserve hasUserModifications - user customizations are kept
				},
			});

			// Record success metrics
			const metricsResult = completeMetrics();
			metricsResult.recordSuccess();

			return {
				success: true,
				templateId,
				previousCommit,
				newCommit: targetCommit.commitHash,
				mergeStats: mergeResult.stats,
				scoreConflicts:
					mergeResult.scoreConflicts.length > 0 ? mergeResult.scoreConflicts : undefined,
			};
		} catch (error) {
			// Record failure metrics
			const errorMessage = error instanceof Error ? error.message : String(error);
			const metricsResult = completeMetrics();
			metricsResult.recordFailure(errorMessage);

			return {
				success: false,
				templateId,
				previousCommit,
				newCommit: targetCommit.commitHash,
				errors: [errorMessage],
			};
		}
	}

	/**
	 * Fetch latest TRaSH Guides custom formats and groups from cache
	 * @private
	 */
	private async fetchLatestTrashData(serviceType: "RADARR" | "SONARR"): Promise<{
		success: boolean;
		customFormats: TrashCustomFormat[];
		customFormatGroups: TrashCustomFormatGroup[];
		cacheCommitHash: string | null;
		error?: string;
	}> {
		try {
			const [cfCache, groupCache, cacheCommitHash] = await Promise.all([
				this.cacheManager.get<TrashCustomFormat[]>(serviceType, "CUSTOM_FORMATS"),
				this.cacheManager.get<TrashCustomFormatGroup[]>(serviceType, "CF_GROUPS"),
				this.cacheManager.getCommitHash(serviceType, "CUSTOM_FORMATS"),
			]);

			// Detect cache misses - returning empty arrays would wipe template CFs
			if (cfCache == null || groupCache == null) {
				return {
					success: false,
					customFormats: [],
					customFormatGroups: [],
					cacheCommitHash: null,
					error: "TRaSH cache miss: CUSTOM_FORMATS or CF_GROUPS not ready",
				};
			}

			return {
				success: true,
				customFormats: cfCache,
				customFormatGroups: groupCache,
				cacheCommitHash,
			};
		} catch (error) {
			return {
				success: false,
				customFormats: [],
				customFormatGroups: [],
				cacheCommitHash: null,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/**
	 * Get the set of CF trash_ids that are relevant to a specific quality profile.
	 * This includes:
	 * - CFs directly referenced in the profile's formatItems (mandatory)
	 * - CFs from CF Groups that apply to this profile (not excluded)
	 *
	 * @private
	 */
	private async getProfileRelevantCFIds(
		serviceType: "RADARR" | "SONARR",
		profileTrashId: string | null,
	): Promise<Set<string> | null> {
		// If no profile trash_id, we can't filter - return null to indicate no filtering
		if (!profileTrashId) {
			return null;
		}

		try {
			// Get quality profiles from cache
			const profiles = await this.cacheManager.get<TrashQualityProfile[]>(
				serviceType,
				"QUALITY_PROFILES",
			);

			if (!profiles) {
				return null;
			}

			const profile = profiles.find((p) => p.trash_id === profileTrashId);
			if (!profile) {
				return null;
			}

			const relevantCFIds = new Set<string>();

			// Add CFs from profile's formatItems (mandatory CFs)
			if (profile.formatItems) {
				for (const cfTrashId of Object.values(profile.formatItems)) {
					relevantCFIds.add(cfTrashId);
				}
			}

			// Get CF Groups from cache to find applicable groups
			const cfGroups = await this.cacheManager.get<TrashCustomFormatGroup[]>(
				serviceType,
				"CF_GROUPS",
			);

			if (cfGroups) {
				// Add CFs from CF Groups that apply to this profile
				for (const group of cfGroups) {
					// Check if this group is excluded from the profile
					const isExcluded =
						group.quality_profiles?.exclude &&
						Object.values(group.quality_profiles.exclude).includes(profileTrashId);

					if (!isExcluded && group.custom_formats) {
						// Add all CFs from this applicable group
						for (const cf of group.custom_formats) {
							const cfTrashId = typeof cf === "string" ? cf : (cf as GroupCustomFormat).trash_id;
							relevantCFIds.add(cfTrashId);
						}
					}
				}
			}

			return relevantCFIds;
		} catch (error) {
			console.error(
				`[TemplateUpdater] Failed to get profile-relevant CFs: ${error instanceof Error ? error.message : String(error)}`,
			);
			return null;
		}
	}

	/**
	 * Merge current template config with latest TRaSH data.
	 *
	 * Merge strategy:
	 * - For existing CFs: Preserve user's scoreOverride and conditionsEnabled, update originalConfig
	 * - For new CFs: Add with TRaSH defaults (or recommended scores if applyScoreUpdates)
	 * - For removed CFs: Behavior depends on deleteRemovedCFs option and CF origin
	 *   - deleteRemovedCFs: false (default) → Mark as deprecated, keep in template
	 *   - deleteRemovedCFs: true + origin="trash_sync" → Remove from template
	 *   - origin="user_added" → Always keep (never delete user CFs)
	 * - For groups: Same strategy - preserve enabled state, update originalConfig
	 *
	 * @param scoreOptions.applyScoreUpdates - If true, apply recommended scores (but respect user overrides)
	 * @param scoreOptions.scoreSet - The score set to use (e.g., "default", "sqp-1-1080p")
	 * @param scoreOptions.deleteRemovedCFs - If true, delete CFs removed from TRaSH (only affects trash_sync origin)
	 * @param scoreOptions.targetCommitHash - Target commit for deprecation reason
	 * @private
	 */
	private mergeTemplateConfig(
		currentConfig: TemplateConfig,
		latestCustomFormats: TrashCustomFormat[],
		latestCustomFormatGroups: TrashCustomFormatGroup[],
		scoreOptions?: {
			applyScoreUpdates?: boolean;
			scoreSet?: string;
			deleteRemovedCFs?: boolean;
			targetCommitHash?: string;
		},
	): MergeResult {
		const stats: MergeStats = {
			customFormatsAdded: 0,
			customFormatsRemoved: 0,
			customFormatsUpdated: 0,
			customFormatsPreserved: 0,
			customFormatsDeprecated: 0,
			customFormatGroupsAdded: 0,
			customFormatGroupsRemoved: 0,
			customFormatGroupsUpdated: 0,
			customFormatGroupsPreserved: 0,
			customFormatGroupsDeprecated: 0,
			userCustomizationsPreserved: [],
			scoresUpdated: 0,
			scoresSkippedDueToOverride: 0,
			// Detailed change tracking for changelog
			addedCFDetails: [],
			removedCFDetails: [],
			updatedCFDetails: [],
			deprecatedCFDetails: [],
			scoreChangeDetails: [],
		};
		const warnings: string[] = [];
		const scoreConflicts: ScoreConflict[] = [];

		// Score set to use for trash_scores lookup (defined at function level for use in both helper and main loop)
		const scoreSet = scoreOptions?.scoreSet || "default";

		// Extended CF type with trash_scores
		type TrashCFWithScores = TrashCustomFormat & { trash_scores?: Record<string, number> };

		// Helper to get recommended score for a CF based on score set
		const getRecommendedScore = (cf: TrashCFWithScores): number => {
			if (cf.trash_scores) {
				if (cf.trash_scores[scoreSet] !== undefined) {
					return cf.trash_scores[scoreSet];
				}
				if (cf.trash_scores.default !== undefined) {
					return cf.trash_scores.default;
				}
			}
			return cf.score ?? 0;
		};

		// Build lookup maps for current config
		const currentCFMap = new Map<string, TemplateCustomFormat>(
			(currentConfig.customFormats || []).map((cf) => [cf.trashId, cf]),
		);
		const currentGroupMap = new Map<string, TemplateCustomFormatGroup>(
			(currentConfig.customFormatGroups || []).map((g) => [g.trashId, g]),
		);

		// Build lookup for latest TRaSH data
		const latestCFMap = new Map<string, TrashCustomFormat>(
			latestCustomFormats.map((cf) => [cf.trash_id, cf]),
		);
		const latestGroupMap = new Map<string, TrashCustomFormatGroup>(
			latestCustomFormatGroups.map((g) => [g.trash_id, g]),
		);

		// Merge Custom Formats
		const mergedCustomFormats: TemplateCustomFormat[] = [];

		for (const [trashId, latestCF] of latestCFMap) {
			const currentCF = currentCFMap.get(trashId);
			const latestCFWithScores = latestCF as TrashCFWithScores;
			const recommendedScore = getRecommendedScore(latestCFWithScores);

			if (currentCF) {
				// Existing CF - preserve user customizations, update specifications
				const hasScoreOverride = currentCF.scoreOverride !== undefined;
				// Get current score using correct priority: scoreOverride > trash_scores > fallback
				const cfWithScores = currentCF.originalConfig as TrashCFWithScores | undefined;
				let currentScore: number;
				if (currentCF.scoreOverride !== undefined) {
					currentScore = currentCF.scoreOverride;
				} else if (cfWithScores?.trash_scores) {
					currentScore =
						cfWithScores.trash_scores[scoreSet] ?? cfWithScores.trash_scores.default ?? 0;
				} else {
					currentScore = 0;
				}
				const hasCustomConditions = Object.values(currentCF.conditionsEnabled || {}).some(
					(enabled) => !enabled,
				);

				// Determine final score based on applyScoreUpdates option
				let finalScore: number;
				const finalScoreOverride: number | undefined = currentCF.scoreOverride;
				const userOverrideScore = currentCF.scoreOverride; // Capture for type narrowing

				if (scoreOptions?.applyScoreUpdates) {
					// Auto-sync mode: apply recommended scores unless user has an override
					if (hasScoreOverride && userOverrideScore !== undefined) {
						// User has set a custom score - respect it but track as conflict if different
						finalScore = userOverrideScore;
						if (userOverrideScore !== recommendedScore) {
							stats.scoresSkippedDueToOverride++;
							scoreConflicts.push({
								trashId,
								name: latestCF.name,
								currentScore: userOverrideScore,
								recommendedScore,
								userHasOverride: true,
							});
						}
					} else {
						// No user override - apply recommended score
						if (currentScore !== recommendedScore) {
							stats.scoresUpdated++;
							stats.scoreChangeDetails.push({
								trashId,
								name: latestCF.name,
								oldScore: currentScore,
								newScore: recommendedScore,
							});
						}
						finalScore = recommendedScore;
					}
				} else {
					// Manual/notify mode: preserve existing scores
					finalScore = currentScore;
				}

				if (hasScoreOverride) {
					stats.userCustomizationsPreserved.push(`${latestCF.name}: custom score`);
				}
				if (hasCustomConditions) {
					stats.userCustomizationsPreserved.push(`${latestCF.name}: custom conditions`);
				}

				// Check if specifications changed
				const specsChanged = !deepEqual(
					currentCF.originalConfig?.specifications ?? null,
					latestCF.specifications ?? null,
				);

				if (specsChanged) {
					stats.customFormatsUpdated++;
					stats.updatedCFDetails.push({
						trashId,
						name: latestCF.name,
					});
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

				// Note: We intentionally don't set the 'score' field on template CFs.
				// Deployment reads scores from originalConfig.trash_scores (or scoreOverride
				// if user has set one). The score field is vestigial and ignored.
				mergedCustomFormats.push({
					trashId: latestCF.trash_id,
					name: latestCF.name,
					// score field intentionally omitted - deployment uses originalConfig.trash_scores
					scoreOverride: finalScoreOverride,
					conditionsEnabled: newConditionsEnabled,
					originalConfig: latestCF,
					// Preserve existing origin, or default to trash_sync for legacy CFs
					origin: currentCF.origin || "trash_sync",
					addedAt: currentCF.addedAt,
					// Clear deprecation if CF is back in TRaSH (was re-added upstream)
					deprecated: undefined,
					deprecatedAt: undefined,
					deprecatedReason: undefined,
				});
			} else {
				// New CF from TRaSH Guides
				stats.customFormatsAdded++;

				// Initialize all conditions as enabled
				const conditionsEnabled: Record<string, boolean> = {};
				for (const spec of latestCF.specifications || []) {
					conditionsEnabled[spec.name] = true;
				}

				// For changelog: always record the recommended score from trash_scores
				// (This is the score that will be used during deployment)
				const changelogScore = recommendedScore;

				// Track added CF details for changelog
				stats.addedCFDetails.push({
					trashId: latestCF.trash_id,
					name: latestCF.name,
					score: changelogScore,
				});

				// Note: We intentionally don't set the 'score' field on template CFs.
				// Deployment reads scores from originalConfig.trash_scores, which is
				// the authoritative source. The scoreOverride field is for user overrides.
				mergedCustomFormats.push({
					trashId: latestCF.trash_id,
					name: latestCF.name,
					// score field intentionally omitted - deployment uses originalConfig.trash_scores
					scoreOverride: undefined,
					conditionsEnabled,
					originalConfig: latestCF,
					// New CFs from sync get trash_sync origin
					origin: "trash_sync",
					addedAt: new Date().toISOString(),
				});
			}
		}

		// Handle CFs no longer in TRaSH Guides
		// Behavior depends on deleteRemovedCFs option and CF origin
		const deleteRemovedCFs = scoreOptions?.deleteRemovedCFs ?? false;
		const commitHash = scoreOptions?.targetCommitHash || "unknown";

		for (const [trashId, currentCF] of currentCFMap) {
			if (!latestCFMap.has(trashId)) {
				const cfOrigin = currentCF.origin || "trash_sync"; // Legacy CFs treated as trash_sync
				const isUserAdded = cfOrigin === "user_added";
				const deprecationReason = `No longer in TRaSH Guides as of commit ${commitHash}`;

				// User-added CFs are NEVER deleted, only marked deprecated
				// trash_sync CFs are deleted only if deleteRemovedCFs is true
				if (isUserAdded || !deleteRemovedCFs) {
					// Keep CF but mark as deprecated
					stats.customFormatsDeprecated++;
					stats.deprecatedCFDetails.push({
						trashId,
						name: currentCF.name,
						reason: deprecationReason,
					});

					// Only add warning if this is newly deprecated (wasn't already deprecated)
					if (!currentCF.deprecated) {
						warnings.push(
							`Custom format "${currentCF.name}" (${trashId}) marked deprecated - ${deprecationReason}`,
						);
					}

					// Add to merged list with deprecation flag
					mergedCustomFormats.push({
						...currentCF,
						deprecated: true,
						deprecatedAt: currentCF.deprecatedAt || new Date().toISOString(),
						deprecatedReason: deprecationReason,
					});
				} else {
					// Delete the CF (only trash_sync with deleteRemovedCFs=true)
					stats.customFormatsRemoved++;
					stats.removedCFDetails.push({
						trashId,
						name: currentCF.name,
					});
					warnings.push(
						`Custom format "${currentCF.name}" (${trashId}) removed - ${deprecationReason}`,
					);
				}
			}
		}

		// Merge Custom Format Groups
		const mergedCustomFormatGroups: TemplateCustomFormatGroup[] = [];

		for (const [trashId, latestGroup] of latestGroupMap) {
			const currentGroup = currentGroupMap.get(trashId);

			if (currentGroup) {
				// Existing group - preserve enabled state, update originalConfig
				const specsChanged = !deepEqual(currentGroup.originalConfig ?? null, latestGroup ?? null);

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
					// Preserve origin, clear deprecation if back in TRaSH
					origin: currentGroup.origin || "trash_sync",
					addedAt: currentGroup.addedAt,
					deprecated: undefined,
					deprecatedAt: undefined,
					deprecatedReason: undefined,
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
					origin: "trash_sync",
					addedAt: new Date().toISOString(),
				});
			}
		}

		// Handle groups no longer in TRaSH Guides
		for (const [trashId, currentGroup] of currentGroupMap) {
			if (!latestGroupMap.has(trashId)) {
				const groupOrigin = currentGroup.origin || "trash_sync";
				const isUserAdded = groupOrigin === "user_added";
				const deprecationReason = `No longer in TRaSH Guides as of commit ${commitHash}`;

				if (isUserAdded || !deleteRemovedCFs) {
					// Keep group but mark as deprecated
					stats.customFormatGroupsDeprecated++;

					if (!currentGroup.deprecated) {
						warnings.push(
							`Custom format group "${currentGroup.name}" (${trashId}) marked deprecated - ${deprecationReason}`,
						);
					}

					mergedCustomFormatGroups.push({
						...currentGroup,
						deprecated: true,
						deprecatedAt: currentGroup.deprecatedAt || new Date().toISOString(),
						deprecatedReason: deprecationReason,
					});
				} else {
					// Delete the group
					stats.customFormatGroupsRemoved++;
					warnings.push(
						`Custom format group "${currentGroup.name}" (${trashId}) removed - ${deprecationReason}`,
					);
				}
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
			scoreConflicts,
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
	 * Process automatic updates for templates with auto-sync enabled.
	 *
	 * Sync strategy behavior:
	 * - Auto-sync includes new CFs from linked Quality Profile automatically
	 * - Auto-sync does NOT include new CFs from CF Groups (those need user approval)
	 * - Templates with pending CF Group additions are excluded from auto-sync
	 *
	 * Also triggers automatic deployment to mapped instances after successful sync.
	 */
	async processAutoUpdates(userId: string): Promise<{
		processed: number;
		successful: number;
		failed: number;
		results: SyncResult[];
		skippedForApproval: number;
		templatesWithScoreConflicts: number;
	}> {
		const updateCheck = await this.checkForUpdates(userId);

		// Filter templates eligible for auto-sync
		// Note: canAutoSync is false when needsApproval is true (CF Group additions need approval)
		const autoSyncTemplates = updateCheck.templatesWithUpdates.filter((t) => t.canAutoSync);

		// Count templates that were skipped because they need approval
		const skippedForApproval = updateCheck.templatesWithUpdates.filter(
			(t) => t.needsApproval && t.autoSyncInstanceCount > 0,
		).length;

		const results: SyncResult[] = [];
		let successful = 0;
		let failed = 0;
		let templatesWithScoreConflicts = 0;

		for (const template of autoSyncTemplates) {
			// Auto-sync includes:
			// - Quality Profile CFs automatically
			// - Score updates from trash_scores (respects user overrides)
			// CF Group additions require user approval and won't be included
			const result = await this.syncTemplate(
				template.templateId,
				template.latestCommit,
				undefined, // userId - not needed for auto-sync, template ownership already verified
				{
					includeQualityProfileCFs: true, // Auto-add CFs from Quality Profile
					applyScoreUpdates: true, // Auto-apply scores from trash_scores
				},
			);

			results.push(result);

			if (result.success) {
				successful++;

				// Track templates that had score conflicts (user overrides preventing auto-update)
				if (result.scoreConflicts && result.scoreConflicts.length > 0) {
					templatesWithScoreConflicts++;
				}

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
						`Auto-deploy failed: ${error instanceof Error ? error.message : String(error)}`,
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
			skippedForApproval,
			templatesWithScoreConflicts,
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

		// Query the template to get the owner's userId for proper authorization
		const template = await this.prisma.trashTemplate.findUnique({
			where: { id: templateId },
			select: { userId: true, name: true },
		});

		if (!template) {
			console.error(`[TemplateUpdater] Cannot auto-deploy: template ${templateId} not found`);
			return;
		}

		// Get only instances mapped with auto sync strategy
		// Manual and notify strategies require user intervention
		const mappings = await this.prisma.templateQualityProfileMapping.findMany({
			where: {
				templateId,
				syncStrategy: "auto",
			},
			include: {
				instance: true,
			},
		});

		if (mappings.length === 0) {
			return; // No auto-sync instances mapped, nothing to deploy
		}

		// Deploy to each mapped instance using the template owner's userId
		for (const mapping of mappings) {
			try {
				const result = await this.deploymentExecutor.deploySingleInstance(
					templateId,
					mapping.instanceId,
					template.userId,
				);

				if (!result.success) {
					console.error(
						`[TemplateUpdater] Failed to auto-deploy template "${template.name}" (${templateId}) to instance ${mapping.instance.label}:`,
						result.errors,
					);
				}
			} catch (error) {
				console.error(
					`[TemplateUpdater] Error auto-deploying template "${template.name}" (${templateId}) to instance ${mapping.instanceId}:`,
					error instanceof Error ? error.message : error,
				);
				// Re-throw to make failures visible to callers
				throw error;
			}
		}
	}

	/**
	 * Get templates requiring user attention (not auto-synced or have user modifications)
	 */
	async getTemplatesNeedingAttention(userId: string): Promise<TemplateUpdateInfo[]> {
		const updateCheck = await this.checkForUpdates(userId);

		// Templates that can't auto-sync need user attention
		return updateCheck.templatesWithUpdates.filter((t) => !t.canAutoSync || t.hasUserModifications);
	}

	/**
	 * Get diff comparison between template's current config and latest TRaSH Guides
	 */
	async getTemplateDiff(
		templateId: string,
		targetCommitHash?: string,
		userId?: string,
	): Promise<TemplateDiffResult> {
		// First check if template exists at all
		const templateExists = await this.prisma.trashTemplate.findUnique({
			where: { id: templateId },
			select: { id: true, userId: true },
		});

		if (!templateExists) {
			throw new Error("Template not found");
		}

		// Verify ownership if userId is provided
		if (userId && templateExists.userId !== userId) {
			throw new Error("Not authorized to access this template");
		}

		// Get full template data
		const template = await this.prisma.trashTemplate.findUnique({
			where: { id: templateId },
		});

		if (!template) {
			throw new Error("Template not found");
		}

		// Determine target commit (default to latest)
		let targetCommit: VersionInfo;
		try {
			targetCommit = targetCommitHash
				? await this.versionTracker.getCommitInfo(targetCommitHash)
				: await this.versionTracker.getLatestCommit();
		} catch (error) {
			const context = targetCommitHash ? `commit ${targetCommitHash}` : "latest commit";
			const errorMsg = error instanceof Error ? error.message : String(error);
			console.error(`[TemplateUpdater] Failed to fetch ${context} for template diff: ${errorMsg}`);
			throw new Error(`Failed to fetch version info for ${context}: ${errorMsg}`);
		}

		const serviceType = template.serviceType as "RADARR" | "SONARR";

		// Check if template is already at the target version
		// If so, return historical changes from changelog instead of computing a diff
		if (template.trashGuidesCommitHash === targetCommit.commitHash) {
			// Template is up-to-date, look for historical sync data
			const recentAutoSync = this.getRecentAutoSyncEntry(
				template.changeLog,
				targetCommit.commitHash,
			);

			if (recentAutoSync) {
				// Transform changelog entry into TemplateDiffResult format
				return this.transformAutoSyncToHistoricalDiff(
					template,
					targetCommit.commitHash,
					recentAutoSync,
				);
			}

			// No changelog entry found - return empty diff with metadata
			return {
				templateId,
				templateName: template.name,
				currentCommit: template.trashGuidesCommitHash,
				latestCommit: targetCommit.commitHash,
				summary: {
					totalChanges: 0,
					addedCFs: 0,
					removedCFs: 0,
					modifiedCFs: 0,
					unchangedCFs: 0,
				},
				customFormatDiffs: [],
				customFormatGroupDiffs: [],
				hasUserModifications: template.hasUserModifications,
				isHistorical: true,
			};
		}

		// Validate cache commit matches target to ensure accurate diff
		// If cache is stale, auto-refresh the required caches before computing diff
		const cacheCommitHash = await this.cacheManager.getCommitHash(serviceType, "CUSTOM_FORMATS");
		if (!cacheCommitHash || cacheCommitHash !== targetCommit.commitHash) {
			// Cache is stale or empty - refresh the caches needed for diff computation
			const requiredCacheTypes: TrashConfigType[] = [
				"CUSTOM_FORMATS",
				"CF_GROUPS",
				"QUALITY_PROFILES",
			];

			for (const configType of requiredCacheTypes) {
				try {
					const data = await this.githubFetcher.fetchConfigs(serviceType, configType);
					await this.cacheManager.set(serviceType, configType, data, targetCommit.commitHash);
				} catch (fetchError) {
					const errorMsg = fetchError instanceof Error ? fetchError.message : String(fetchError);
					throw new Error(`Failed to refresh ${configType} cache for ${serviceType}: ${errorMsg}`);
				}
			}
		}

		// Get latest cache data for comparison
		const customFormatsCache = await this.cacheManager.get(serviceType, "CUSTOM_FORMATS");
		const cfGroupsCache = await this.cacheManager.get(serviceType, "CF_GROUPS");
		const qualityProfilesCache = await this.cacheManager.get(serviceType, "QUALITY_PROFILES");

		// Parse template config with error handling for corrupted data
		let templateConfig: {
			customFormats?: TemplateCustomFormat[];
			customFormatGroups?: TemplateCustomFormatGroup[];
			qualityProfile?: { trash_score_set?: string };
		} = {};
		try {
			templateConfig = JSON.parse(template.configData) as typeof templateConfig;
		} catch (parseError) {
			console.error(
				`Failed to parse configData for template "${template.name}" (id: ${template.id}): ${parseError instanceof Error ? parseError.message : "Unknown error"}`,
			);
			// Fall back to empty config - updater can continue with empty state
			templateConfig = {};
		}
		const currentCFs = new Map<string, TemplateCustomFormat>(
			templateConfig.customFormats?.map((cf) => [cf.trashId, cf]) || [],
		);
		const currentGroups = new Map<string, TemplateCustomFormatGroup>(
			templateConfig.customFormatGroups?.map((g) => [g.trashId, g]) || [],
		);

		// Extended CF type with trash_scores (actual TRaSH API data has this)
		type TrashCFWithScores = TrashCustomFormat & { trash_scores?: Record<string, number> };

		// Get the score set from template's linked quality profile
		const scoreSet = templateConfig.qualityProfile?.trash_score_set || "default";

		// Helper to get current score from template CF (mirrors deployment score resolution)
		// Priority order:
		// 1. scoreOverride - explicit user override (always wins)
		// 2. originalConfig.trash_scores[scoreSet] - TRaSH's authoritative score for this profile
		// 3. originalConfig.trash_scores.default - TRaSH's default score
		// 4. cf.score - only if no trash_scores exist (legacy templates)
		// 5. originalConfig.score - legacy score field
		// 6. 0 - final fallback
		const getCurrentScore = (cf: TemplateCustomFormat): number => {
			// Priority 1: User override (explicit scoreOverride always wins)
			if (cf.scoreOverride !== undefined) {
				return cf.scoreOverride;
			}

			// Priority 2-3: Score from originalConfig.trash_scores (authoritative TRaSH scores)
			const cfWithScores = cf.originalConfig as TrashCFWithScores | undefined;
			if (cfWithScores?.trash_scores) {
				if (scoreSet && cfWithScores.trash_scores[scoreSet] !== undefined) {
					return cfWithScores.trash_scores[scoreSet];
				}
				if (cfWithScores.trash_scores.default !== undefined) {
					return cfWithScores.trash_scores.default;
				}
			}

			// Priority 4: cf.score field (only for templates without trash_scores)
			if (cf.score !== undefined) {
				return cf.score;
			}

			// Priority 5: Legacy score field on originalConfig
			if (cf.originalConfig?.score !== undefined) {
				return cf.originalConfig.score;
			}

			// Final fallback
			return 0;
		};

		// Parse latest cache data (cache returns array directly, not wrapped in { data: T })
		const latestCFsData = (customFormatsCache as TrashCustomFormat[] | null) ?? [];
		const latestCFs = new Map<string, TrashCustomFormat>(
			latestCFsData.map((cf) => [cf.trash_id, cf]),
		);
		const latestGroupsData = (cfGroupsCache as TrashCustomFormatGroup[] | null) ?? [];
		const latestGroups = new Map<string, TrashCustomFormatGroup>(
			latestGroupsData.map((g) => [g.trash_id, g]),
		);

		// Compare Custom Formats
		// IMPORTANT: The diff should only show changes to CFs that are ALREADY in the template.
		// We don't show "added" CFs just because they're in a CF Group - the user explicitly
		// selected which CFs they want when creating the template. The diff shows:
		// - Modified: CFs in template whose specifications changed in TRaSH
		// - Removed: CFs in template that no longer exist in TRaSH
		// - Unchanged: CFs in template with no specification changes
		// We do NOT show new CFs from TRaSH as "added" - that would require user action to add them.
		const customFormatDiffs: CustomFormatDiff[] = [];
		const addedCFs = 0; // Always 0 - we suggest additions separately
		let removedCFs = 0;
		let modifiedCFs = 0;
		let unchangedCFs = 0;

		// Check for modified CFs (CFs in template that exist in latest TRaSH data)
		for (const [trashId, latestCF] of latestCFs) {
			const currentCF = currentCFs.get(trashId);

			// CF is not in the template - skip it entirely.
			// We don't show new CFs as "added" because the user explicitly chose
			// which CFs to include when creating the template. If they want new CFs,
			// they can edit the template to add them.
			if (!currentCF) {
				continue;
			}

			// CF exists, check for modifications
			// Use deepEqual for deterministic comparison (handles different key ordering)
			const currentSpecs = currentCF.originalConfig?.specifications ?? null;
			const latestSpecs = latestCF.specifications ?? null;
			const specificationsChanged = !deepEqual(currentSpecs, latestSpecs);

			// Get the effective score using the same logic as deployment
			const effectiveScore = getCurrentScore(currentCF);

			if (specificationsChanged) {
				customFormatDiffs.push({
					trashId,
					name: latestCF.name,
					changeType: "modified",
					currentScore: effectiveScore,
					newScore: effectiveScore, // Keep user's effective score
					currentSpecifications: currentCF.originalConfig?.specifications || [],
					newSpecifications: latestCF.specifications || [],
					hasSpecificationChanges: true,
				});
				modifiedCFs++;
			} else {
				customFormatDiffs.push({
					trashId,
					name: latestCF.name,
					changeType: "unchanged",
					currentScore: effectiveScore,
					newScore: effectiveScore,
					currentSpecifications: currentCF.originalConfig?.specifications || [],
					newSpecifications: latestCF.specifications || [],
					hasSpecificationChanges: false,
				});
				unchangedCFs++;
			}
		}

		// Check for removed CFs
		for (const [trashId, currentCF] of currentCFs) {
			if (!latestCFs.has(trashId)) {
				// Get the effective score using the same logic as deployment
				const effectiveScore = getCurrentScore(currentCF);
				customFormatDiffs.push({
					trashId,
					name: currentCF.name,
					changeType: "removed",
					currentScore: effectiveScore,
					currentSpecifications: currentCF.originalConfig?.specifications || [],
					hasSpecificationChanges: false,
				});
				removedCFs++;
			}
		}

		// Compare Custom Format Groups
		const customFormatGroupDiffs: CustomFormatGroupDiff[] = [];

		// Like CFs, we only show CF Groups that are already in the template.
		// We don't show new groups as "added" - the user explicitly chose which
		// groups to include when creating the template.
		for (const [trashId, latestGroup] of latestGroups) {
			const currentGroup = currentGroups.get(trashId);

			// CF Group is not in the template - skip it entirely.
			// We don't show new groups as "added" because the user explicitly chose
			// which groups to include when creating the template.
			if (!currentGroup) {
				continue;
			}

			// Simple comparison - just note if group exists
			customFormatGroupDiffs.push({
				trashId,
				name: latestGroup.name,
				changeType: "unchanged",
				customFormatDiffs: [],
			});
		}

		for (const [trashId, currentGroup] of currentGroups) {
			if (!latestGroups.has(trashId)) {
				customFormatGroupDiffs.push({
					trashId,
					name: currentGroup.name,
					changeType: "removed",
					customFormatDiffs: [],
				});
			}
		}

		// ============================================================================
		// Build Suggested Additions (Option 2)
		// These are shown separately from the main diff - user can opt to add them
		// ============================================================================
		const suggestedAdditions: SuggestedCFAddition[] = [];
		const suggestedScoreChanges: SuggestedScoreChange[] = [];

		// Helper to get recommended score for a CF (from latest TRaSH data)
		const getRecommendedScore = (cf: TrashCFWithScores): number => {
			if (cf.trash_scores) {
				if (scoreSet && cf.trash_scores[scoreSet] !== undefined) {
					return cf.trash_scores[scoreSet];
				}
				if (cf.trash_scores.default !== undefined) {
					return cf.trash_scores.default;
				}
			}
			return cf.score ?? 0;
		};

		// 1. Suggested additions from CF Groups
		// Find CFs that are in template's CF Groups but not in template's customFormats
		for (const [groupTrashId, templateGroup] of currentGroups) {
			const latestGroup = latestGroups.get(groupTrashId);
			if (!latestGroup?.custom_formats) continue;

			for (const cfRef of latestGroup.custom_formats) {
				const cfTrashId = typeof cfRef === "string" ? cfRef : (cfRef as GroupCustomFormat).trash_id;

				// Skip if CF is already in template
				if (currentCFs.has(cfTrashId)) continue;

				// Skip if already added to suggestions (avoid duplicates)
				if (suggestedAdditions.some((s) => s.trashId === cfTrashId)) continue;

				// Get the full CF data from cache
				const fullCF = latestCFs.get(cfTrashId) as TrashCFWithScores | undefined;
				if (!fullCF) continue;

				suggestedAdditions.push({
					trashId: cfTrashId,
					name: fullCF.name,
					recommendedScore: getRecommendedScore(fullCF),
					source: "cf_group",
					sourceGroupName: latestGroup.name,
					specifications: fullCF.specifications || [],
				});
			}
		}

		// 2. Suggested additions from Quality Profile
		// Find CFs that are in template's linked quality profile but not in template
		if (template.sourceQualityProfileTrashId) {
			const qualityProfilesData = (qualityProfilesCache as TrashQualityProfile[] | null) ?? [];
			const linkedProfile = qualityProfilesData.find(
				(p) => p.trash_id === template.sourceQualityProfileTrashId,
			);

			if (linkedProfile?.formatItems) {
				// formatItems maps CF name to trash_id
				for (const [cfName, cfTrashId] of Object.entries(linkedProfile.formatItems)) {
					// Skip if CF is already in template
					if (currentCFs.has(cfTrashId)) continue;

					// Skip if already added from CF Groups
					if (suggestedAdditions.some((s) => s.trashId === cfTrashId)) continue;

					// Get the full CF data from cache
					const fullCF = latestCFs.get(cfTrashId) as TrashCFWithScores | undefined;
					if (!fullCF) continue;

					suggestedAdditions.push({
						trashId: cfTrashId,
						name: fullCF.name,
						recommendedScore: getRecommendedScore(fullCF),
						source: "quality_profile",
						sourceProfileName: linkedProfile.name,
						specifications: fullCF.specifications || [],
					});
				}
			}
		}

		// 3. Suggested score changes
		// Find CFs in template where the recommended score differs from current score
		for (const [trashId, currentCF] of currentCFs) {
			const latestCF = latestCFs.get(trashId) as TrashCFWithScores | undefined;
			if (!latestCF) continue;

			const currentScore = getCurrentScore(currentCF);
			const recommendedScore = getRecommendedScore(latestCF);

			// Only suggest if scores differ and user hasn't set a manual override
			// (if they have a scoreOverride, they intentionally changed it)
			if (currentCF.scoreOverride === undefined && currentScore !== recommendedScore) {
				suggestedScoreChanges.push({
					trashId,
					name: latestCF.name,
					currentScore,
					recommendedScore,
					scoreSet,
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
			suggestedAdditions: suggestedAdditions.length > 0 ? suggestedAdditions : undefined,
			suggestedScoreChanges: suggestedScoreChanges.length > 0 ? suggestedScoreChanges : undefined,
		};
	}

	/**
	 * Transform an AutoSyncChangeLogEntry into a TemplateDiffResult for historical display.
	 * Used when template is already at the target version to show what changed in the last sync.
	 * @private
	 */
	private transformAutoSyncToHistoricalDiff(
		template: {
			id: string;
			name: string;
			hasUserModifications: boolean;
			trashGuidesCommitHash: string | null;
		},
		targetCommitHash: string,
		entry: AutoSyncChangeLogEntry,
	): TemplateDiffResult {
		// Transform added CFs to CustomFormatDiff
		const addedDiffs: CustomFormatDiff[] = entry.customFormatsAdded.map((cf) => ({
			trashId: cf.trashId,
			name: cf.name,
			changeType: "added" as const,
			newScore: cf.score,
			hasSpecificationChanges: true, // New CFs always have "new" specs
		}));

		// Transform removed CFs to CustomFormatDiff
		const removedDiffs: CustomFormatDiff[] = entry.customFormatsRemoved.map((cf) => ({
			trashId: cf.trashId,
			name: cf.name,
			changeType: "removed" as const,
			hasSpecificationChanges: false,
		}));

		// Transform updated CFs to CustomFormatDiff
		const updatedDiffs: CustomFormatDiff[] = entry.customFormatsUpdated.map((cf) => ({
			trashId: cf.trashId,
			name: cf.name,
			changeType: "modified" as const,
			hasSpecificationChanges: true,
		}));

		// Combine all diffs
		const customFormatDiffs: CustomFormatDiff[] = [...addedDiffs, ...removedDiffs, ...updatedDiffs];

		// Transform score changes to suggestedScoreChanges format for display
		// (These were already applied, but showing them helps the user understand what changed)
		const historicalScoreChanges: SuggestedScoreChange[] = entry.scoreChanges.map((sc) => ({
			trashId: sc.trashId,
			name: sc.name,
			currentScore: sc.newScore, // After sync, newScore is now current
			recommendedScore: sc.newScore, // Show what was applied
			scoreSet: "applied", // Indicate these were applied changes
		}));

		return {
			templateId: template.id,
			templateName: template.name,
			currentCommit: entry.fromCommitHash,
			latestCommit: targetCommitHash,
			summary: {
				totalChanges:
					entry.summaryStats.customFormatsAdded +
					entry.summaryStats.customFormatsRemoved +
					entry.summaryStats.customFormatsUpdated,
				addedCFs: entry.summaryStats.customFormatsAdded,
				removedCFs: entry.summaryStats.customFormatsRemoved,
				modifiedCFs: entry.summaryStats.customFormatsUpdated,
				unchangedCFs: entry.summaryStats.customFormatsPreserved,
			},
			customFormatDiffs,
			customFormatGroupDiffs: [], // CF Group changes not tracked in detail currently
			hasUserModifications: template.hasUserModifications,
			suggestedScoreChanges: historicalScoreChanges.length > 0 ? historicalScoreChanges : undefined,
			isHistorical: true,
			historicalSyncTimestamp: entry.timestamp,
		};
	}

	/**
	 * Get the most recent auto-sync changelog entry for a template.
	 * Optionally filter by a specific target commit hash.
	 *
	 * @param changeLogJson - The raw changeLog JSON string from the template
	 * @param targetCommitHash - Optional commit hash to match against toCommitHash
	 * @returns The most recent matching AutoSyncChangeLogEntry, or null if none found
	 * @private
	 */
	private getRecentAutoSyncEntry(
		changeLogJson: string | null,
		targetCommitHash?: string,
	): AutoSyncChangeLogEntry | null {
		if (!changeLogJson) {
			return null;
		}

		// Parse changelog with error handling
		let changeLog: unknown[];
		try {
			const parsed = JSON.parse(changeLogJson);
			changeLog = Array.isArray(parsed) ? parsed : [];
		} catch (parseError) {
			console.warn(
				`[TemplateUpdater] Failed to parse changeLog in getRecentAutoSyncEntry: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
			);
			return null;
		}

		// Filter to auto_sync entries
		const autoSyncEntries = changeLog.filter((entry): entry is AutoSyncChangeLogEntry =>
			this.isAutoSyncChangeLogEntry(entry),
		);

		if (autoSyncEntries.length === 0) {
			return null;
		}

		// Optionally filter by target commit hash
		let candidates = autoSyncEntries;
		if (targetCommitHash) {
			candidates = autoSyncEntries.filter((entry) => entry.toCommitHash === targetCommitHash);
		}

		if (candidates.length === 0) {
			return null;
		}

		// Sort by timestamp descending and return most recent
		candidates.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

		return candidates[0] ?? null;
	}

	/**
	 * Type guard to validate an entry matches AutoSyncChangeLogEntry interface structure.
	 * @private
	 */
	private isAutoSyncChangeLogEntry(entry: unknown): entry is AutoSyncChangeLogEntry {
		if (typeof entry !== "object" || entry === null) {
			return false;
		}

		const e = entry as Record<string, unknown>;

		// Check required fields
		if (e.changeType !== "auto_sync") {
			return false;
		}
		if (typeof e.timestamp !== "string") {
			return false;
		}
		if (typeof e.toCommitHash !== "string") {
			return false;
		}
		// fromCommitHash can be string or null
		if (e.fromCommitHash !== null && typeof e.fromCommitHash !== "string") {
			return false;
		}

		// Check arrays exist (don't need deep validation for display purposes)
		if (!Array.isArray(e.customFormatsAdded)) {
			return false;
		}
		if (!Array.isArray(e.customFormatsRemoved)) {
			return false;
		}
		if (!Array.isArray(e.customFormatsUpdated)) {
			return false;
		}
		if (!Array.isArray(e.scoreChanges)) {
			return false;
		}

		// Check summaryStats exists as object
		if (typeof e.summaryStats !== "object" || e.summaryStats === null) {
			return false;
		}

		return true;
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
			const currentCommitHash = await this.cacheManager.getCommitHash(serviceType, configType);

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
		let latestCommit: VersionInfo;
		try {
			latestCommit = await this.versionTracker.getLatestCommit();
		} catch (error) {
			const errorMsg = `[TemplateUpdater] Failed to fetch latest commit: ${error instanceof Error ? error.message : String(error)}`;
			errors.push(errorMsg);
			return { refreshed: 0, failed: configTypes.length, errors };
		}

		for (const configType of configTypes) {
			try {
				// Get current cache commit hash
				const currentCommitHash = await this.cacheManager.getCommitHash(serviceType, configType);

				// Skip data fetch if already up-to-date, but still touch the cache
				// to update lastCheckedAt so it doesn't show as "stale" in the UI
				if (currentCommitHash === latestCommit.commitHash) {
					await this.cacheManager.touchCache(serviceType, configType);
					continue;
				}

				// Fetch fresh data from GitHub
				const data = await this.githubFetcher.fetchConfigs(serviceType, configType);

				// Update cache with new data and commit hash
				await this.cacheManager.set(serviceType, configType, data, latestCommit.commitHash);

				refreshed++;
			} catch (error) {
				failed++;
				errors.push(`${configType}: ${error instanceof Error ? error.message : String(error)}`);
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
	return new TemplateUpdater(
		prisma,
		versionTracker,
		cacheManager,
		githubFetcher,
		deploymentExecutor,
	);
}
