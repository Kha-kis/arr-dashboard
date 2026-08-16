/**
 * TRaSH Guides Update Scheduler
 *
 * Background job scheduler for checking TRaSH Guides updates periodically.
 * Automatically syncs templates based on user preferences and notifies when manual review needed.
 */

import { createHash } from "node:crypto";
import {
	type NamingSelectedPresets,
	type NotificationEventType,
	TRASH_CONFIG_TYPES,
	type TrashNamingData,
	type TrashQualitySize,
	type TrashRepoConfig,
} from "@arr/shared";
import type { RadarrClient, SonarrClient } from "arr-sdk";
import type { PrismaClient } from "../../lib/prisma.js";
import type { ArrClientFactory } from "../arr/client-factory.js";
import { withCleanupOperationGuard } from "../library-cleanup/cleanup-maintenance-gate.js";
import { getErrorMessage } from "../utils/error-message.js";
import { createCacheManager } from "./cache-manager.js";
import { createTrashFetcher } from "./github-fetcher.js";
import { computeNamingHash, resolvePayload } from "./naming-deployer.js";
import { applyQualitySizeToDefinitions } from "./quality-size-matcher.js";
import type {
	ScoreConflict,
	SyncResult,
	TemplateUpdateInfo,
	TemplateUpdater,
} from "./template-updater.js";
import { createTemplateUpdater } from "./template-updater.js";
import { createVersionTracker, type VersionTracker } from "./version-tracker.js";

/**
 * Function that resolves the current repo config from the database.
 * Called on each scheduler tick so config changes take effect without restart.
 */
export type RepoConfigResolver = () => Promise<TrashRepoConfig>;

// ============================================================================
// Types
// ============================================================================

export interface SchedulerConfig {
	enabled: boolean;
	intervalHours: number; // How often to check for updates (default: 12 hours)
	logLevel?: "debug" | "info" | "warn" | "error";
}

export interface SchedulerStats {
	isRunning: boolean;
	lastCheckAt?: Date;
	nextCheckAt?: Date;
	lastCheckResult?: {
		templatesChecked: number;
		templatesOutdated: number;
		templatesAutoSynced: number;
		templatesWithAutoStrategy: number; // Total templates configured with "auto" sync strategy
		templatesWithNotifyStrategy: number; // Total templates configured with "notify" sync strategy
		templatesNeedingAttention: number;
		templatesNeedingApproval: number; // Templates with CF Group additions needing user approval
		templatesWithScoreConflicts: number; // Templates where score updates were skipped due to user overrides
		templatesWithUncertainDeployments: number;
		cachesRefreshed: number;
		cachesFailed: number;
		qualitySizeAutoSynced: number;
		qualitySizeUpdatesPending: number;
		namingAutoSynced: number;
		namingUpdatesPending: number;
		errors: string[];
	};
}

interface Logger {
	info: (objOrMsg: Record<string, unknown> | string, msg?: string) => void;
	warn: (objOrMsg: Record<string, unknown> | string, msg?: string) => void;
	error: (objOrMsg: Record<string, unknown> | string, msg?: string) => void;
	debug: (objOrMsg: Record<string, unknown> | string, msg?: string) => void;
}

// ============================================================================
// Update Scheduler Class
// ============================================================================

export class UpdateScheduler {
	private config: Required<SchedulerConfig>;
	private templateUpdater: TemplateUpdater;
	private versionTracker: VersionTracker;
	private prisma: PrismaClient;
	private logger: Logger;
	private arrClientFactory?: ArrClientFactory;
	private intervalId?: NodeJS.Timeout;
	private stats: SchedulerStats = { isRunning: false };
	private isCheckInProgress = false;

	// Lazy config resolution: rebuild repo-dependent services when config changes
	private repoConfigResolver?: RepoConfigResolver;
	private cachedRepoConfigKey?: string;
	private deploymentExecutor?: import("./deployment-executor.js").DeploymentExecutorService;
	private notifyFn?: (
		payload: import("../notifications/types.js").NotificationPayload,
		options?: { userId?: string; fallbackEventTypes?: NotificationEventType[] },
	) => Promise<void>;
	private trackTick: import("../scheduler-registry/scheduler-registry.js").TickWrapper;

