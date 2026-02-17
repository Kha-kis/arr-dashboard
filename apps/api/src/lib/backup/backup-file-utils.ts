/**
 * Backup File Utilities
 *
 * File system operations for backup data: reading/writing secrets,
 * directory management, ID generation, and timestamp parsing.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { BackupData } from "@arr/shared";
import { loggers } from "../logger.js";

const log = loggers.backup;

/**
 * Read secrets from secrets.json
 */
export async function readSecrets(secretsPath: string): Promise<BackupData["secrets"]> {
	try {
		const secretsContent = await fs.readFile(secretsPath, "utf-8");
		const secrets = JSON.parse(secretsContent);
		return {
			encryptionKey: secrets.encryptionKey,
			sessionCookieSecret: secrets.sessionCookieSecret,
		};
	} catch (error) {
		throw new Error(`Failed to read secrets file: ${error}`);
	}
}

/**
 * Write secrets to secrets.json with restrictive permissions (0o600)
 * Merges with existing secrets to preserve additional fields like backupPassword
 * Only the owner can read/write the secrets file for enhanced security
 */
export async function writeSecrets(
	secretsPath: string,
	secrets: BackupData["secrets"],
): Promise<void> {
	try {
		// Read existing secrets to preserve fields not in backup (e.g., backupPassword)
		let existingSecrets: Record<string, unknown> = {};
		try {
			const existingContent = await fs.readFile(secretsPath, "utf-8");
			existingSecrets = JSON.parse(existingContent);
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
				// File doesn't exist, start with empty object
			} else if (error instanceof SyntaxError) {
				// Invalid JSON, start with empty object (log warning)
				log.warn({ file: secretsPath }, "Existing secrets file has invalid JSON, will overwrite");
			} else {
				// Unexpected error (e.g., EACCES), log but continue to allow restore to proceed
				log.warn(
					{ err: error, file: secretsPath },
					"Failed to read existing secrets, some fields may be lost",
				);
			}
		}

		// Merge backup secrets with existing ones
		// Backup secrets take precedence, but existing fields are preserved
		const mergedSecrets = { ...existingSecrets, ...secrets };

		const secretsContent = JSON.stringify(mergedSecrets, null, 2);
		// Write with restrictive permissions (owner read/write only)
		await fs.writeFile(secretsPath, secretsContent, { encoding: "utf-8", mode: 0o600 });

		// Fallback: explicitly set permissions to ensure they're enforced
		// This handles cases where the file existed with different permissions
		await fs.chmod(secretsPath, 0o600);
	} catch (error) {
		throw new Error(`Failed to write secrets file: ${error}`);
	}
}

/**
 * Ensure backups directory exists
 */
export async function ensureBackupsDirectory(backupsDir: string): Promise<void> {
	await fs.mkdir(backupsDir, { recursive: true });
}

/**
 * Generate a unique ID for a backup based on its path
 */
export function generateBackupId(backupPath: string): string {
	// Use SHA-256 hash of the path as the ID (24 hex chars = 96 bits for collision resistance)
	return crypto.createHash("sha256").update(backupPath).digest("hex").substring(0, 24);
}

/**
 * Parse timestamp from backup filename without decrypting the file
 * Filename format: arr-dashboard-backup-2025-10-15T13-27-36-897Z.json
 * Returns ISO 8601 timestamp: 2025-10-15T13:27:36.897Z
 * Falls back to file modification time if parsing fails
 */
export function parseTimestampFromFilename(filename: string, fallbackMtime: Date): string {
	// Pattern to extract timestamp: backup-YYYY-MM-DDTHH-MM-SS-MMMZ
	const timestampPattern = /backup-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/;
	const match = filename.match(timestampPattern);

	if (!match) {
		// Filename doesn't match expected format, use file modification time
		return fallbackMtime.toISOString();
	}

	// Extract timestamp string and convert hyphens to colons in the time portion
	// Input:  2025-10-15T13-27-36-897Z
	// Output: 2025-10-15T13:27:36.897Z
	const rawTimestamp = match[1];
	if (!rawTimestamp) {
		return fallbackMtime.toISOString();
	}
	const [datePart, timePart] = rawTimestamp.split("T");
	if (!timePart) {
		return fallbackMtime.toISOString();
	}

	// Convert time portion: 13-27-36-897Z -> 13:27:36.897Z
	const timeConverted = timePart.replace(/-(\d{2})-(\d{2})-(\d{3}Z)/, ":$1:$2.$3");

	const isoTimestamp = `${datePart}T${timeConverted}`;

	// Validate the parsed timestamp is valid ISO 8601
	const date = new Date(isoTimestamp);
	if (Number.isNaN(date.getTime())) {
		// Invalid date, use fallback
		return fallbackMtime.toISOString();
	}

	return isoTimestamp;
}
