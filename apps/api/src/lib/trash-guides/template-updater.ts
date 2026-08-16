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
import { z } from "zod";
import type { PrismaClient } from "../../lib/prisma.js";
import { TemplateNotFoundError } from "../errors.js";
import { loggers } from "../logger.js";
import { CacheCorruptionError, type TrashCacheManager } from "./cache-manager.js";
import type { DeploymentExecutorService } from "./deployment-executor.js";
import {
	assertEquivalentDeploymentMappingAuthority,
	createAutomationCatchUpTemplateStateToken,
	createDeploymentConnectionBindingCandidates,
	createUpstreamResourceStateToken,
} from "./deployment-target.js";
import type { TrashGitHubFetcher } from "./github-fetcher.js";
import { trashCustomFormatGroupSchema, trashCustomFormatSchema } from "./github-schemas.js";

const log = loggers.trashGuides;

import { getSyncMetrics } from "./sync-metrics.js";
import { computeTemplateDiff } from "./template-differ.js";
import { mergeTemplateConfig, validateMergedConfig } from "./template-merger.js";
import { withTrashTemplateMutationGuard } from "./template-mutation-guard.js";
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

import { getErrorMessage } from "../utils/error-message.js";
import type {
	PendingCFGroupAddition,
	SyncResult,
	TemplateUpdateInfo,
	UpdateCheckResult,
} from "./template-updater-types.js";