	constructor(
		config: SchedulerConfig,
		templateUpdater: TemplateUpdater,
		versionTracker: VersionTracker,
		prisma: PrismaClient,
		logger: Logger,
		arrClientFactory?: ArrClientFactory,
		options?: {
			repoConfigResolver?: RepoConfigResolver;
			deploymentExecutor?: import("./deployment-executor.js").DeploymentExecutorService;
			notifyFn?: (
				payload: import("../notifications/types.js").NotificationPayload,
				options?: { userId?: string; fallbackEventTypes?: NotificationEventType[] },
			) => Promise<void>;
			trackTick?: import("../scheduler-registry/scheduler-registry.js").TickWrapper;
		},
	) {
		this.config = {
			enabled: config.enabled,
			intervalHours: config.intervalHours,
			logLevel: config.logLevel ?? "info",
		};
		this.templateUpdater = templateUpdater;
		this.versionTracker = versionTracker;
		this.prisma = prisma;
		this.logger = logger;
		this.arrClientFactory = arrClientFactory;
		this.repoConfigResolver = options?.repoConfigResolver;
		this.deploymentExecutor = options?.deploymentExecutor;
		this.notifyFn = options?.notifyFn;
		this.trackTick = options?.trackTick ?? (<T>(fn: () => Promise<T>) => fn());
	}

	/**
	 * Resolve the current repo config and rebuild services if it changed.
	 * Called at the start of each tick so settings changes take effect without restart.
	 */
	private async refreshRepoConfigIfNeeded(): Promise<void> {
		if (!this.repoConfigResolver) return;

		const repoConfig = await this.repoConfigResolver();
		const configKey = JSON.stringify(repoConfig);

		if (configKey === this.cachedRepoConfigKey) return;

		this.logger.info(
			{ repoOwner: repoConfig.owner, repoName: repoConfig.name, repoBranch: repoConfig.branch },
			"Repository configuration changed, rebuilding services",
		);

		const cacheManager = createCacheManager(this.prisma);
		this.versionTracker = createVersionTracker(repoConfig);
		// biome-ignore lint/suspicious/noExplicitAny: Logger interface is structurally compatible but nominally different
		const githubFetcher = createTrashFetcher({ repoConfig, logger: this.logger as any });
		this.templateUpdater = createTemplateUpdater(
			this.prisma,
			this.versionTracker,
			cacheManager,
			githubFetcher,
			this.deploymentExecutor,
		);

		this.cachedRepoConfigKey = configKey;
	}

	/**
	 * Start the scheduler
	 */
	start(): void {
		if (!this.config.enabled) {
			this.logger.info("TRaSH Guides update scheduler is disabled");
			return;
		}

		if (this.intervalId) {
			this.logger.warn("TRaSH Guides update scheduler already running");
			return;
		}

		this.logger.info(
			`Starting TRaSH Guides update scheduler (interval: ${this.config.intervalHours}h)`,
		);

		// Run immediately on start
		this.trackTick(() => this.checkForUpdates()).catch((error) => {
			this.logger.error(
				{ err: error instanceof Error ? error : new Error(String(error)) },
				"Initial update check failed",
			);
		});

		// Schedule periodic checks
		const intervalMs = this.config.intervalHours * 60 * 60 * 1000;
		this.intervalId = setInterval(() => {
			this.trackTick(() => this.checkForUpdates()).catch((error) => {
				this.logger.error(
					{ err: error instanceof Error ? error : new Error(String(error)) },
					"Scheduled update check failed",
				);
			});
		}, intervalMs);

		this.stats.isRunning = true;
		this.stats.nextCheckAt = new Date(Date.now() + intervalMs);

		this.logger.info("TRaSH Guides update scheduler started successfully");
	}

