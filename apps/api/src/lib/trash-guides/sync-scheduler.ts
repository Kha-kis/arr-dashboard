/**
 * TRaSH Sync Scheduler
 *
 * Executes scheduled TRaSH template syncs based on TrashSyncSchedule rows.
 * Modeled after BackupScheduler — periodic check with in-flight guard.
 */

import type { FastifyBaseLogger } from "fastify";
import type { ArrClientFactory } from "../arr/client-factory.js";
import type { DeploymentExecutorService } from "./deployment-executor.js";
import type { NotificationPayload } from "../notifications/types.js";
import type { PrismaClient } from "../prisma.js";
import { getErrorMessage } from "../utils/error-message.js";
import { createCacheManager } from "./cache-manager.js";
import { createTrashFetcher } from "./github-fetcher.js";
import { getGlobalRepoConfig } from "./repo-config.js";
import { createSyncEngine } from "./sync-engine.js";
import { createTemplateUpdater } from "./template-updater.js";
import { createVersionTracker } from "./version-tracker.js";

const CHECK_INTERVAL_MS = 60 * 1000; // Check every minute

export class TrashSyncScheduler {
	private intervalId: NodeJS.Timeout | null = null;
	private isRunning = false;

	constructor(
		private prisma: PrismaClient,
		private logger: FastifyBaseLogger,
		private deploymentExecutor: DeploymentExecutorService,
		private arrClientFactory: ArrClientFactory,
		private notifyFn?: (payload: NotificationPayload) => Promise<void>,
	) {}

	start() {
		if (this.intervalId) {
			this.logger.warn("TRaSH sync scheduler already running");
			return;
		}

		this.logger.info("Starting TRaSH sync scheduler");

		// Run immediately on startup (catches overdue schedules after restart)
		this.checkAndRunSchedules().catch((error) => {
			this.logger.error({ err: error }, "Failed initial TRaSH sync schedule check");
		});

		// Then check every minute
		this.intervalId = setInterval(() => {
			this.checkAndRunSchedules().catch((error) => {
				this.logger.error({ err: error }, "Failed TRaSH sync schedule check");
			});
		}, CHECK_INTERVAL_MS);
	}

