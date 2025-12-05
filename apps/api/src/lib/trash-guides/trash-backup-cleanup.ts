/**
 * TRaSH Backup Cleanup Service
 *
 * Handles cleanup of expired and orphaned TRaSH backup records.
 * This service runs periodically to:
 * 1. Delete backups that have passed their expiresAt date
 * 2. Delete orphaned backups (no referencing sync or deployment history)
 *
 * Retention Policy:
 * - Backups expire after `backupRetentionDays` (default 30 days, configurable per user)
 * - Setting backupRetentionDays to 0 means backups never expire
 * - Orphaned backups (no references) older than 7 days are also cleaned up
 */

import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";

// Run cleanup every hour
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export interface CleanupStats {
	expiredCount: number;
	orphanedCount: number;
	totalCleaned: number;
}

export class TrashBackupCleanupService {
	private intervalId: NodeJS.Timeout | null = null;
	private isRunning = false;

	constructor(
		private prisma: PrismaClient,
		private logger: FastifyBaseLogger,
	) {}

	/**
	 * Start the cleanup scheduler
	 */
	start(): void {
		if (this.intervalId) {
			this.logger.warn("Trash backup cleanup already running");
			return;
		}

		this.logger.info("Starting trash backup cleanup scheduler");

		// Run immediately on startup
		this.runCleanup().catch((error) => {
			this.logger.error({ err: error }, "Failed to run initial trash backup cleanup");
		});

		// Then run periodically
		this.intervalId = setInterval(() => {
			this.runCleanup().catch((error) => {
				this.logger.error({ err: error }, "Failed to run scheduled trash backup cleanup");
			});
		}, CLEANUP_INTERVAL_MS);
	}

	/**
	 * Stop the cleanup scheduler
	 */
	stop(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
			this.logger.info("Trash backup cleanup scheduler stopped");
		}
	}

	/**
	 * Run the cleanup process
	 */
	async runCleanup(): Promise<CleanupStats> {
		// In-flight guard: prevent overlapping cleanup runs
		if (this.isRunning) {
			this.logger.debug("Trash backup cleanup already running, skipping");
			return { expiredCount: 0, orphanedCount: 0, totalCleaned: 0 };
		}

		this.isRunning = true;

		try {
			const stats: CleanupStats = {
				expiredCount: 0,
				orphanedCount: 0,
				totalCleaned: 0,
			};

			// 1. Delete expired backups
			stats.expiredCount = await this.cleanupExpiredBackups();

			// 2. Delete orphaned backups
			stats.orphanedCount = await this.cleanupOrphanedBackups();

			stats.totalCleaned = stats.expiredCount + stats.orphanedCount;

			if (stats.totalCleaned > 0) {
				this.logger.info(
					{
						expiredCount: stats.expiredCount,
						orphanedCount: stats.orphanedCount,
						totalCleaned: stats.totalCleaned,
					},
					"Trash backup cleanup completed",
				);
			}

			return stats;
		} finally {
			this.isRunning = false;
		}
	}

	/**
	 * Delete backups that have passed their expiration date
	 */
	private async cleanupExpiredBackups(): Promise<number> {
		const result = await this.prisma.trashBackup.deleteMany({
			where: {
				expiresAt: {
					not: null,
					lte: new Date(),
				},
			},
		});

		if (result.count > 0) {
			this.logger.debug({ count: result.count }, "Deleted expired trash backups");
		}

		return result.count;
	}

	/**
	 * Delete orphaned backups (backups with no referencing SyncHistory or DeploymentHistory)
	 *
	 * These can occur when:
	 * - Sync history records are deleted but backups remain (due to SetNull relation)
	 * - Manual cleanup of history records
	 *
	 * We only delete orphaned backups that are older than 7 days to avoid
	 * deleting recently created backups that might just have delayed history creation.
	 */
	private async cleanupOrphanedBackups(): Promise<number> {
		const orphanThreshold = new Date();
		orphanThreshold.setDate(orphanThreshold.getDate() - 7);

		// Find backups that might be orphaned (old enough to check)
		const potentialOrphans = await this.prisma.trashBackup.findMany({
			where: {
				createdAt: {
					lte: orphanThreshold,
				},
			},
			select: {
				id: true,
				_count: {
					select: {
						syncHistory: true,
						deploymentHistory: true,
					},
				},
			},
		});

		// Filter to only those with no references
		const orphanIds = potentialOrphans
			.filter((backup) => backup._count.syncHistory === 0 && backup._count.deploymentHistory === 0)
			.map((backup) => backup.id);

		if (orphanIds.length === 0) {
			return 0;
		}

		const result = await this.prisma.trashBackup.deleteMany({
			where: {
				id: { in: orphanIds },
			},
		});

		if (result.count > 0) {
			this.logger.debug({ count: result.count }, "Deleted orphaned trash backups");
		}

		return result.count;
	}

	/**
	 * Get current cleanup statistics (for monitoring/admin purposes)
	 */
	async getStats(): Promise<{
		totalBackups: number;
		expiredBackups: number;
		orphanedBackups: number;
		oldestBackup: Date | null;
		newestBackup: Date | null;
	}> {
		const [totalBackups, expiredCount, oldest, newest] = await Promise.all([
			this.prisma.trashBackup.count(),
			this.prisma.trashBackup.count({
				where: {
					expiresAt: {
						not: null,
						lte: new Date(),
					},
				},
			}),
			this.prisma.trashBackup.findFirst({
				orderBy: { createdAt: "asc" },
				select: { createdAt: true },
			}),
			this.prisma.trashBackup.findFirst({
				orderBy: { createdAt: "desc" },
				select: { createdAt: true },
			}),
		]);

		// Count orphaned backups (older than 7 days with no references)
		const orphanThreshold = new Date();
		orphanThreshold.setDate(orphanThreshold.getDate() - 7);

		const potentialOrphans = await this.prisma.trashBackup.findMany({
			where: {
				createdAt: { lte: orphanThreshold },
			},
			select: {
				id: true,
				_count: {
					select: {
						syncHistory: true,
						deploymentHistory: true,
					},
				},
			},
		});

		const orphanedCount = potentialOrphans.filter(
			(b) => b._count.syncHistory === 0 && b._count.deploymentHistory === 0,
		).length;

		return {
			totalBackups,
			expiredBackups: expiredCount,
			orphanedBackups: orphanedCount,
			oldestBackup: oldest?.createdAt ?? null,
			newestBackup: newest?.createdAt ?? null,
		};
	}
}

/**
 * Factory function to create a TrashBackupCleanupService instance
 */
export function createTrashBackupCleanupService(
	prisma: PrismaClient,
	logger: FastifyBaseLogger,
): TrashBackupCleanupService {
	return new TrashBackupCleanupService(prisma, logger);
}