	/**
	 * Stop the scheduler
	 */
	stop(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
			this.stats.isRunning = false;
			this.stats.nextCheckAt = undefined;
			this.logger.info("TRaSH Guides update scheduler stopped");
		}
	}

	/**
	 * Get current scheduler statistics
	 */
	getStats(): SchedulerStats {
		return {
			...this.stats,
		};
	}

	/**
	 * Manually trigger an update check
	 */
	async triggerCheck(): Promise<void> {
		this.logger.info("Manual update check triggered");
		await this.checkForUpdates();
	}

	/**
	 * Check for updates and process them
	 */
	private async checkForUpdates(): Promise<void> {
		return withCleanupOperationGuard(() => this.checkForUpdatesGuarded());
	}

	private async checkForUpdatesGuarded(): Promise<void> {
		// Prevent concurrent checks
		if (this.isCheckInProgress) {
			this.logger.warn("Update check already in progress, skipping");
			return;
		}

		this.isCheckInProgress = true;
		try {
			await this.checkForUpdatesAttempt();
		} finally {
			this.isCheckInProgress = false;
		}
	}

	private async checkForUpdatesAttempt(): Promise<void> {
		const startTime = Date.now();
		const errors: string[] = [];
		let templatesAutoSynced = 0;
		let templatesNeedingAttention = 0;
		let templatesNeedingApproval = 0;
		let templatesWithScoreConflicts = 0;
		let templatesWithUncertainDeployments = 0;
		let qualitySizeAutoSynced = 0;
		let qualitySizeUpdatesPending = 0;
		let namingAutoSynced = 0;
		let namingUpdatesPending = 0;
		let templatesWithAutoStrategy = 0;
		let templatesWithNotifyStrategy = 0;

		try {
			// Re-read repo config and rebuild services if the user changed settings
			await this.refreshRepoConfigIfNeeded();

			this.logger.info("Checking for TRaSH Guides updates...");

			// Count templates by sync strategy (unique templates with at least one mapping of each type)
			[templatesWithAutoStrategy, templatesWithNotifyStrategy] = await Promise.all([
				this.prisma.trashTemplate.count({
					where: {
						deletedAt: null,
						OR: [
							{ trashGuidesCommitHash: { not: null } },
							{ sourceQualityProfileTrashId: { not: null } },
						],
						qualityProfileMappings: {
							some: {
								syncStrategy: "auto",
							},
						},
					},
				}),
				this.prisma.trashTemplate.count({
					where: {
						deletedAt: null,
						trashGuidesCommitHash: { not: null },
						qualityProfileMappings: {
							some: {
								syncStrategy: "notify",
							},
						},
					},
				}),
			]);

			// Get latest version info
			const latestCommit = await this.versionTracker.getLatestCommit();
			this.logger.debug(
				`Latest TRaSH commit: ${latestCommit.commitHash} (${latestCommit.commitDate})`,
			);

			// Refresh caches for both services
			this.logger.info("Refreshing TRaSH Guides caches...");
			const [radarrCacheResult, sonarrCacheResult] = await Promise.all([
				this.templateUpdater.refreshAllCaches("RADARR"),
				this.templateUpdater.refreshAllCaches("SONARR"),
			]);

			const totalCachesRefreshed = radarrCacheResult.refreshed + sonarrCacheResult.refreshed;
			const totalCacheFailed = radarrCacheResult.failed + sonarrCacheResult.failed;

			if (totalCachesRefreshed > 0) {
				this.logger.info(
					`Refreshed ${totalCachesRefreshed} cache entries (${totalCacheFailed} failed)`,
				);
			}

			if (radarrCacheResult.errors.length > 0) {
				errors.push(...radarrCacheResult.errors.map((e: string) => `Radarr: ${e}`));
			}
			if (sonarrCacheResult.errors.length > 0) {
				errors.push(...sonarrCacheResult.errors.map((e: string) => `Sonarr: ${e}`));
			}

			// Only service caches whose repository-and-commit provenance was verified
			// during this tick may authorize an upstream quality-size write.
			const verifiedQualitySizeData = new Map<"RADARR" | "SONARR", readonly TrashQualitySize[]>();
			if (radarrCacheResult.verifiedQualitySizeData) {
				verifiedQualitySizeData.set("RADARR", radarrCacheResult.verifiedQualitySizeData);
			}
			if (sonarrCacheResult.verifiedQualitySizeData) {
				verifiedQualitySizeData.set("SONARR", sonarrCacheResult.verifiedQualitySizeData);
			}

			// Process quality size auto-sync after caches are refreshed
			const qsResult = await this.processQualitySizeSync(verifiedQualitySizeData);
			qualitySizeAutoSynced = qsResult.autoSynced;
			qualitySizeUpdatesPending = qsResult.updatesPending;
			if (qsResult.errors.length > 0) {
				errors.push(...qsResult.errors);
			}

			// Process naming auto-sync after caches are refreshed
			const namingResult = await this.processNamingSync();
			namingAutoSynced = namingResult.autoSynced;
			namingUpdatesPending = namingResult.updatesPending;
			if (namingResult.errors.length > 0) {
				errors.push(...namingResult.errors);
			}

			// Get all distinct user IDs with templates to process updates per-user
			const templatesWithUsers = await this.prisma.trashTemplate.findMany({
				where: {
					deletedAt: null,
					OR: [
						{ trashGuidesCommitHash: { not: null } },
						{
							sourceQualityProfileTrashId: { not: null },
							qualityProfileMappings: { some: { syncStrategy: "auto" } },
						},
					],
				},
				select: { userId: true },
				distinct: ["userId"],
			});
			const usersWithTemplates = templatesWithUsers.map((t) => ({ id: t.userId }));

			let totalTemplatesChecked = 0;
			let totalOutdated = 0;

			// Process each user's templates
			for (const user of usersWithTemplates) {
				// Check for template updates for this user
				const updateCheck = await this.templateUpdater.checkForUpdates(user.id);
				totalTemplatesChecked += updateCheck.totalTemplates;
				totalOutdated += updateCheck.outdatedTemplates;

				if (updateCheck.outdatedTemplates > 0) {
					// Process auto-sync templates for this user
					const autoSyncResult = await this.templateUpdater.processAutoUpdates(user.id);
					templatesAutoSynced += autoSyncResult.successful;
					templatesNeedingApproval += autoSyncResult.skippedForApproval;
					templatesWithScoreConflicts += autoSyncResult.templatesWithScoreConflicts;
					templatesWithUncertainDeployments += autoSyncResult.uncertain;
					for (const outcome of autoSyncResult.uncertainDeployments) {
						this.notifyFn?.(
							{
								eventType: "TRASH_DEPLOY_UNCERTAIN",
								title: `Automatic TRaSH deployment needs review on ${outcome.instanceLabel}`,
								body: outcome.errors.join("; "),
								url: "/trash-guides",
								metadata: {
									instanceId: outcome.instanceId,
									endpointKey: outcome.endpointKey,
									reason: "uncertain_result",
								},
							},
							{ userId: user.id, fallbackEventTypes: ["TRASH_SYNC_ERROR"] },
						).catch((err) => {
							this.logger.debug({ err }, "Automatic deployment review notification failed");
						});
					}

					if (autoSyncResult.failed > 0) {
						const failedResults = autoSyncResult.results.filter((r: SyncResult) => !r.success);
						errors.push(...failedResults.flatMap((r: SyncResult) => r.errors || []));
					}

					// Create notifications for templates with score conflicts
					// (scores that couldn't be auto-updated due to user overrides)
					for (const result of autoSyncResult.results) {
						if (result.success && result.scoreConflicts && result.scoreConflicts.length > 0) {
							await this.createScoreConflictNotification(
								result.templateId,
								result.newCommit,
								result.scoreConflicts,
							);
						}
					}

					// Get templates needing user attention for this user
					const attentionTemplates = await this.templateUpdater.getTemplatesNeedingAttention(
						user.id,
					);
					templatesNeedingAttention += attentionTemplates.length;

					if (attentionTemplates.length > 0) {
						// Pass full TemplateUpdateInfo for enhanced notifications
						const templatesForNotification = updateCheck.templatesWithUpdates.filter((t) =>
							attentionTemplates.some((a) => a.templateId === t.templateId),
						);
						await this.createUpdateNotifications(templatesForNotification);
					}
				}
			}

			this.logger.info(`Found ${totalOutdated} outdated templates out of ${totalTemplatesChecked}`);

			if (totalOutdated === 0) {
				this.stats.lastCheckAt = new Date();
				this.stats.lastCheckResult = {
					templatesChecked: totalTemplatesChecked,
					templatesOutdated: 0,
					templatesAutoSynced: 0,
					templatesWithAutoStrategy,
					templatesWithNotifyStrategy,
					templatesNeedingAttention: 0,
					templatesNeedingApproval: 0,
					templatesWithScoreConflicts: 0,
					templatesWithUncertainDeployments: 0,
					cachesRefreshed: totalCachesRefreshed,
					cachesFailed: totalCacheFailed,
					qualitySizeAutoSynced,
					qualitySizeUpdatesPending,
					namingAutoSynced,
					namingUpdatesPending,
					errors: [],
				};
				// Calculate next check time
				const intervalMs = this.config.intervalHours * 60 * 60 * 1000;
				this.stats.nextCheckAt = new Date(Date.now() + intervalMs);
				return;
			}

			this.logger.info(`Auto-synced ${templatesAutoSynced} templates`);

			if (templatesNeedingAttention > 0) {
				this.logger.info(`${templatesNeedingAttention} templates need user attention`);
			}

			// Update statistics
			const duration = Date.now() - startTime;
			this.stats.lastCheckAt = new Date();
			this.stats.lastCheckResult = {
				templatesChecked: totalTemplatesChecked,
				templatesOutdated: totalOutdated,
				templatesAutoSynced,
				templatesWithAutoStrategy,
				templatesWithNotifyStrategy,
				templatesNeedingAttention,
				templatesNeedingApproval,
				templatesWithScoreConflicts,
				templatesWithUncertainDeployments,
				cachesRefreshed: totalCachesRefreshed,
				cachesFailed: totalCacheFailed,
				qualitySizeAutoSynced,
				qualitySizeUpdatesPending,
				namingAutoSynced,
				namingUpdatesPending,
				errors,
			};

			// Calculate next check time
			const intervalMs = this.config.intervalHours * 60 * 60 * 1000;
			this.stats.nextCheckAt = new Date(Date.now() + intervalMs);

			this.logger.info(
				`Update check completed in ${duration}ms. Next check at ${this.stats.nextCheckAt.toISOString()}`,
			);

			// Notify about auto-sync results
			if (templatesAutoSynced > 0) {
				this.notifyFn?.({
					eventType: "TRASH_PROFILE_UPDATED",
					title: `TRaSH Guides: ${templatesAutoSynced} template(s) auto-synced`,
					body: `${templatesAutoSynced} synced, ${templatesNeedingAttention} need attention, ${qualitySizeAutoSynced} quality sizes updated`,
					url: "/trash-guides",
					metadata: {
						templatesAutoSynced,
						templatesNeedingAttention,
						qualitySizeAutoSynced,
					},
				}).catch((err) => {
					this.logger.debug({ err }, "TRaSH sync notification dispatch failed");
				});
			}
		} catch (error) {
			this.logger.error(
				{ err: error instanceof Error ? error : new Error(String(error)) },
				"Update check failed",
			);
			errors.push(getErrorMessage(error));

			this.stats.lastCheckAt = new Date();
			this.stats.lastCheckResult = {
				templatesChecked: 0,
				templatesOutdated: 0,
				templatesAutoSynced: 0,
				templatesWithAutoStrategy,
				templatesWithNotifyStrategy,
				templatesNeedingAttention: 0,
				templatesNeedingApproval: 0,
				templatesWithScoreConflicts: 0,
				templatesWithUncertainDeployments: 0,
				cachesRefreshed: 0,
				cachesFailed: 0,
				qualitySizeAutoSynced: 0,
				qualitySizeUpdatesPending: 0,
				namingAutoSynced: 0,
				namingUpdatesPending: 0,
				errors,
			};

			// Calculate next check time
			const intervalMs = this.config.intervalHours * 60 * 60 * 1000;
			this.stats.nextCheckAt = new Date(Date.now() + intervalMs);

			// Notify about sync failure
			this.notifyFn?.({
				eventType: "TRASH_SYNC_ERROR",
				title: "TRaSH Guides sync failed",
				body: getErrorMessage(error),
				url: "/trash-guides",
			}).catch((err) => {
				this.logger.debug({ err }, "TRaSH sync error notification dispatch failed");
			});

			throw error;
		}
	}

	/**
	 * Process quality size auto-sync for instances with "auto" or "notify" strategy.
	 * Compares current preset hash to the stored appliedDataHash and applies changes
	 * for "auto" mappings, or counts pending updates for "notify" mappings.
	 */
	private async processQualitySizeSync(
		verifiedData: ReadonlyMap<"RADARR" | "SONARR", readonly TrashQualitySize[]>,
	): Promise<{
		autoSynced: number;
		updatesPending: number;
		errors: string[];
	}> {
		const result = { autoSynced: 0, updatesPending: 0, errors: [] as string[] };

		if (!this.arrClientFactory) {
			const mappingCount = await this.prisma.qualitySizeMapping.count({
				where: { syncStrategy: { in: ["auto", "notify"] } },
			});
			if (mappingCount > 0) {
				this.logger.warn(
					`${mappingCount} quality size mapping(s) with auto/notify strategy exist but arrClientFactory is not available — skipping sync`,
				);
			}
			return result;
		}

		const mappings = await this.prisma.qualitySizeMapping.findMany({
			where: {
				syncStrategy: { in: ["auto", "notify"] },
			},
			include: {
				instance: true,
			},
		});

		if (mappings.length === 0) return result;

		const warnedUnverifiedServiceTypes = new Set<"RADARR" | "SONARR">();

		for (const mapping of mappings) {
			try {
				const serviceType = mapping.serviceType as "RADARR" | "SONARR";
				const cached = verifiedData.get(serviceType);
				if (!cached) {
					if (!warnedUnverifiedServiceTypes.has(serviceType)) {
						warnedUnverifiedServiceTypes.add(serviceType);
						this.logger.warn(
							`Quality size cache provenance was not verified for ${serviceType} during this scheduler tick — skipping sync`,
						);
					}
					continue;
				}
				if (mapping.instance.service !== serviceType) {
					throw new Error(
						`Quality size mapping service type changed from ${serviceType} to ${mapping.instance.service}`,
					);
				}

				const preset = cached.find((p) => p.trash_id === mapping.presetTrashId);
				if (!preset) {
					result.errors.push(
						`Quality size preset "${mapping.presetTrashId}" no longer exists in ${mapping.serviceType} cache for instance ${mapping.instance.label}`,
					);
					this.logger.warn(
						`Quality size preset ${mapping.presetTrashId} not found in cache for ${mapping.serviceType} — preset may have been removed from TRaSH Guides`,
					);
					continue;
				}

				// Compute content hash and compare to stored hash
				const currentHash = createHash("sha256")
					.update(JSON.stringify(preset.qualities))
					.digest("hex");

				if (currentHash === mapping.appliedDataHash) {
					continue; // No changes — preset hasn't been updated
				}

				if (mapping.syncStrategy === "notify") {
					result.updatesPending++;
					continue;
				}

				// Re-resolve the target immediately before the destructive reset. A stale
				// mapping must never authorize data for a different service type.
				const liveInstance = await this.prisma.serviceInstance.findFirst({
					where: { id: mapping.instanceId, userId: mapping.instance.userId },
				});
				if (!liveInstance || liveInstance.service !== serviceType) {
					throw new Error(
						`Quality size mapping service type changed before execution for instance ${mapping.instance.label}`,
					);
				}
				if (!liveInstance.enabled) {
					this.logger.debug(
						`Skipping quality size sync for disabled instance ${liveInstance.label}`,
					);
					continue;
				}

				// Reset to factory defaults before applying (matches manual apply flow)
				const resetResponse = await this.arrClientFactory.rawRequest(
					liveInstance,
					"/api/v3/qualitydefinition/reset",
					{ method: "PUT" },
				);
				if (!resetResponse.ok) {
					throw new Error(
						`Failed to reset quality definitions: ${resetResponse.status} ${resetResponse.statusText}`,
					);
				}

				// Apply preset on top of factory defaults
				try {
					const client = this.arrClientFactory.create(liveInstance) as SonarrClient | RadarrClient;
					const definitions = await client.qualityDefinition.getAll();
					const { updated, appliedCount } = applyQualitySizeToDefinitions(
						preset.qualities,
						definitions,
					);

					// biome-ignore lint/suspicious/noExplicitAny: arr-sdk types are loosely typed from OpenAPI specs
					await client.qualityDefinition.updateAll(updated as any[]);

					// Update the mapping with new hash
					await this.prisma.qualitySizeMapping.update({
						where: { id: mapping.id },
						data: {
							appliedDataHash: currentHash,
							lastAppliedAt: new Date(),
						},
					});

					result.autoSynced++;
					this.logger.info(
						`Auto-synced quality size for ${mapping.instance.label} (${appliedCount} qualities updated)`,
					);
				} catch (applyError) {
					// Reset succeeded but apply failed — instance is at factory defaults.
					// Null out the hash so the next run detects the mismatch and retries.
					let hashCleanupFailed = false;
					await this.prisma.qualitySizeMapping
						.update({
							where: { id: mapping.id },
							data: { appliedDataHash: null },
						})
						.catch((cleanupErr) => {
							hashCleanupFailed = true;
							this.logger.warn(
								{
									err: cleanupErr instanceof Error ? cleanupErr : new Error(String(cleanupErr)),
									mappingId: mapping.id,
								},
								"Failed to null appliedDataHash after apply failure — retry logic may be impaired",
							);
						});
					throw new Error(
						`Apply failed after reset (instance at factory defaults)${hashCleanupFailed ? " [hash cleanup also failed, auto-retry may not work]" : ""}: ${getErrorMessage(applyError)}`,
					);
				}
			} catch (error) {
				result.errors.push(
					`Quality size sync failed for instance ${mapping.instance?.label ?? mapping.instanceId}: ${getErrorMessage(error)}`,
				);
				this.logger.error(
					{
						err: error instanceof Error ? error : new Error(String(error)),
						instanceId: mapping.instanceId,
					},
					`Quality size sync failed for instance ${mapping.instanceId}`,
				);
			}
		}

		return result;
	}

	/**
	 * Process naming auto-sync for instances with "auto" or "notify" strategy.
	 * Compares current TRaSH naming hash to the stored lastDeployedHash and
	 * re-applies naming presets for "auto" configs.
	 */
	private async processNamingSync(): Promise<{
		autoSynced: number;
		updatesPending: number;
		errors: string[];
	}> {
		const result = { autoSynced: 0, updatesPending: 0, errors: [] as string[] };

		if (!this.arrClientFactory) {
			const configCount = await this.prisma.namingConfig.count({
				where: { syncStrategy: { in: ["auto", "notify"] } },
			});
			if (configCount > 0) {
				this.logger.warn(
					`${configCount} naming config(s) with auto/notify strategy exist but arrClientFactory is not available — skipping sync`,
				);
			}
			return result;
		}

		const configs = await this.prisma.namingConfig.findMany({
			where: {
				syncStrategy: { in: ["auto", "notify"] },
				lastDeployedHash: { not: null },
			},
			include: {
				instance: true,
			},
		});

		if (configs.length === 0) return result;

		const cacheManager = createCacheManager(this.prisma);

		for (const config of configs) {
			try {
				const serviceType = config.serviceType as "RADARR" | "SONARR";

				// Get latest naming data from cache (stored as array, take first item)
				const cachedArray = await cacheManager.get<TrashNamingData[]>(
					serviceType,
					TRASH_CONFIG_TYPES.NAMING_PRESETS,
				);
				const cached = cachedArray?.[0] ?? null;
				if (!cached) {
					this.logger.warn(
						`Naming cache empty for ${serviceType} — skipping sync for instance ${config.instance.label}`,
					);
					continue;
				}

				// Parse stored presets
				let selectedPresets: NamingSelectedPresets;
				try {
					selectedPresets = JSON.parse(config.selectedPresets) as NamingSelectedPresets;
				} catch {
					result.errors.push(`Corrupt naming config presets for instance ${config.instance.label}`);
					continue;
				}

				// Compute current hash from resolved payload
				const payload = resolvePayload(cached, selectedPresets);
				const currentHash = computeNamingHash(payload);

				if (currentHash === config.lastDeployedHash) {
					continue; // No changes
				}

				if (config.syncStrategy === "notify") {
					result.updatesPending++;
					continue;
				}

				// Auto-sync: apply naming presets to instance
				if (!config.instance.enabled) {
					this.logger.debug(`Skipping naming sync for disabled instance ${config.instance.label}`);
					continue;
				}

				// Both Radarr and Sonarr use the same naming config endpoint
				const apiPath = "/api/v3/config/naming";

				// Get current config first (need to preserve id and other fields)
				const currentResponse = await this.arrClientFactory.rawRequest(config.instance, apiPath, {
					method: "GET",
				});
				if (!currentResponse.ok) {
					throw new Error(`Failed to get current naming config: ${currentResponse.status}`);
				}
				const currentConfig = (await currentResponse.json()) as Record<string, unknown>;

				// Merge payload onto current config
				const mergedConfig = { ...currentConfig, ...payload };

				const applyResponse = await this.arrClientFactory.rawRequest(config.instance, apiPath, {
					method: "PUT",
					body: mergedConfig,
				});

				if (!applyResponse.ok) {
					throw new Error(
						`Failed to apply naming config: ${applyResponse.status} ${applyResponse.statusText}`,
					);
				}

				// Update the config with new hash
				await this.prisma.namingConfig.update({
					where: { id: config.id },
					data: {
						lastDeployedHash: currentHash,
						lastDeployedAt: new Date(),
					},
				});

				result.autoSynced++;
				this.logger.info(`Auto-synced naming config for ${config.instance.label}`);
			} catch (error) {
				result.errors.push(
					`Naming sync failed for instance ${config.instance?.label ?? config.instanceId}: ${getErrorMessage(error)}`,
				);
				this.logger.error(
					{
						err: error instanceof Error ? error : new Error(String(error)),
						instanceId: config.instanceId,
					},
					`Naming sync failed for instance ${config.instanceId}`,
				);
			}
		}

		return result;
	}

	/**
	 * Create update notifications for templates needing attention
	 */
	private async createUpdateNotifications(templates: TemplateUpdateInfo[]): Promise<void> {
		for (const template of templates) {
			try {
				// Store notification in template's changeLog
				const existingTemplate = await this.prisma.trashTemplate.findUnique({
					where: { id: template.templateId },
					select: { changeLog: true },
				});

				let changeLog: Array<Record<string, unknown>> = [];
				if (existingTemplate?.changeLog) {
					try {
						const parsed = JSON.parse(existingTemplate.changeLog);
						changeLog = Array.isArray(parsed) ? parsed : [];
					} catch (parseError) {
						this.logger.warn(
							`Failed to parse changeLog for template ${template.templateId}: ${getErrorMessage(
								parseError,
							)}. Raw value: ${String(existingTemplate.changeLog).slice(0, 100)}`,
						);
					}
				}

				// Check if notification already exists for this commit
				const notificationExists = changeLog.some(
					(entry) =>
						entry.type === "update_available" && entry.latestCommit === template.latestCommit,
				);

				if (!notificationExists) {
					// Determine the reason for needing attention
					let reason: string;
					if (template.needsApproval && template.pendingCFGroupAdditions?.length) {
						reason = "cf_group_additions_need_approval";
					} else if (template.hasUserModifications) {
						reason = "has_user_modifications";
					} else {
						reason = "notify_strategy";
					}

					changeLog.push({
						type: "update_available",
						timestamp: new Date().toISOString(),
						currentCommit: template.currentCommit,
						latestCommit: template.latestCommit,
						reason,
						// Include pending CF Group additions for the UI to display
						pendingCFGroupAdditions: template.pendingCFGroupAdditions,
						dismissed: false,
					});

					await this.prisma.trashTemplate.update({
						where: { id: template.templateId },
						data: { changeLog: JSON.stringify(changeLog) },
					});

					this.logger.debug(
						`Created update notification for ${template.templateName} (reason: ${reason})`,
					);
				}
			} catch (error) {
				this.logger.error(
					{
						err: error instanceof Error ? error : new Error(String(error)),
						templateId: template.templateId,
					},
					`Failed to create notification for template ${template.templateId}`,
				);
			}
		}
	}

	/**
	 * Create notification for score conflicts (scores that couldn't be auto-updated due to user overrides)
	 */
	private async createScoreConflictNotification(
		templateId: string,
		commitHash: string,
		scoreConflicts: ScoreConflict[],
	): Promise<void> {
		try {
			const existingTemplate = await this.prisma.trashTemplate.findUnique({
				where: { id: templateId },
				select: { changeLog: true, name: true },
			});

			if (!existingTemplate) return;

			let changeLog: Array<Record<string, unknown>> = [];
			if (existingTemplate.changeLog) {
				try {
					const parsed = JSON.parse(existingTemplate.changeLog);
					changeLog = Array.isArray(parsed) ? parsed : [];
				} catch (parseError) {
					this.logger.warn(
						`Failed to parse changeLog for template ${templateId}: ${getErrorMessage(parseError)}. Raw value: ${String(existingTemplate.changeLog).slice(0, 100)}`,
					);
				}
			}

			// Check if score conflict notification already exists for this commit
			const notificationExists = changeLog.some(
				(entry) => entry.type === "score_conflicts" && entry.commitHash === commitHash,
			);

			if (!notificationExists) {
				changeLog.push({
					type: "score_conflicts",
					timestamp: new Date().toISOString(),
					commitHash,
					scoreConflicts: scoreConflicts.map((sc) => ({
						trashId: sc.trashId,
						name: sc.name,
						currentScore: sc.currentScore,
						recommendedScore: sc.recommendedScore,
					})),
					dismissed: false,
				});

				await this.prisma.trashTemplate.update({
					where: { id: templateId },
					data: { changeLog: JSON.stringify(changeLog) },
				});

				this.logger.debug(
					`Created score conflict notification for ${existingTemplate.name} (${scoreConflicts.length} conflicts)`,
				);
			}
		} catch (error) {
			this.logger.error(
				{ err: error instanceof Error ? error : new Error(String(error)), templateId },
				`Failed to create score conflict notification for template ${templateId}`,
			);
		}
	}
}

// ============================================================================
// Factory Function
// ============================================================================

export function createUpdateScheduler(
	config: SchedulerConfig,
	templateUpdater: TemplateUpdater,
	versionTracker: VersionTracker,
	prisma: PrismaClient,
	logger: Logger,
	arrClientFactory?: ArrClientFactory,
	options?: {
		repoConfigResolver?: RepoConfigResolver;
		deploymentExecutor?: import("./deployment-executor.js").DeploymentExecutorService;
		notifyFn?: (
			payload: import("../notifications/types.js").NotificationPayload,
			options?: { userId?: string; fallbackEventTypes?: NotificationEventType[] },
		) => Promise<void>;
		trackTick?: import("../scheduler-registry/scheduler-registry.js").TickWrapper;
	},
): UpdateScheduler {
	return new UpdateScheduler(
		config,
		templateUpdater,
		versionTracker,
		prisma,
		logger,
		arrClientFactory,
		options,
	);
}