interface AutomationDeploymentOutcome {
	endpointKey: string;
	instanceId: string;
	instanceLabel: string;
	success: boolean;
	status: "SUCCESS" | "FAILED" | "UNCERTAIN";
	errors: string[];
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
			log.error({ err: error }, "Failed to get latest commit from GitHub");
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
				sourceQualityProfileTrashId: true,
				trashGuidesCommitHash: true,
				hasUserModifications: true,
				configData: true,
				instanceOverrides: true,
				changeLog: true,
				lastSyncedAt: true,
				qualityProfileMappings: {
					select: {
						syncStrategy: true,
						lastSyncedAt: true,
						instance: {
							select: { enabled: true },
						},
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
			const autoSyncInstanceCount = template.qualityProfileMappings.filter(
				(mapping) => mapping.syncStrategy === "auto",
			).length;

			// A transient version lookup during a known TRaSH profile import can leave an
			// explicitly auto-synced template without its initial commit. Custom, duplicated,
			// and JSON-imported templates have no TRaSH profile identity and remain untracked.
			if (
				!template.trashGuidesCommitHash &&
				(!template.sourceQualityProfileTrashId || autoSyncInstanceCount === 0)
			) {
				continue;
			}

			if (template.trashGuidesCommitHash !== latestCommit.commitHash) {
				const canAutoSync = autoSyncInstanceCount > 0 && !template.hasUserModifications;
				const serviceType = template.serviceType as "RADARR" | "SONARR";

				let pendingCFGroupAdditions: PendingCFGroupAddition[] | undefined;
				let needsApproval = false;

				if (autoSyncInstanceCount > 0) {
					if (!cacheByServiceType.has(serviceType)) {
						try {
							const [cfGroups, customFormats] = await Promise.all([
								this.cacheManager.get<TrashCustomFormatGroup[]>(
									serviceType,
									"CF_GROUPS",
									z.array(trashCustomFormatGroupSchema),
								),
								this.cacheManager.get<TrashCustomFormat[]>(
									serviceType,
									"CUSTOM_FORMATS",
									z.array(trashCustomFormatSchema),
								),
							]);
							cacheByServiceType.set(serviceType, {
								cfGroups: cfGroups ?? [],
								customFormats: customFormats ?? [],
							});
						} catch (error) {
							if (!(error instanceof CacheCorruptionError)) throw error;
							cacheByServiceType.set(serviceType, {
								cfGroups: [],
								customFormats: [],
							});
						}
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
					...(canAutoSync && !needsApproval
						? { automationStateToken: createAutomationCatchUpTemplateStateToken(template) }
						: {}),
				});
			} else {
				const autoMappings = template.qualityProfileMappings.filter(
					(mapping) => mapping.syncStrategy === "auto",
				);
				const pendingEnabledDeployments = template.lastSyncedAt
					? autoMappings.filter(
							(mapping) =>
								mapping.instance.enabled && mapping.lastSyncedAt < template.lastSyncedAt!,
						)
					: [];

				if (pendingEnabledDeployments.length > 0) {
					templatesWithUpdates.push({
						templateId: template.id,
						templateName: template.name,
						currentCommit: template.trashGuidesCommitHash,
						latestCommit: latestCommit.commitHash,
						hasUserModifications: template.hasUserModifications,
						autoSyncInstanceCount,
						canAutoSync: !template.hasUserModifications,
						serviceType: template.serviceType as "RADARR" | "SONARR",
						deploymentCatchUp: true,
					});
					continue;
				}

				// Template and every enabled auto target are up-to-date — surface a recent sync.
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
		} catch (err) {
			log.warn({ err }, "Corrupt configDataJson, skipping CF group detection");
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
			expectedAutomationStateToken?: string;
		},
	): Promise<SyncResult> {
		const owner = await this.prisma.trashTemplate.findUnique({
			where: { id: templateId, deletedAt: null },
			select: { userId: true },
		});
		if (!owner) {
			return {
				success: false,
				templateId,
				previousCommit: null,
				newCommit: targetCommitHash ?? "",
				errors: ["Template not found"],
				errorType: "not_found",
			};
		}
		if (userId && owner.userId !== userId) {
			return {
				success: false,
				templateId,
				previousCommit: null,
				newCommit: targetCommitHash ?? "",
				errors: ["Not authorized to modify this template"],
				errorType: "not_authorized",
			};
		}
		return withTrashTemplateMutationGuard(owner.userId, () =>
			this.syncTemplateUnlocked(templateId, targetCommitHash, userId, options),
		);
	}

	private async syncTemplateUnlocked(
		templateId: string,
		targetCommitHash?: string,
		userId?: string,
		options?: {
			includeQualityProfileCFs?: boolean;
			applyScoreUpdates?: boolean;
			expectedAutomationStateToken?: string;
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

		if (options?.expectedAutomationStateToken) {
			const autoMapping = await this.prisma.templateQualityProfileMapping.findFirst({
				where: { templateId, syncStrategy: "auto" },
				select: { id: true },
			});
			if (
				!userId ||
				template.userId !== userId ||
				template.deletedAt ||
				template.hasUserModifications ||
				(!template.trashGuidesCommitHash && !template.sourceQualityProfileTrashId) ||
				!autoMapping ||
				createAutomationCatchUpTemplateStateToken(template) !== options.expectedAutomationStateToken
			) {
				completeMetrics().recordFailure("Automatic sync authority changed");
				return {
					success: false,
					templateId,
					previousCommit: template.trashGuidesCommitHash,
					newCommit: targetCommitHash || "",
					errors: [
						"Automatic sync is no longer authorized because the template or Auto mapping changed after selection.",
					],
					errorType: "sync_failed",
				};
			}
		}

		let targetCommit: VersionInfo;
		try {
			targetCommit = targetCommitHash
				? await this.versionTracker.getCommitInfo(targetCommitHash)
				: await this.versionTracker.getLatestCommit();
		} catch (error) {
			const errorMsg = `Failed to get commit info from GitHub: ${getErrorMessage(error)}`;
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
				log.warn({ err: parseError, templateId }, "Failed to parse configData for template");
			}

			let fetchResult = await this.fetchLatestTrashData(serviceType);
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
				log.info(
					{
						cacheCommit: fetchResult.cacheCommitHash,
						targetCommit: targetCommit.commitHash,
						templateId,
						serviceType,
					},
					"Cache/version mismatch — auto-refreshing cache",
				);

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
						return {
							success: false,
							templateId,
							previousCommit,
							newCommit: targetCommit.commitHash,
							errors: [
								`Failed to refresh ${configType} cache for ${serviceType}: ${getErrorMessage(fetchError)}`,
							],
							errorType: "sync_failed" as const,
						};
					}
				}

				fetchResult = await this.fetchLatestTrashData(serviceType);
				if (!fetchResult.success) {
					return {
						success: false,
						templateId,
						previousCommit,
						newCommit: targetCommit.commitHash,
						errors: [`Failed to fetch TRaSH data after cache refresh: ${fetchResult.error}`],
						errorType: "sync_failed",
					};
				}
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
						log.warn(
							{ cfName: cf.name, trashId: cf.trashId },
							"Skipping CF: originalConfig is missing required fields (trash_id or name)",
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
						log.warn(
							{ groupName: group.name, trashId: group.trashId },
							"Skipping CF group: originalConfig is missing required fields (trash_id or name)",
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
					log.warn(
						{ err: parseError, templateId },
						"Failed to parse changeLog for template, resetting to empty array",
					);
					existingChangeLog = [];
				}
			}

			const updatedChangeLog = [...existingChangeLog, autoSyncChangeLogEntry];

			const syncedAt = new Date();
			const syncedConfigData = JSON.stringify(mergeResult.mergedConfig);
			await this.prisma.trashTemplate.update({
				where: { id: templateId },
				data: {
					changeLog: JSON.stringify(updatedChangeLog),
					configData: syncedConfigData,
					trashGuidesCommitHash: targetCommit.commitHash,
					lastSyncedAt: syncedAt,
				},
			});

			const metricsResult = completeMetrics();
			metricsResult.recordSuccess();

			return {
				success: true,
				templateId,
				previousCommit,
				newCommit: targetCommit.commitHash,
				automationStateToken: options?.expectedAutomationStateToken
					? createAutomationCatchUpTemplateStateToken({
							configData: syncedConfigData,
							instanceOverrides: template.instanceOverrides,
							trashGuidesCommitHash: targetCommit.commitHash,
							lastSyncedAt: syncedAt,
							hasUserModifications: template.hasUserModifications,
						})
					: undefined,
				mergeStats: mergeResult.stats,
				scoreConflicts:
					mergeResult.scoreConflicts.length > 0 ? mergeResult.scoreConflicts : undefined,
			};
		} catch (error) {
			const errorMessage = getErrorMessage(error);
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
				this.cacheManager.get<TrashCustomFormat[]>(
					serviceType,
					"CUSTOM_FORMATS",
					z.array(trashCustomFormatSchema),
				),
				this.cacheManager.get<TrashCustomFormatGroup[]>(
					serviceType,
					"CF_GROUPS",
					z.array(trashCustomFormatGroupSchema),
				),
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
				error: getErrorMessage(error),
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
		uncertain: number;
		uncertainDeployments: AutomationDeploymentOutcome[];
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
		let uncertain = 0;
		const uncertainDeployments: AutomationDeploymentOutcome[] = [];
		let templatesWithScoreConflicts = 0;

		for (const template of autoSyncTemplates) {
			if (!template.deploymentCatchUp && !template.automationStateToken) {
				results.push({
					success: false,
					templateId: template.templateId,
					previousCommit: template.currentCommit,
					newCommit: template.latestCommit,
					errors: ["Automatic sync selection is missing its required template authority."],
					errorType: "sync_failed",
				});
				failed++;
				continue;
			}
			const result: SyncResult = template.deploymentCatchUp
				? {
						success: true,
						templateId: template.templateId,
						previousCommit: template.currentCommit,
						newCommit: template.latestCommit,
					}
				: await this.syncTemplate(template.templateId, template.latestCommit, userId, {
						includeQualityProfileCFs: true,
						applyScoreUpdates: true,
						expectedAutomationStateToken: template.automationStateToken,
					});

			results.push(result);

			if (result.success) {
				if (!template.deploymentCatchUp && !result.automationStateToken) {
					result.success = false;
					result.errors = [
						...(result.errors ?? []),
						"Automatic deployment is missing the post-sync template authority token.",
					];
					failed++;
					continue;
				}
				if (result.scoreConflicts && result.scoreConflicts.length > 0) {
					templatesWithScoreConflicts++;
				}

				try {
					const deploymentOutcomes = template.deploymentCatchUp
						? await this.deployToMappedInstances(template.templateId, true)
						: await this.deployToMappedInstances(
								template.templateId,
								false,
								result.automationStateToken,
							);
					const failedDeployments = deploymentOutcomes.filter(
						(outcome) => outcome.status === "FAILED",
					);
					const uncertainOutcomes = deploymentOutcomes.filter(
						(outcome) => outcome.status === "UNCERTAIN",
					);
					if (uncertainOutcomes.length > 0) {
						uncertain++;
						uncertainDeployments.push(...uncertainOutcomes);
					}
					if (failedDeployments.length > 0) {
						const deploymentErrors = failedDeployments.flatMap((outcome) =>
							outcome.errors.length > 0
								? outcome.errors
								: [`Auto-deploy to "${outcome.instanceLabel}" failed without an error message.`],
						);
						result.success = false;
						result.errors = [
							...(result.errors ?? []),
							...deploymentErrors,
							...uncertainOutcomes.flatMap((outcome) => outcome.errors),
						];
						failed++;
					} else if (uncertainOutcomes.length > 0) {
						result.success = false;
						result.errors = [
							...(result.errors ?? []),
							...uncertainOutcomes.flatMap((outcome) => outcome.errors),
						];
					} else {
						successful++;
					}
				} catch (error) {
					log.error(
						{ err: error, templateId: template.templateId },
						"Auto-deploy failed for template",
					);
					result.success = false;
					result.errors = [
						...(result.errors ?? []),
						`Auto-deploy failed before endpoint execution: ${getErrorMessage(error)}`,
					];
					failed++;
				}
			} else {
				failed++;
			}
		}

		return {
			processed: autoSyncTemplates.length,
			successful,
			failed,
			uncertain,
			uncertainDeployments,
			results,
			skippedForApproval,
			templatesWithScoreConflicts,
		};
	}

