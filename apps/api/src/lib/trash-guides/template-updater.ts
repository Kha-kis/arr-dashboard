/**
 * TRaSH Guides Template Updater
 *
 * Manages synchronization between TRaSH Guides GitHub repository and user templates.
 * Detects when new versions are available and handles update logic based on user preferences.
 */

import { PrismaClient } from "@prisma/client";
import type { TrashConfigType } from "@arr/shared";
import type { VersionTracker, VersionInfo } from "./version-tracker.js";
import type { TrashCacheManager } from "./cache-manager.js";
import type { TrashGitHubFetcher } from "./github-fetcher.js";

// ============================================================================
// Types
// ============================================================================

export interface TemplateUpdateInfo {
	templateId: string;
	templateName: string;
	currentCommit: string | null;
	latestCommit: string;
	hasUserModifications: boolean;
	syncStrategy: "auto" | "manual" | "notify";
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
}

// ============================================================================
// Template Updater Class
// ============================================================================

export class TemplateUpdater {
	private prisma: PrismaClient;
	private versionTracker: VersionTracker;
	private cacheManager: TrashCacheManager;
	private githubFetcher: TrashGitHubFetcher;

	constructor(
		prisma: PrismaClient,
		versionTracker: VersionTracker,
		cacheManager: TrashCacheManager,
		githubFetcher: TrashGitHubFetcher,
	) {
		this.prisma = prisma;
		this.versionTracker = versionTracker;
		this.cacheManager = cacheManager;
		this.githubFetcher = githubFetcher;
	}

	/**
	 * Check for available updates across all templates
	 */
	async checkForUpdates(): Promise<UpdateCheckResult> {
		// Get latest commit from GitHub
		const latestCommit = await this.versionTracker.getLatestCommit();

		// Get all active templates
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
				syncStrategy: true,
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
				const canAutoSync =
					template.syncStrategy === "auto" && !template.hasUserModifications;

				templatesWithUpdates.push({
					templateId: template.id,
					templateName: template.name,
					currentCommit: template.trashGuidesCommitHash,
					latestCommit: latestCommit.commitHash,
					hasUserModifications: template.hasUserModifications,
					syncStrategy: template.syncStrategy as "auto" | "manual" | "notify",
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
	 * Sync a specific template to the latest TRaSH Guides version
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

		try {
			// Parse existing config data
			const configData = JSON.parse(template.configData);

			// Update template metadata
			await this.prisma.trashTemplate.update({
				where: { id: templateId },
				data: {
					trashGuidesCommitHash: targetCommit.commitHash,
					lastSyncedAt: new Date(),
					// Note: configData would be updated here with fetched data
					// This is a simplified version - actual implementation would
					// fetch new data from cache and merge with user customizations
				},
			});

			return {
				success: true,
				templateId,
				previousCommit,
				newCommit: targetCommit.commitHash,
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
	 * Process automatic updates for templates with auto-sync enabled
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
	 * Get templates requiring user attention (notify or manual strategy)
	 */
	async getTemplatesNeedingAttention(): Promise<TemplateUpdateInfo[]> {
		const updateCheck = await this.checkForUpdates();

		return updateCheck.templatesWithUpdates.filter(
			(t) => !t.canAutoSync && (t.syncStrategy === "notify" || t.hasUserModifications),
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

		// Parse template config
		const templateConfig = JSON.parse(template.configData);
		const currentCFs = new Map(
			templateConfig.customFormats?.map((cf: any) => [cf.trashId, cf]) || [],
		);
		const currentGroups = new Map(
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
				const specificationsChanged =
					JSON.stringify(currentCF.originalConfig?.specifications) !==
					JSON.stringify((latestCF as any).specifications);

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
	 * Update cache with latest TRaSH Guides data
	 */
	async updateCache(
		serviceType: "RADARR" | "SONARR",
		configType: TrashConfigType,
	): Promise<{ updated: boolean; error?: string }> {
		try {
			// Get latest commit
			const latestCommit = await this.versionTracker.getLatestCommit();

			// Get current cache commit hash
			const currentCommitHash = await this.cacheManager.getCommitHash(
				serviceType,
				configType,
			);

			// Only update if commit has changed
			if (currentCommitHash === latestCommit.commitHash) {
				return { updated: false };
			}

			// This method intentionally doesn't fetch data itself
			// The cache-manager and github-fetcher integration handles that
			// This is just a check to see if update is needed
			// Actual refresh happens via the cache refresh endpoint
			return { updated: false };
		} catch (error) {
			return {
				updated: false,
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

				// Skip if already up-to-date
				if (currentCommitHash === latestCommit.commitHash) {
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
): TemplateUpdater {
	return new TemplateUpdater(prisma, versionTracker, cacheManager, githubFetcher);
}