	stop() {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
			this.logger.info("TRaSH sync scheduler stopped");
		}
	}

	private async checkAndRunSchedules() {
		if (this.isRunning) {
			this.logger.debug("TRaSH sync scheduler already processing, skipping");
			return;
		}

		try {
			this.isRunning = true;

			// Find all enabled schedules that are due
			const now = new Date();
			const dueSchedules = await this.prisma.trashSyncSchedule.findMany({
				where: {
					enabled: true,
					nextRunAt: { lte: now },
				},
				include: {
					template: { select: { id: true, name: true, serviceType: true } },
					instance: { select: { id: true, label: true } },
				},
			});

			if (dueSchedules.length === 0) return;

			this.logger.info(
				{ count: dueSchedules.length },
				"Processing due TRaSH sync schedules",
			);

			for (const schedule of dueSchedules) {
				await this.executeSchedule(schedule);
			}
		} catch (error) {
			this.logger.error({ err: error }, "Error checking TRaSH sync schedules");
		} finally {
			this.isRunning = false;
		}
	}

	private async executeSchedule(schedule: {
		id: string;
		templateId: string | null;
		instanceId: string | null;
		userId: string;
		frequency: string;
		autoApply: boolean;
		notifyUser: boolean;
		template: { id: string; name: string; serviceType: string } | null;
		instance: { id: string; label: string } | null;
	}) {
		const templateName = schedule.template?.name ?? "Unknown";
		const instanceLabel = schedule.instance?.label ?? "Unknown";

		if (!schedule.templateId || !schedule.instanceId) {
			this.logger.warn(
				{ scheduleId: schedule.id },
				"Skipping schedule with missing templateId or instanceId",
			);
			return;
		}

		this.logger.info(
			{
				scheduleId: schedule.id,
				templateName,
				instanceLabel,
				autoApply: schedule.autoApply,
			},
			"Executing scheduled TRaSH sync",
		);

		try {
			// Build repo-aware services
			const repoConfig = await getGlobalRepoConfig(this.prisma);
			const versionTracker = createVersionTracker(repoConfig);
			const cacheManager = createCacheManager(this.prisma);
			const githubFetcher = createTrashFetcher({ repoConfig, logger: this.logger });
			const templateUpdater = createTemplateUpdater(
				this.prisma,
				versionTracker,
				cacheManager,
				githubFetcher,
				this.deploymentExecutor,
			);
			const syncEngine = createSyncEngine(
				this.prisma,
				templateUpdater,
				this.deploymentExecutor,
				this.arrClientFactory,
			);

			// Validate first
			const validation = await syncEngine.validate({
				templateId: schedule.templateId,
				instanceId: schedule.instanceId,
				userId: schedule.userId,
				syncType: "SCHEDULED",
			});

			if (!validation.valid) {
				this.logger.warn(
					{
						scheduleId: schedule.id,
						templateName,
						errors: validation.errors,
					},
					"Scheduled sync validation failed",
				);

				// Update schedule timing even on validation failure to avoid retry storms
				await this.updateNextRunAt(schedule.id, schedule.frequency);

				if (schedule.notifyUser) {
					this.notifyFn?.({
						eventType: "TRASH_SYNC_ERROR",
						title: `Scheduled sync skipped: ${templateName}`,
						body: `Validation failed for ${templateName} → ${instanceLabel}: ${validation.errors.join("; ")}`,
						url: "/trash-guides",
						metadata: {
							templateId: schedule.templateId,
							instanceId: schedule.instanceId,
							reason: "validation_failed",
						},
					}).catch((err) => {
						this.logger.debug({ err }, "Sync error notification dispatch failed");
					});
				}
				return;
			}

			// Execute sync
			const result = await syncEngine.execute(
				{
					templateId: schedule.templateId,
					instanceId: schedule.instanceId,
					userId: schedule.userId,
					syncType: "SCHEDULED",
				},
				// No conflict resolutions for scheduled syncs — skip conflicts
				undefined,
			);

			// Update schedule timing
			await this.updateNextRunAt(schedule.id, schedule.frequency);

			if (result.success) {
				this.logger.info(
					{
						scheduleId: schedule.id,
						templateName,
						instanceLabel,
						syncId: result.syncId,
					},
					"Scheduled TRaSH sync completed successfully",
				);

				if (schedule.notifyUser) {
					this.notifyFn?.({
						eventType: "TRASH_PROFILE_UPDATED",
						title: `Scheduled sync completed: ${templateName}`,
						body: `${templateName} synced to ${instanceLabel} successfully`,
						url: "/trash-guides",
						metadata: {
							templateId: schedule.templateId,
							instanceId: schedule.instanceId,
							syncId: result.syncId,
						},
					}).catch((err) => {
						this.logger.debug({ err }, "Sync success notification dispatch failed");
					});
				}
			} else {
				const errorSummary = result.errors.map((e) => e.error).join("; ") || "Unknown error";
				this.logger.warn(
					{
						scheduleId: schedule.id,
						templateName,
						errors: result.errors,
					},
					"Scheduled TRaSH sync failed",
				);

				if (schedule.notifyUser) {
					this.notifyFn?.({
						eventType: "TRASH_SYNC_ERROR",
						title: `Scheduled sync failed: ${templateName}`,
						body: `${templateName} → ${instanceLabel}: ${errorSummary}`,
						url: "/trash-guides",
						metadata: {
							templateId: schedule.templateId,
							instanceId: schedule.instanceId,
						},
					}).catch((err) => {
						this.logger.debug({ err }, "Sync error notification dispatch failed");
					});
				}
			}
		} catch (error) {
			this.logger.error(
				{ err: error, scheduleId: schedule.id, templateName },
				"Unexpected error executing scheduled sync",
			);

			// Still advance the schedule to prevent retry storms
			await this.updateNextRunAt(schedule.id, schedule.frequency).catch((updateErr) => {
				this.logger.error({ err: updateErr }, "Failed to update nextRunAt after error");
			});

			if (schedule.notifyUser) {
				this.notifyFn?.({
					eventType: "TRASH_SYNC_ERROR",
					title: `Scheduled sync error: ${templateName}`,
					body: getErrorMessage(error),
					url: "/trash-guides",
				}).catch((err) => {
					this.logger.debug({ err }, "Sync error notification dispatch failed");
				});
			}
		}
	}

	private async updateNextRunAt(scheduleId: string, frequency: string) {
		const now = new Date();
		const nextRunAt = this.calculateNextRunTime(frequency);

		await this.prisma.trashSyncSchedule.update({
			where: { id: scheduleId },
			data: {
				lastRunAt: now,
				nextRunAt,
			},
		});

		this.logger.debug(
			{ scheduleId, nextRunAt: nextRunAt.toISOString() },
			"Updated schedule nextRunAt",
		);
	}

	private calculateNextRunTime(frequency: string): Date {
		const now = new Date();

		switch (frequency) {
			case "DAILY":
				return new Date(now.getTime() + 24 * 60 * 60 * 1000);
			case "WEEKLY":
				return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
			case "MONTHLY":
				return new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
			default:
				// Default to daily
				return new Date(now.getTime() + 24 * 60 * 60 * 1000);
		}
	}
}