	/**
	 * Deploy template to all mapped instances
	 * @private
	 */
	private async deployToMappedInstances(
		templateId: string,
		catchUpOnly = false,
		expectedTemplateStateToken?: string,
	): Promise<AutomationDeploymentOutcome[]> {
		if (!this.deploymentExecutor) {
			return [];
		}

		const template = await this.prisma.trashTemplate.findUnique({
			where: { id: templateId },
			select: {
				userId: true,
				name: true,
				configData: true,
				instanceOverrides: true,
				trashGuidesCommitHash: true,
				lastSyncedAt: true,
				hasUserModifications: true,
			},
		});

		if (!template) {
			log.error({ templateId }, "Cannot auto-deploy: template not found");
			return [];
		}

		const candidateMappings = (
			await this.prisma.templateQualityProfileMapping.findMany({
				where: {
					templateId,
					syncStrategy: "auto",
				},
				include: {
					instance: true,
				},
			})
		).filter((mapping) => mapping.instance.enabled);
		if (candidateMappings.length === 0) {
			return [];
		}

		let instanceOverrides: Record<string, unknown> = {};
		let instanceOverridesError: string | undefined;
		try {
			const parsed = template.instanceOverrides ? JSON.parse(template.instanceOverrides) : {};
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error("instance overrides must be an object");
			}
			instanceOverrides = parsed as Record<string, unknown>;
		} catch (error) {
			instanceOverridesError = `Automatic deployment blocked because the template's instance overrides could not be validated: ${getErrorMessage(error)}`;
			log.error({ err: error, templateId }, "Auto-deploy blocked by invalid instance overrides");
		}

