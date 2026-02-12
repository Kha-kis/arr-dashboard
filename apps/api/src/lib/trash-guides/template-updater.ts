/**
 * TRaSH Guides Template Updater (Facade)
 *
 * Manages synchronization between TRaSH Guides GitHub repository and user templates.
 * Delegates heavy lifting to focused modules:
 *   - template-merger.ts   — merge/validate logic
 *   - template-differ.ts   — diff computation + historical diffs
 *   - template-score-utils.ts — score resolution helpers
 *
 * This file keeps the class shell, factory, and methods that are tightly coupled
 * to Prisma / class fields (detection, auto-sync orchestration, cache, deploy).
 */

import type {
	AutoSyncChangeLogEntry,
	GroupCustomFormat,
	TemplateConfig,
	TemplateDiffResult,
	TrashConfigType,
	TrashCustomFormat,
	TrashCustomFormatGroup,
	TrashQualityProfile,
} from "@arr/shared";
import type { PrismaClient } from "../../lib/prisma.js";
import type { TrashCacheManager } from "./cache-manager.js";
import type { DeploymentExecutorService } from "./deployment-executor.js";
import type { TrashGitHubFetcher } from "./github-fetcher.js";
import { TemplateNotFoundError } from "../errors.js";
import { getSyncMetrics } from "./sync-metrics.js";
import { computeTemplateDiff } from "./template-differ.js";
import { mergeTemplateConfig, validateMergedConfig } from "./template-merger.js";
import { getRecommendedScore, type TrashCFWithScores } from "./template-score-utils.js";
import type { VersionInfo, VersionTracker } from "./version-tracker.js";

// Re-export all types so callers importing from this file continue to work
export type {
	MergeResult,
	MergeStats,
	PendingCFGroupAddition,
	ScoreConflict,
	SyncResult,
	TemplateUpdateInfo,
	UpdateCheckResult,
} from "./template-updater-types.js";

