/**
 * Backup Service - Creates JSON snapshots of ARR instance state
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { BackupData } from "../types.js";

/**
 * Get backup directory path
 */
function getBackupDir(): string {
	// Use /app/data in Docker, ./data in dev
	const isDocker = process.env.DOCKER === "true" || process.env.NODE_ENV === "production";
	const baseDir = isDocker ? "/app/data" : "./data";
	return path.join(baseDir, "arr-sync-snapshots");
}

/**
 * Ensure backup directory exists
 */
async function ensureBackupDir(): Promise<void> {
	const dir = getBackupDir();
	await fs.mkdir(dir, { recursive: true });
}

/**
 * Create a backup of current instance state
 */
export async function createBackup(data: BackupData): Promise<string> {
	await ensureBackupDir();

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const filename = `${data.instanceId}-${timestamp}.json`;
	const backupPath = path.join(getBackupDir(), filename);

	const backupContent = JSON.stringify(data, null, 2);

	await fs.writeFile(backupPath, backupContent, "utf-8");

	return backupPath;
}

/**
 * Save the last plan for an instance
 */
export async function saveLastPlan(
	instanceId: string,
	plan: any,
): Promise<string> {
	await ensureBackupDir();

	const filename = `${instanceId}-last-plan.json`;
	const planPath = path.join(getBackupDir(), filename);

	const planContent = JSON.stringify(
		{
			...plan,
			savedAt: new Date().toISOString(),
		},
		null,
		2,
	);

	await fs.writeFile(planPath, planContent, "utf-8");

	return planPath;
}

/**
 * List backups for an instance
 */
export async function listBackups(
	instanceId: string,
): Promise<Array<{ filename: string; path: string; createdAt: Date }>> {
	await ensureBackupDir();

	const dir = getBackupDir();
	const files = await fs.readdir(dir);

	const backups = files
		.filter(
			(f) =>
				f.startsWith(`${instanceId}-`) &&
				f.endsWith(".json") &&
				!f.includes("last-plan"),
		)
		.map((filename) => {
			const filePath = path.join(dir, filename);
			// Extract timestamp from filename
			const match = filename.match(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
			const timestamp = match
				? match[0].replace(/-/g, (m, i) => (i < 10 ? "-" : ":"))
				: "";
			return {
				filename,
				path: filePath,
				createdAt: timestamp ? new Date(timestamp) : new Date(0),
			};
		})
		.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

	return backups;
}

/**
 * Get the last backup for an instance
 */
export async function getLastBackup(
	instanceId: string,
): Promise<BackupData | null> {
	const backups = await listBackups(instanceId);
	if (backups.length === 0) {
		return null;
	}

	const lastBackup = backups[0];
	const content = await fs.readFile(lastBackup.path, "utf-8");
	return JSON.parse(content);
}

/**
 * Restore from a backup
 */
export async function restoreBackup(backupPath: string): Promise<BackupData> {
	const content = await fs.readFile(backupPath, "utf-8");
	return JSON.parse(content);
}

/**
 * Delete old backups, keeping only the N most recent
 */
export async function pruneOldBackups(
	instanceId: string,
	keepCount = 10,
): Promise<number> {
	const backups = await listBackups(instanceId);

	if (backups.length <= keepCount) {
		return 0;
	}

	const toDelete = backups.slice(keepCount);
	let deletedCount = 0;

	for (const backup of toDelete) {
		try {
			await fs.unlink(backup.path);
			deletedCount++;
		} catch (error) {
			console.error(`Failed to delete backup ${backup.path}:`, error);
		}
	}

	return deletedCount;
}
