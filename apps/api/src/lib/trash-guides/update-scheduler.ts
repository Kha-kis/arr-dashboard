/**
 * TRaSH Guides Update Scheduler
 *
 * Background job scheduler for checking TRaSH Guides updates periodically.
 * Automatically syncs templates based on user preferences and notifies when manual review needed.
 */

import type { PrismaClient } from "@prisma/client";
import type {
	ScoreConflict,
	SyncResult,
	TemplateUpdateInfo,
	TemplateUpdater,
} from "./template-updater.js";
import type { VersionTracker } from "./version-tracker.js";

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
		cachesRefreshed: number;
		cachesFailed: number;
		errors: string[];
	};
}

interface Logger {
	info: (msg: string, data?: unknown) => void;
	warn: (msg: string, data?: unknown) => void;
	error: (msg: string, data?: unknown) => void;
	debug: (msg: string, data?: unknown) => void;
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
	private intervalId?: NodeJS.Timeout;
	private stats: SchedulerStats = { isRunning: false };
	private isCheckInProgress = false;

	constructor(
		config: SchedulerConfig,
		templateUpdater: TemplateUpdater,
		versionTracker: VersionTracker,
		prisma: PrismaClient,
		logger: Logger,
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
		this.checkForUpdates().catch((error) => {
			this.logger.error("Initial update check failed:", error);
		});

		// Schedule periodic checks
		const intervalMs = this.config.intervalHours * 60 * 60 * 1000;
		this.intervalId = setInterval(() => {
			this.checkForUpdates().catch((error) => {
				this.logger.error("Scheduled update check failed:", error);
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
		// Prevent concurrent checks
		if (this.isCheckInProgress) {
			this.logger.warn("Update check already in progress, skipping");
			return;
		}

		this.isCheckInProgress = true;
		const startTime = Date.now();
		this.logger.info("Checking for TRaSH Guides updates...");

		const errors: string[] = [];
		let templatesAutoSynced = 0;
		let templatesNeedingAttention = 0;
		let templatesNeedingApproval = 0;
		let templatesWithScoreConflicts = 0;

		// Count templates by sync strategy (unique templates with at least one mapping of each type)
		const [templatesWithAutoStrategy, templatesWithNotifyStrategy] = await Promise.all([
			this.prisma.trashTemplate.count({
				where: {
					deletedAt: null,
					trashGuidesCommitHash: { not: null },
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

		try {
			// Get latest version info
			const latestCommit = await this.versionTracker.getLatestCommit();
			this.logger.debug("Latest TRaSH commit:", {
				hash: latestCommit.commitHash,
				date: latestCommit.commitDate,
			});

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

			// Get all distinct user IDs with templates to process updates per-user
			const templatesWithUsers = await this.prisma.trashTemplate.findMany({
				where: {
					deletedAt: null,
					trashGuidesCommitHash: { not: null },
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
					cachesRefreshed: totalCachesRefreshed,
					cachesFailed: totalCacheFailed,
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
				cachesRefreshed: totalCachesRefreshed,
				cachesFailed: totalCacheFailed,
				errors,
			};

			// Calculate next check time
			const intervalMs = this.config.intervalHours * 60 * 60 * 1000;
			this.stats.nextCheckAt = new Date(Date.now() + intervalMs);

			this.logger.info(
				`Update check completed in ${duration}ms. Next check at ${this.stats.nextCheckAt.toISOString()}`,
			);
		} catch (error) {
			this.logger.error("Update check failed:", error);
			errors.push(error instanceof Error ? error.message : String(error));

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
				cachesRefreshed: 0,
				cachesFailed: 0,
				errors,
			};

			// Calculate next check time
			const intervalMs = this.config.intervalHours * 60 * 60 * 1000;
			this.stats.nextCheckAt = new Date(Date.now() + intervalMs);

			throw error;
		} finally {
			this.isCheckInProgress = false;
		}
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
							`Failed to parse changeLog for template ${template.templateId}: ${
								parseError instanceof Error ? parseError.message : String(parseError)
							}. Raw value: ${String(existingTemplate.changeLog).slice(0, 100)}`,
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
					`Failed to create notification for template ${template.templateId}:`,
					error,
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
				} catch {
					// If parsing fails, start fresh
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
				`Failed to create score conflict notification for template ${templateId}:`,
				error,
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
): UpdateScheduler {
	return new UpdateScheduler(config, templateUpdater, versionTracker, prisma, logger);
}
