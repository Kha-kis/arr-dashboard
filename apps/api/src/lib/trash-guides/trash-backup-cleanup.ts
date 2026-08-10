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

import type { FastifyBaseLogger } from "fastify";
import type { Prisma, PrismaClient } from "../../lib/prisma.js";
import { withCleanupOperationGuard } from "../library-cleanup/cleanup-maintenance-gate.js";
import {
	passthroughTickWrapper,
	type TickWrapper,
} from "../scheduler-registry/scheduler-registry.js";
import { shouldRetainDeploymentBackup } from "./deployment-backup-state.js";

// Run cleanup every hour
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
// Bound the backup blobs loaded and parsed during each candidate scan.
const BACKUP_CANDIDATE_PAGE_SIZE = 400;
// Each candidate contributes two bound values (id + backupData). Keep ample
// room for the timestamp and relation predicates under SQLite's 999-variable cap.
const BACKUP_DELETE_BATCH_SIZE = 400;

export interface CleanupStats {
	expiredCount: number;
	orphanedCount: number;
	totalCleaned: number;
}

export class TrashBackupCleanupService {
	private intervalId: NodeJS.Timeout | null = null;
	private isRunning = false;
	private trackTick: TickWrapper;

	constructor(
		private prisma: PrismaClient,
		private logger: FastifyBaseLogger,
		options?: { trackTick?: TickWrapper },
	) {
		this.trackTick = options?.trackTick ?? passthroughTickWrapper;
	}

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
		this.trackTick(() => this.runCleanup()).catch((error) => {
			this.logger.error({ err: error }, "Failed to run initial trash backup cleanup");
		});

		// Then run periodically
		this.intervalId = setInterval(() => {
			this.trackTick(() => this.runCleanup()).catch((error) => {
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
		return withCleanupOperationGuard(() => this.runCleanupGuarded());
	}

	private async runCleanupGuarded(): Promise<CleanupStats> {
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
	private async deleteCandidateBatches(
		candidates: Array<{ id: string; backupData: string }>,
		where: Prisma.TrashBackupWhereInput,
	): Promise<number> {
		let deleted = 0;
		for (let index = 0; index < candidates.length; index += BACKUP_DELETE_BATCH_SIZE) {
			const batch = candidates.slice(index, index + BACKUP_DELETE_BATCH_SIZE);
			const result = await this.prisma.trashBackup.deleteMany({
				where: {
					...where,
					OR: batch.map((backup) => ({ id: backup.id, backupData: backup.backupData })),
				},
			});
			deleted += result.count;
		}
		return deleted;
	}

	private async cleanupExpiredBackups(): Promise<number> {
		const now = new Date();
		let cursorId: string | undefined;
		let count = 0;

		for (;;) {
			const expired = await this.prisma.trashBackup.findMany({
				where: {
					expiresAt: { not: null, lte: now },
					// The backup remains durable ownership and rollback evidence until
					// every referencing history has been explicitly resolved.
					syncHistory: { none: { rolledBack: false } },
					deploymentHistory: { none: { rolledBack: false } },
					...(cursorId ? { id: { gt: cursorId } } : {}),
				},
				select: { id: true, backupData: true },
				orderBy: { id: "asc" },
				take: BACKUP_CANDIDATE_PAGE_SIZE,
			});

			if (expired.length === 0) break;
			cursorId = expired.at(-1)!.id;

			const deletable = expired.filter(
				(backup) => !shouldRetainDeploymentBackup(backup.backupData),
			);
			if (deletable.length > 0) {
				count += await this.deleteCandidateBatches(deletable, {
					expiresAt: { not: null, lte: now },
					// Re-check ownership in the mutation itself. A history may have
					// linked this backup after selection but before deleteMany executes.
					syncHistory: { none: { rolledBack: false } },
					deploymentHistory: { none: { rolledBack: false } },
				});
			}

			if (expired.length < BACKUP_CANDIDATE_PAGE_SIZE) break;
		}

		if (count > 0) {
			this.logger.debug({ count }, "Deleted expired trash backups");
		}

		return count;
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
		let cursorId: string | undefined;
		let count = 0;

		for (;;) {
			// Find backups that might be orphaned (old enough to check)
			const potentialOrphans = await this.prisma.trashBackup.findMany({
				where: {
					createdAt: {
						lte: orphanThreshold,
					},
					syncHistory: { none: { rolledBack: false } },
					deploymentHistory: { none: { rolledBack: false } },
					...(cursorId ? { id: { gt: cursorId } } : {}),
				},
				select: {
					id: true,
					backupData: true,
					_count: {
						select: {
							syncHistory: true,
							deploymentHistory: true,
						},
					},
				},
				orderBy: { id: "asc" },
				take: BACKUP_CANDIDATE_PAGE_SIZE,
			});

			if (potentialOrphans.length === 0) break;
			cursorId = potentialOrphans.at(-1)!.id;

			// Filter to only those with no references
			const orphanIds = potentialOrphans.filter(
				(backup) =>
					backup._count.syncHistory === 0 &&
					backup._count.deploymentHistory === 0 &&
					!shouldRetainDeploymentBackup(backup.backupData),
			);

			if (orphanIds.length > 0) {
				count += await this.deleteCandidateBatches(orphanIds, {
					createdAt: { lte: orphanThreshold },
					syncHistory: { none: { rolledBack: false } },
					deploymentHistory: { none: { rolledBack: false } },
				});
			}

			if (potentialOrphans.length < BACKUP_CANDIDATE_PAGE_SIZE) break;
		}

		if (count > 0) {
			this.logger.debug({ count }, "Deleted orphaned trash backups");
		}

		return count;
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
	options?: { trackTick?: TickWrapper },
): TrashBackupCleanupService {
	return new TrashBackupCleanupService(prisma, logger, options);
}