import type {
	PendingCFGroupAddition,
	SyncResult,
	TemplateUpdateInfo,
	UpdateCheckResult,
} from "./template-updater-types.js";

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
				configData: true,
				changeLog: true,
				lastSyncedAt: true,
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

		const templatesWithUpdates: TemplateUpdateInfo[] = [];

		for (const template of templates) {
			if (!template.trashGuidesCommitHash) {
				continue;
			}

			if (template.trashGuidesCommitHash !== latestCommit.commitHash) {
				const autoSyncInstanceCount = template.qualityProfileMappings.filter(
					(m) => m.syncStrategy === "auto",
				).length;

				const canAutoSync = autoSyncInstanceCount > 0 && !template.hasUserModifications;
				const serviceType = template.serviceType as "RADARR" | "SONARR";

				let pendingCFGroupAdditions: PendingCFGroupAddition[] | undefined;
				let needsApproval = false;

				if (autoSyncInstanceCount > 0) {
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

					needsApproval = pendingCFGroupAdditions.length > 0;
				}

				templatesWithUpdates.push({
					templateId: template.id,
					templateName: template.name,
					currentCommit: template.trashGuidesCommitHash,
					latestCommit: latestCommit.commitHash,
					hasUserModifications: template.hasUserModifications,
					autoSyncInstanceCount,
					canAutoSync: canAutoSync && !needsApproval,
					serviceType,
					needsApproval,
					pendingCFGroupAdditions: pendingCFGroupAdditions?.length
						? pendingCFGroupAdditions
						: undefined,
				});
			} else {
				// Template is up-to-date — check if it was recently auto-synced
				const autoSyncInstanceCount = template.qualityProfileMappings.filter(
					(m) => m.syncStrategy === "auto",
				).length;

				if (autoSyncInstanceCount > 0 && template.lastSyncedAt) {
					const lastSyncedAt = template.lastSyncedAt;
					const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

					if (lastSyncedAt > twentyFourHoursAgo) {
						let hasRecentAutoSync = false;
						let lastAutoSyncTimestamp: string | undefined;

						if (template.changeLog) {
							try {
								const changelog = JSON.parse(template.changeLog) as Array<{
									changeType?: string;
									timestamp?: string;
									toCommitHash?: string;
								}>;
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
								hasRecentAutoSync = true;
								lastAutoSyncTimestamp = lastSyncedAt.toISOString();
							}
						} else {
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
								canAutoSync: false,
								serviceType,
								isRecentlyAutoSynced: true,
								lastAutoSyncTimestamp,
							});
						}
					}
				}
			}
		}

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

		let config: TemplateConfig;
		try {
			config = JSON.parse(configDataJson) as TemplateConfig;
		} catch {
			return pending;
		}

		const templateCFIds = new Set((config.customFormats || []).map((cf) => cf.trashId));
		const templateGroupIds = new Set((config.customFormatGroups || []).map((g) => g.trashId));
		const latestCFMap = new Map(latestCustomFormats.map((cf) => [cf.trash_id, cf]));
		const latestGroupMap = new Map(latestCFGroups.map((g) => [g.trash_id, g]));

		const scoreSet =
			(config.qualityProfile as { trash_score_set?: string } | undefined)?.trash_score_set ||
			"default";

		for (const groupTrashId of templateGroupIds) {
			const latestGroup = latestGroupMap.get(groupTrashId);
			if (!latestGroup?.custom_formats) continue;

			for (const cfRef of latestGroup.custom_formats) {
				const cfTrashId = typeof cfRef === "string" ? cfRef : (cfRef as GroupCustomFormat).trash_id;

				if (templateCFIds.has(cfTrashId)) continue;

				const fullCF = latestCFMap.get(cfTrashId) as TrashCFWithScores | undefined;
				if (!fullCF) continue;

				pending.push({
					trashId: cfTrashId,
					name: fullCF.name,
					groupName: latestGroup.name,
					groupTrashId: latestGroup.trash_id,
					recommendedScore: getRecommendedScore(fullCF, scoreSet),
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
		const metrics = getSyncMetrics();
		const completeMetrics = metrics.startOperation("template_update");

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

			const currentCFTrashIds = new Set(
				(currentConfig.customFormats || []).map((cf) => cf.trashId),
			);

			const qualityProfileCFIds = new Set<string>();
			if (options?.includeQualityProfileCFs && template.sourceQualityProfileTrashId) {
				const qualityProfilesCache = await this.cacheManager.get(serviceType, "QUALITY_PROFILES");
				const qualityProfilesData = (qualityProfilesCache as TrashQualityProfile[] | null) ?? [];
				const linkedProfile = qualityProfilesData.find(
					(p) => p.trash_id === template.sourceQualityProfileTrashId,
				);

				if (linkedProfile?.formatItems) {
					for (const cfTrashId of Object.values(linkedProfile.formatItems)) {
						qualityProfileCFIds.add(cfTrashId);
					}
				}
			}

			const filteredCustomFormats = fetchResult.customFormats.filter((cf) => {
				if (currentCFTrashIds.has(cf.trash_id)) {
					return true;
				}
				if (options?.includeQualityProfileCFs && qualityProfileCFIds.has(cf.trash_id)) {
					return true;
				}
				return false;
			});

			// Include user-added CFs that aren't in the TRaSH cache.
			// Without this, the merger would treat them as "removed from TRaSH" and deprecate them.
			// We synthesize TrashCustomFormat entries from their stored originalConfig so the merger
			// sees them as present in the latest data and preserves them.
			const filteredTrashIds = new Set(filteredCustomFormats.map((cf) => cf.trash_id));
			for (const cf of currentConfig.customFormats || []) {
				if (!filteredTrashIds.has(cf.trashId) && cf.originalConfig) {
					const config = cf.originalConfig;
					if (config.trash_id && config.name) {
						filteredCustomFormats.push(config as TrashCustomFormat);
					} else {
						console.warn(
							`[TemplateUpdater] Skipping CF "${cf.name}" (${cf.trashId}): ` +
							`originalConfig is missing required fields (trash_id or name)`,
						);
					}
				}
			}

			const currentGroupTrashIds = new Set(
				(currentConfig.customFormatGroups || []).map((g) => g.trashId),
			);
			const filteredCFGroups = fetchResult.customFormatGroups.filter((group) => {
				return currentGroupTrashIds.has(group.trash_id);
			});

			// Same treatment for groups: preserve user-added groups not in TRaSH cache
			const filteredGroupTrashIds = new Set(filteredCFGroups.map((g) => g.trash_id));
			for (const group of currentConfig.customFormatGroups || []) {
				if (!filteredGroupTrashIds.has(group.trashId) && group.originalConfig) {
					const config = group.originalConfig;
					if (config.trash_id && config.name) {
						filteredCFGroups.push(config as TrashCustomFormatGroup);
					} else {
						console.warn(
							`[TemplateUpdater] Skipping CF group "${group.name}" (${group.trashId}): ` +
							`originalConfig is missing required fields (trash_id or name)`,
						);
					}
				}
			}

			const templateQualityProfile = currentConfig.qualityProfile as
				| { trash_score_set?: string }
				| undefined;
			const scoreSet = templateQualityProfile?.trash_score_set || "default";

			const deleteRemovedCFs = currentConfig.syncSettings?.deleteRemovedCFs ?? false;

			// Delegate to extracted merger module
			const mergeResult = mergeTemplateConfig(
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

			// Delegate to extracted merger module
			const validationResult = validateMergedConfig(mergeResult.mergedConfig);
			if (!validationResult.valid) {
				return {
					success: false,
					templateId,
					previousCommit,
					newCommit: targetCommit.commitHash,
					errors: validationResult.errors,
				};
			}

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

			const updatedChangeLog = [...existingChangeLog, autoSyncChangeLogEntry];

			await this.prisma.trashTemplate.update({
				where: { id: templateId },
				data: {
					changeLog: JSON.stringify(updatedChangeLog),
					configData: JSON.stringify(mergeResult.mergedConfig),
					trashGuidesCommitHash: targetCommit.commitHash,
					lastSyncedAt: new Date(),
				},
			});

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
	 * Process automatic updates for templates with auto-sync enabled.
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

		const autoSyncTemplates = updateCheck.templatesWithUpdates.filter((t) => t.canAutoSync);

		const skippedForApproval = updateCheck.templatesWithUpdates.filter(
			(t) => t.needsApproval && t.autoSyncInstanceCount > 0,
		).length;

		const results: SyncResult[] = [];
		let successful = 0;
		let failed = 0;
		let templatesWithScoreConflicts = 0;

		for (const template of autoSyncTemplates) {
			const result = await this.syncTemplate(
				template.templateId,
				template.latestCommit,
				undefined,
				{
					includeQualityProfileCFs: true,
					applyScoreUpdates: true,
				},
			);

			results.push(result);

			if (result.success) {
				successful++;

				if (result.scoreConflicts && result.scoreConflicts.length > 0) {
					templatesWithScoreConflicts++;
				}

				try {
					await this.deployToMappedInstances(template.templateId);
				} catch (error) {
					console.error(`Auto-deploy failed for template ${template.templateId}:`, error);
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
		if (!this.deploymentExecutor) {
			return;
		}

		const template = await this.prisma.trashTemplate.findUnique({
			where: { id: templateId },
			select: { userId: true, name: true },
		});

		if (!template) {
			console.error(`[TemplateUpdater] Cannot auto-deploy: template ${templateId} not found`);
			return;
		}

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
			return;
		}

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
				throw error;
			}
		}
	}

	/**
	 * Get templates requiring user attention (not auto-synced or have user modifications)
	 */
	async getTemplatesNeedingAttention(userId: string): Promise<TemplateUpdateInfo[]> {
		const updateCheck = await this.checkForUpdates(userId);
		return updateCheck.templatesWithUpdates.filter((t) => !t.canAutoSync || t.hasUserModifications);
	}

	/**
	 * Get diff comparison between template's current config and latest TRaSH Guides.
	 * Delegates computation to the template-differ module.
	 */
	async getTemplateDiff(
		templateId: string,
		targetCommitHash?: string,
		userId?: string,
	): Promise<TemplateDiffResult> {
		// Auth + existence checks stay in the class (Prisma-dependent)
		const templateExists = await this.prisma.trashTemplate.findUnique({
			where: { id: templateId },
			select: { id: true, userId: true },
		});

		if (!templateExists) {
			throw new TemplateNotFoundError(templateId);
		}

		if (userId && templateExists.userId !== userId) {
			throw new TemplateNotFoundError(templateId);
		}

		const template = await this.prisma.trashTemplate.findUnique({
			where: { id: templateId },
		});

		if (!template) {
			throw new TemplateNotFoundError(templateId);
		}

		// Resolve target commit (version-tracker is class-owned)
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

		// Delegate diff computation to extracted module
		return computeTemplateDiff(
			{
				id: template.id,
				name: template.name,
				serviceType: template.serviceType,
				configData: template.configData,
				trashGuidesCommitHash: template.trashGuidesCommitHash,
				hasUserModifications: template.hasUserModifications,
				changeLog: template.changeLog,
				sourceQualityProfileTrashId: template.sourceQualityProfileTrashId,
			},
			targetCommit.commitHash,
			this.cacheManager,
			this.githubFetcher,
		);
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
			const latestCommit = await this.versionTracker.getLatestCommit();
			const currentCommitHash = await this.cacheManager.getCommitHash(serviceType, configType);
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
	 * Refresh all caches for a service type.
	 * This should be called by the scheduler to keep cache up-to-date.
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
				const currentCommitHash = await this.cacheManager.getCommitHash(serviceType, configType);

				if (currentCommitHash === latestCommit.commitHash) {
					await this.cacheManager.touchCache(serviceType, configType);
					continue;
				}

				const data = await this.githubFetcher.fetchConfigs(serviceType, configType);
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