		const endpointMappings = new Map<string, typeof candidateMappings>();
		for (const mapping of candidateMappings) {
			const endpointKey = this.deploymentExecutor.createEndpointMutationKey(
				template.userId,
				mapping.instance,
			);
			const grouped = endpointMappings.get(endpointKey) ?? [];
			grouped.push(mapping);
			endpointMappings.set(endpointKey, grouped);
		}

		const outcomes: AutomationDeploymentOutcome[] = [];
		for (const [endpointKey, endpointGroup] of [...endpointMappings.entries()].sort(
			([left], [right]) => left.localeCompare(right),
		)) {
			if (
				catchUpOnly &&
				(!template.lastSyncedAt ||
					!endpointGroup.some((mapping) => mapping.lastSyncedAt < template.lastSyncedAt!))
			) {
				continue;
			}
			const mapping = [...endpointGroup].sort((left, right) =>
				left.instanceId.localeCompare(right.instanceId),
			)[0]!;
			const outcomeTarget = {
				endpointKey,
				instanceId: mapping.instanceId,
				instanceLabel: mapping.instance.label,
			};
			if (instanceOverridesError) {
				outcomes.push({
					...outcomeTarget,
					success: false,
					status: "FAILED",
					errors: [instanceOverridesError],
				});
				continue;
			}
			const staleMappings = endpointGroup.filter(
				(candidate) =>
					!createDeploymentConnectionBindingCandidates(candidate.instance).some(
						(binding) =>
							binding.instanceId === candidate.instanceId &&
							binding.connectionGeneration === candidate.connectionGeneration &&
							binding.connectionStateToken === candidate.connectionStateToken,
					),
			);
			if (staleMappings.length > 0) {
				const error = `Auto-deploy to "${mapping.instance.label}" blocked: one or more mappings use a stale or legacy ARR connection binding. Unlink the stale deployment mapping and review a fresh preview.`;
				log.warn(
					{
						templateId,
						endpointKey,
						mappingIds: endpointGroup.map((candidate) => candidate.id),
						staleMappingIds: staleMappings.map((candidate) => candidate.id),
					},
					"Auto-deploy blocked for endpoint with a stale or legacy ARR mapping",
				);
				outcomes.push({ ...outcomeTarget, success: false, status: "FAILED", errors: [error] });
				continue;
			}
			if (new Set(endpointGroup.map((mapping) => mapping.qualityProfileId)).size > 1) {
				const error = `Auto-deploy to "${mapping.instance.label}" blocked: equivalent ARR aliases have conflicting quality profile mappings. Unlink the conflicting deployment mapping and review a fresh preview.`;
				log.error(
					{
						templateId,
						endpointKey,
						mappingIds: endpointGroup.map((mapping) => mapping.id),
					},
					"Auto-deploy blocked by conflicting alias mappings for one ARR endpoint",
				);
				outcomes.push({ ...outcomeTarget, success: false, status: "FAILED", errors: [error] });
				continue;
			}
			const invalidOverrideMapping = endpointGroup.find((candidate) => {
				const value = instanceOverrides[candidate.instanceId];
				return (
					value !== undefined &&
					value !== null &&
					(typeof value !== "object" || Array.isArray(value))
				);
			});
			if (invalidOverrideMapping) {
				const error = `Auto-deploy to "${mapping.instance.label}" blocked: instance overrides for ARR alias "${invalidOverrideMapping.instance.label}" are invalid. Review and save the template overrides before continuing.`;
				outcomes.push({ ...outcomeTarget, success: false, status: "FAILED", errors: [error] });
				continue;
			}
			const aliasOverrides = endpointGroup.map(
				(candidate) => instanceOverrides[candidate.instanceId] ?? {},
			);
			const overrideStates = new Set(
				aliasOverrides.map((value) => createUpstreamResourceStateToken(value)),
			);
			if (overrideStates.size > 1) {
				const error = `Auto-deploy to "${mapping.instance.label}" blocked: equivalent ARR aliases have conflicting instance overrides. Reconcile the per-instance Custom Format and quality settings before continuing.`;
				log.error(
					{
						templateId,
						endpointKey,
						mappingIds: endpointGroup.map((candidate) => candidate.id),
					},
					"Auto-deploy blocked by conflicting alias instance overrides",
				);
				outcomes.push({ ...outcomeTarget, success: false, status: "FAILED", errors: [error] });
				continue;
			}
			try {
				assertEquivalentDeploymentMappingAuthority(endpointGroup);
			} catch (error) {
				const message = `Auto-deploy to "${mapping.instance.label}" blocked: ${getErrorMessage(error)}`;
				log.error(
					{ err: error, templateId, endpointKey },
					"Auto-deploy blocked by conflicting alias deployment authority",
				);
				outcomes.push({ ...outcomeTarget, success: false, status: "FAILED", errors: [message] });
				continue;
			}
			if (endpointGroup.length > 1) {
				log.info(
					{
						templateId,
						instanceId: mapping.instanceId,
						deduplicatedMappingIds: endpointGroup.map((candidate) => candidate.id),
					},
					"Auto-deploy consolidated equivalent ARR instance mappings",
				);
			}
			try {
				const result = catchUpOnly
					? await this.deploymentExecutor.deploySingleInstanceFromAutomation(
							templateId,
							mapping.instanceId,
							template.userId,
							undefined,
							undefined,
							template.lastSyncedAt
								? createAutomationCatchUpTemplateStateToken(template)
								: undefined,
						)
					: expectedTemplateStateToken
						? await this.deploymentExecutor.deploySingleInstanceFromAutomation(
								templateId,
								mapping.instanceId,
								template.userId,
								undefined,
								undefined,
								expectedTemplateStateToken,
							)
						: await this.deploymentExecutor.deploySingleInstanceFromAutomation(
								templateId,
								mapping.instanceId,
								template.userId,
							);

				if (result.status === "UNCERTAIN") {
					const errors =
						result.errors.length > 0
							? result.errors.map(
									(error) => `Auto-deploy to "${mapping.instance.label}" needs review: ${error}`,
								)
							: [
									`Auto-deploy to "${mapping.instance.label}" needs review because ARR may have applied changes that could not be verified.`,
								];
					log.warn(
						{ templateId, instanceLabel: mapping.instance.label, errors: result.errors },
						"Auto-deploy result is uncertain and requires reconciliation",
					);
					outcomes.push({ ...outcomeTarget, success: false, status: "UNCERTAIN", errors });
				} else if (!result.success) {
					const errors =
						result.errors.length > 0
							? result.errors.map(
									(error) => `Auto-deploy to "${mapping.instance.label}" failed: ${error}`,
								)
							: [`Auto-deploy to "${mapping.instance.label}" failed without an error message.`];
					log.error(
						{
							templateId,
							templateName: template.name,
							instanceLabel: mapping.instance.label,
							errors: result.errors,
						},
						"Failed to auto-deploy template to instance",
					);
					outcomes.push({ ...outcomeTarget, success: false, status: "FAILED", errors });
				} else {
					outcomes.push({ ...outcomeTarget, success: true, status: "SUCCESS", errors: [] });
				}
			} catch (error) {
				const message = `Auto-deploy to "${mapping.instance.label}" failed: ${getErrorMessage(error)}`;
				log.error(
					{ err: error, templateId, templateName: template.name, instanceId: mapping.instanceId },
					"Error auto-deploying template to instance",
				);
				outcomes.push({ ...outcomeTarget, success: false, status: "FAILED", errors: [message] });
			}
		}

		return outcomes;
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
			const errorMsg = getErrorMessage(error);
			log.error({ err: error, context }, "Failed to fetch version info for template diff");
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
				error: getErrorMessage(error),
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
			"QUALITY_PROFILES",
			"CF_DESCRIPTIONS",
			"CONFLICTS",
		];

		let refreshed = 0;
		let failed = 0;
		const errors: string[] = [];

		let latestCommit: VersionInfo;
		try {
			latestCommit = await this.versionTracker.getLatestCommit();
		} catch (error) {
			const errorMsg = `[TemplateUpdater] Failed to fetch latest commit: ${getErrorMessage(error)}`;
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
				errors.push(`${configType}: ${getErrorMessage(error)}`);
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
