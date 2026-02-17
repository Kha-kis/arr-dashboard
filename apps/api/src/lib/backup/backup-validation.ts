/**
 * Backup Validation
 *
 * Pure validation functions for backup data structures.
 * No side effects — only type checking and structural validation.
 */

import type { BackupData } from "@arr/shared";
import type { EncryptedBackupEnvelope } from "./backup-crypto.js";

export const BACKUP_VERSION = "1.0";

/**
 * Validate that an object is a valid encrypted backup envelope
 * Performs strict type checking on all required fields to prevent misclassification
 */
export function isEncryptedBackupEnvelope(obj: unknown): obj is EncryptedBackupEnvelope {
	if (typeof obj !== "object" || obj === null) {
		return false;
	}

	const envelope = obj as Record<string, unknown>;

	// Validate all required fields with correct types
	return (
		typeof envelope.version === "string" &&
		typeof envelope.salt === "string" &&
		typeof envelope.iv === "string" &&
		typeof envelope.tag === "string" &&
		typeof envelope.cipherText === "string" &&
		typeof envelope.kdfParams === "object" &&
		envelope.kdfParams !== null &&
		typeof (envelope.kdfParams as Record<string, unknown>).algorithm === "string" &&
		typeof (envelope.kdfParams as Record<string, unknown>).hash === "string" &&
		typeof (envelope.kdfParams as Record<string, unknown>).iterations === "number" &&
		typeof (envelope.kdfParams as Record<string, unknown>).saltLength === "number"
	);
}

/**
 * Validate that an object is a valid plaintext backup (legacy format)
 * Performs strict type checking on all required fields to prevent misclassification
 */
export function isPlaintextBackup(obj: unknown): obj is BackupData {
	if (typeof obj !== "object" || obj === null) {
		return false;
	}

	const backup = obj as Record<string, unknown>;

	// Validate all required top-level fields with correct types
	return (
		typeof backup.version === "string" &&
		typeof backup.appVersion === "string" &&
		typeof backup.timestamp === "string" &&
		typeof backup.data === "object" &&
		backup.data !== null &&
		typeof backup.secrets === "object" &&
		backup.secrets !== null &&
		// Ensure this isn't an encrypted envelope (no cipherText field)
		!("cipherText" in backup)
	);
}

/**
 * Validate that records have the expected shape before inserting
 * Prevents runtime errors from corrupted or incompatible backup data
 */
export function validateRecords(
	records: unknown[],
	entityType: string,
	requiredFields: string[],
): void {
	for (let i = 0; i < records.length; i++) {
		const record = records[i];

		if (!record || typeof record !== "object") {
			throw new Error(`Invalid ${entityType} record at index ${i}: not an object`);
		}

		const recordObj = record as Record<string, unknown>;
		for (const field of requiredFields) {
			if (!(field in recordObj) || recordObj[field] === undefined) {
				throw new Error(
					`Invalid ${entityType} record at index ${i}: missing required field '${field}'`,
				);
			}

			// Basic type check: ensure field is a primitive (string, number, boolean) or Date
			// Complex objects likely indicate corrupted or incompatible backup data
			const value = recordObj[field];
			if (value !== null && typeof value === "object" && !(value instanceof Date)) {
				throw new Error(
					`Invalid ${entityType} record at index ${i}: field '${field}' has unexpected type (expected primitive, got object)`,
				);
			}
		}
	}
}

/**
 * Validate backup structure
 */
export function validateBackup(backup: unknown): asserts backup is BackupData {
	if (typeof backup !== "object" || backup === null) {
		throw new Error("Invalid backup format: not an object");
	}

	const b = backup as Partial<BackupData>;

	if (!b.version || typeof b.version !== "string") {
		throw new Error("Invalid backup format: missing or invalid version");
	}

	if (b.version !== BACKUP_VERSION) {
		throw new Error(`Unsupported backup version: ${b.version} (expected ${BACKUP_VERSION})`);
	}

	if (!b.data || typeof b.data !== "object") {
		throw new Error("Invalid backup format: missing or invalid data");
	}

	if (!b.secrets || typeof b.secrets !== "object") {
		throw new Error("Invalid backup format: missing or invalid secrets");
	}

	// Validate required data fields
	const requiredFields = [
		"users",
		"sessions",
		"serviceInstances",
		"serviceTags",
		"serviceInstanceTags",
		"oidcAccounts",
		"webAuthnCredentials",
	];

	const dataRecord = b.data as Record<string, unknown>;
	for (const field of requiredFields) {
		if (!Array.isArray(dataRecord[field])) {
			throw new Error(`Invalid backup format: missing or invalid data.${field}`);
		}
	}

	// Optional fields for backward compatibility
	// These fields were added in later versions, so old backups may not have them
	const optionalArrayFields = [
		"oidcProviders",
		// System settings
		"systemSettings",
		// TRaSH Guides configuration
		"trashTemplates",
		"trashSettings",
		"trashSyncSchedules",
		"templateQualityProfileMappings",
		"instanceQualityProfileOverrides",
		"standaloneCFDeployments",
		// TRaSH Guides history/audit
		"trashSyncHistory",
		"templateDeploymentHistory",
		// TRaSH instance backups (optional, can be large)
		"trashBackups",
		// Hunting feature
		"huntConfigs",
		"huntLogs",
		"huntSearchHistory",
	];

	for (const field of optionalArrayFields) {
		if (dataRecord[field] !== undefined && !Array.isArray(dataRecord[field])) {
			throw new Error(`Invalid backup format: ${field} must be an array`);
		}
	}

	// Validate required secret fields
	if (
		typeof b.secrets.encryptionKey !== "string" ||
		typeof b.secrets.sessionCookieSecret !== "string"
	) {
		throw new Error("Invalid backup format: missing or invalid secrets");
	}
}
