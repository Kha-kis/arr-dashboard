import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import path from "node:path";
import { BackupService } from "./backup-service.js";

const CHECK_INTERVAL_MS = 60 * 1000; // Check every minute

export class BackupScheduler {
	private intervalId: NodeJS.Timeout | null = null;
	private backupService: BackupService;

	constructor(
		private prisma: PrismaClient,
		private logger: FastifyBaseLogger,
		private secretsPath: string,
	) {
		this.backupService = new BackupService(prisma, secretsPath);
	}

	/**
	 * Start the backup scheduler
	 */
	start() {
		if (this.intervalId) {
			this.logger.warn("Backup scheduler already running");
			return;
		}

		this.logger.info("Starting backup scheduler");

		// Run immediately on startup
		this.checkAndRunBackup().catch((error) => {
			this.logger.error({ err: error }, "Failed to run initial backup check");
		});

		// Then check every minute
		this.intervalId = setInterval(() => {
			this.checkAndRunBackup().catch((error) => {
				this.logger.error({ err: error }, "Failed to run scheduled backup check");
			});
		}, CHECK_INTERVAL_MS);
	}

	/**
	 * Stop the backup scheduler
	 */
	stop() {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
			this.logger.info("Backup scheduler stopped");
		}
	}

	/**
	 * Check if a backup should run and execute it
	 */
	private async checkAndRunBackup() {
		try {
			// Get backup settings
			const settings = await this.prisma.backupSettings.findUnique({
				where: { id: 1 },
			});

			// No settings or disabled
			if (!settings || !settings.enabled || settings.intervalType === "DISABLED") {
				return;
			}

			// Check if it's time to run
			const now = new Date();
			if (!settings.nextRunAt || settings.nextRunAt > now) {
				return;
			}

			this.logger.info(
				{
					intervalType: settings.intervalType,
					intervalValue: settings.intervalValue,
					retentionCount: settings.retentionCount,
				},
				"Running scheduled backup",
			);

			// Run the backup
			await this.runScheduledBackup(settings.retentionCount);

			// Calculate next run time
			const nextRunAt = this.calculateNextRunTime(
				settings.intervalType as "HOURLY" | "DAILY" | "WEEKLY",
				settings.intervalValue,
			);

			// Update settings with last run and next run times
			await this.prisma.backupSettings.update({
				where: { id: 1 },
				data: {
					lastRunAt: now,
					nextRunAt,
				},
			});

			this.logger.info(
				{
					lastRunAt: now.toISOString(),
					nextRunAt: nextRunAt.toISOString(),
				},
				"Scheduled backup completed",
			);
		} catch (error) {
			this.logger.error({ err: error }, "Error checking/running scheduled backup");
		}
	}

	/**
	 * Run a scheduled backup and clean up old backups
	 */
	private async runScheduledBackup(retentionCount: number) {
		try {
			// Create the backup
			const appVersion = "2.2.0"; // TODO: Load from package.json
			await this.backupService.createBackup(appVersion, "scheduled");

			// Clean up old backups
			await this.cleanupOldBackups(retentionCount);
		} catch (error) {
			this.logger.error({ err: error }, "Failed to run scheduled backup");
			throw error;
		}
	}

	/**
	 * Clean up old scheduled backups based on retention count
	 */
	private async cleanupOldBackups(retentionCount: number) {
		try {
			// Get all scheduled backups
			const allBackups = await this.backupService.listBackups();
			const scheduledBackups = allBackups
				.filter((b) => b.type === "scheduled")
				.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

			// Keep only the most recent N backups
			const backupsToDelete = scheduledBackups.slice(retentionCount);

			if (backupsToDelete.length > 0) {
				this.logger.info(
					{
						totalScheduled: scheduledBackups.length,
						retentionCount,
						deletingCount: backupsToDelete.length,
					},
					"Cleaning up old scheduled backups",
				);

				for (const backup of backupsToDelete) {
					try {
						await this.backupService.deleteBackup(backup.id);
						this.logger.debug({ backupId: backup.id, filename: backup.filename }, "Deleted old backup");
					} catch (error) {
						this.logger.error(
							{ err: error, backupId: backup.id, filename: backup.filename },
							"Failed to delete old backup",
						);
					}
				}
			}
		} catch (error) {
			this.logger.error({ err: error }, "Failed to cleanup old backups");
		}
	}

	/**
	 * Calculate the next run time based on interval settings
	 */
	private calculateNextRunTime(
		intervalType: "HOURLY" | "DAILY" | "WEEKLY",
		intervalValue: number,
	): Date {
		const now = new Date();

		switch (intervalType) {
			case "HOURLY":
				return new Date(now.getTime() + intervalValue * 60 * 60 * 1000);
			case "DAILY":
				return new Date(now.getTime() + intervalValue * 24 * 60 * 60 * 1000);
			case "WEEKLY":
				return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
			default:
				return new Date(now.getTime() + 24 * 60 * 60 * 1000); // Default to 24 hours
		}
	}
}
