/**
 * TRaSH Guides Backup Manager
 *
 * Creates and manages backups of Radarr/Sonarr configurations before sync operations
 */

import { PrismaClient } from "@prisma/client";
import type { ServiceInstance } from "@prisma/client";

// ============================================================================
// Types
// ============================================================================

export interface BackupData {
	timestamp: string;
	instanceId: string;
	instanceName: string;
	instanceType: string;
	customFormats: unknown[];
	qualityProfiles?: unknown[];
	metadata: {
		version: string;
		backupReason: string;
	};
}

export interface BackupInfo {
	id: string;
	instanceId: string;
	createdAt: Date;
	dataSize: number;
	configCount: number;
}

export interface RestoreResult {
	success: boolean;
	restoredCount: number;
	failedCount: number;
	errors: string[];
}

// ============================================================================
// Backup Manager Class
// ============================================================================

export class BackupManager {
	private prisma: PrismaClient;

	constructor(prisma: PrismaClient) {
		this.prisma = prisma;
	}

	/**
	 * Create a backup snapshot of instance configurations
	 */
	async createBackup(
		instanceId: string,
		userId: string,
		instanceData: {
			customFormats: unknown[];
			qualityProfiles?: unknown[];
			version?: string;
		},
		reason = "Pre-sync backup",
	): Promise<string> {
		// Get instance details with ownership info
		const instance = await this.prisma.serviceInstance.findUnique({
			where: { id: instanceId },
			select: {
				id: true,
				label: true,
				service: true,
				userId: true,
			},
		});

		if (!instance) {
			throw new Error(`Instance not found: ${instanceId}`);
		}

		// Verify ownership authorization
		if (instance.userId !== userId) {
			throw new Error(`Unauthorized: User does not own instance ${instanceId}`);
		}

		// Build backup data
		const backupData: BackupData = {
			timestamp: new Date().toISOString(),
			instanceId: instance.id,
			instanceName: instance.label,
			instanceType: instance.service,
			customFormats: instanceData.customFormats,
			qualityProfiles: instanceData.qualityProfiles,
			metadata: {
				version: instanceData.version || "unknown",
				backupReason: reason,
			},
		};

		// Serialize backup data
		const backupJson = JSON.stringify(backupData);

		// Create backup record
		const backup = await this.prisma.trashBackup.create({
			data: {
				instanceId,
				userId,
				backupData: backupJson,
				expiresAt: this.calculateExpirationDate(30), // 30 days retention
			},
		});

		return backup.id;
	}

	/**
	 * Get backup by ID
	 */
	async getBackup(backupId: string): Promise<BackupData | null> {
		const backup = await this.prisma.trashBackup.findUnique({
			where: { id: backupId },
		});

		if (!backup) {
			return null;
		}

		try {
			return JSON.parse(backup.backupData) as BackupData;
		} catch (error) {
			console.error(`Failed to parse backup data for backupId ${backupId}:`, error);
			return null;
		}
	}

	/**
	 * List backups for an instance
	 */
	async listBackups(
		instanceId: string,
		limit = 10,
		offset = 0,
	): Promise<BackupInfo[]> {
		const backups = await this.prisma.trashBackup.findMany({
			where: { instanceId },
			orderBy: { createdAt: "desc" },
			take: limit,
			skip: offset,
		});

		return backups.reduce<BackupInfo[]>((result, backup) => {
			try {
				const data = JSON.parse(backup.backupData) as BackupData;
				result.push({
					id: backup.id,
					instanceId: backup.instanceId,
					createdAt: backup.createdAt,
					dataSize: backup.backupData.length,
					configCount: data.customFormats.length,
				});
			} catch (error) {
				console.error(`Failed to parse backup data for backup ${backup.id}, instanceId ${backup.instanceId}:`, error);
				// Skip corrupted backups instead of crashing
			}
			return result;
		}, []);
	}

	/**
	 * Delete old backups based on retention policy
	 */
	async cleanupExpiredBackups(): Promise<number> {
		const result = await this.prisma.trashBackup.deleteMany({
			where: {
				expiresAt: {
					lte: new Date(),
				},
			},
		});

		return result.count;
	}

	/**
	 * Delete specific backup
	 */
	async deleteBackup(backupId: string): Promise<boolean> {
		try {
			await this.prisma.trashBackup.delete({
				where: { id: backupId },
			});
			return true;
		} catch (error) {
			console.error(`deleteBackup failed for backupId ${backupId}:`, error);
			return false;
		}
	}

	/**
	 * Calculate expiration date based on retention days
	 */
	private calculateExpirationDate(retentionDays: number): Date {
		const expirationDate = new Date();
		expirationDate.setDate(expirationDate.getDate() + retentionDays);
		return expirationDate;
	}

	/**
	 * Get backup count for instance
	 */
	async getBackupCount(instanceId: string): Promise<number> {
		return await this.prisma.trashBackup.count({
			where: { instanceId },
		});
	}

	/**
	 * Enforce backup retention limit (keep only N most recent)
	 */
	async enforceRetentionLimit(
		instanceId: string,
		maxBackups = 10,
	): Promise<number> {
		// Get all backups for instance, ordered by creation date
		const backups = await this.prisma.trashBackup.findMany({
			where: { instanceId },
			orderBy: { createdAt: "desc" },
			select: { id: true },
		});

		// If we're under the limit, nothing to do
		if (backups.length <= maxBackups) {
			return 0;
		}

		// Delete backups beyond the retention limit
		const backupsToDelete = backups.slice(maxBackups);
		const deleteIds = backupsToDelete.map((b) => b.id);

		const result = await this.prisma.trashBackup.deleteMany({
			where: {
				id: { in: deleteIds },
			},
		});

		return result.count;
	}

	/**
	 * Restore from backup
	 * Returns the restored backup data for use by API client
	 */
	async restoreBackup(backupId: string): Promise<BackupData> {
		const backup = await this.prisma.trashBackup.findUnique({
			where: { id: backupId },
		});

		if (!backup) {
			throw new Error(`Backup not found: ${backupId}`);
		}

		try {
			return JSON.parse(backup.backupData) as BackupData;
		} catch (parseError) {
			throw new Error(`Backup ${backupId} contains invalid JSON data: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
		}
	}
}

// ============================================================================
// Exports
// ============================================================================

/**
 * Create a backup manager instance
 */
export function createBackupManager(prisma: PrismaClient): BackupManager {
	return new BackupManager(prisma);
}
