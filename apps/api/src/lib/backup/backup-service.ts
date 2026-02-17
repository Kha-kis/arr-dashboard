/**
 * Backup Service
 *
 * Manages encrypted database backups with password-based encryption.
 * Uses PBKDF2 for key derivation and AES-256-GCM for encryption.
 *
 * Features:
 * - Manual, scheduled, and auto-update backups
 * - Password-based encryption with configurable password
 * - Restore with validation and rollback capability
 * - Size limits to prevent memory exhaustion
 *
 * Implementation is decomposed into focused modules:
 * - backup-crypto.ts: PBKDF2 + AES-256-GCM encrypt/decrypt
 * - backup-validation.ts: Type guards and structural validation
 * - backup-file-utils.ts: File system operations (secrets, directories)
 * - backup-database.ts: Prisma export/restore operations
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
	BackupData,
	BackupFileInfo,
	BackupFileInfoInternal,
	BackupMetadata,
} from "@arr/shared";
import type { PrismaClient } from "../../lib/prisma.js";
import type { Encryptor } from "../auth/encryption.js";
import { loggers } from "../logger.js";
import { encryptBackupData, decryptBackupData } from "./backup-crypto.js";
import { exportDatabase, restoreDatabase } from "./backup-database.js";
import {
	readSecrets,
	writeSecrets,
	ensureBackupsDirectory,
	generateBackupId,
	parseTimestampFromFilename,
} from "./backup-file-utils.js";
import {
	BACKUP_VERSION,
	isEncryptedBackupEnvelope,
	isPlaintextBackup,
	validateBackup,
} from "./backup-validation.js";
import { getErrorMessage } from "../utils/error-message.js";

const log = loggers.backup;

// Size limits for backup operations
// These limits help prevent out-of-memory errors during JSON stringification and encryption
const RECOMMENDED_MAX_BACKUP_SIZE_MB = 100; // 100 MB recommended limit for backup data
const WARNING_BACKUP_SIZE_MB = 50; // Log warning when backup exceeds this size
const MAX_RESTORE_SIZE_MB = 200; // Maximum size for restore operations (defense against malicious files)

type BackupType = "manual" | "scheduled" | "update";

/**
 * Service for creating and restoring encrypted database backups.
 * Supports manual, scheduled, and auto-update backup types.
 */
export class BackupService {
	private backupsDir: string;
	// In-memory cache to reduce file system contention for dev password
	private devPasswordCache: string | null = null;
	private devPasswordPromise: Promise<string> | null = null;

	/**
	 * Create a new BackupService instance
	 * @param prisma - Prisma client for database operations
	 * @param secretsPath - Path to the secrets file (backups stored alongside)
	 * @param encryptor - Optional encryptor for decrypting API keys
	 */
	constructor(
		private prisma: PrismaClient,
		private secretsPath: string,
		private encryptor?: Encryptor,
	) {
		// Set backups directory next to the database file
		const dataDir = path.dirname(secretsPath);
		this.backupsDir = path.join(dataDir, "backups");
	}

	/**
	 * Get the backup password from database (preferred), environment, or auto-generate in dev
	 * Priority order:
	 * 1. Database setting (encryptedPassword in BackupSettings)
	 * 2. BACKUP_PASSWORD environment variable
	 * 3. Auto-generated password in development mode only
	 */
	private async getBackupPassword(): Promise<string> {
		// 1. Check database for encrypted password (if encryptor available)
		if (this.encryptor) {
			const settings = await this.prisma.backupSettings.findUnique({
				where: { id: 1 },
				select: { encryptedPassword: true, passwordIv: true },
			});

			if (settings?.encryptedPassword && settings?.passwordIv) {
				try {
					return this.encryptor.decrypt({
						value: settings.encryptedPassword,
						iv: settings.passwordIv,
					});
				} catch (error) {
					// Log error but continue to fallback - decryption failure shouldn't block backups
					log.error({ err: error }, "Failed to decrypt backup password from database, falling back to env var");
				}
			}
		}

		// 2. If explicitly set via environment, use it
		const envPassword = process.env.BACKUP_PASSWORD;
		if (envPassword) {
			return envPassword;
		}

		// 3. In production, fail closed - do not allow backups without explicit password
		const isProduction = process.env.NODE_ENV === "production";
		if (isProduction) {
			throw new Error(
				"Backup password not configured. Set a backup password in Settings > Backup or set the BACKUP_PASSWORD environment variable.",
			);
		}

		// 4. In development, generate and persist a secure random password
		return this.getOrGenerateDevBackupPassword();
	}

	/**
	 * Get or generate a development backup password
	 * Uses in-memory cache to reduce file system contention
	 * Deduplicates concurrent generation attempts by sharing the same Promise
	 */
	private async getOrGenerateDevBackupPassword(): Promise<string> {
		// Return cached value if available
		if (this.devPasswordCache) {
			return this.devPasswordCache;
		}

		// If already generating, await the same promise
		if (this.devPasswordPromise) {
			return this.devPasswordPromise;
		}

		// Start generation
		this.devPasswordPromise = this._generateDevBackupPassword();
		try {
			this.devPasswordCache = await this.devPasswordPromise;
			return this.devPasswordCache;
		} finally {
			this.devPasswordPromise = null;
		}
	}

	/**
	 * Generate a development backup password and persist to secrets.json
	 * Generates a cryptographically strong random password and persists it to secrets.json
	 * Uses async file operations to avoid blocking the event loop
	 */
	private async _generateDevBackupPassword(): Promise<string> {
		try {
			// Try to read existing secrets file
			const secretsContent = await fs.readFile(this.secretsPath, "utf-8");
			const secrets = JSON.parse(secretsContent);

			// If backup password already exists, return it
			if (secrets.backupPassword && typeof secrets.backupPassword === "string") {
				return secrets.backupPassword;
			}

			// Generate new password and merge with existing secrets
			const newPassword = crypto.randomBytes(32).toString("base64");

			// Guard against race condition: Check again before writing in case another process wrote a password
			let recheckContent: string | null = null;
			try {
				recheckContent = await fs.readFile(this.secretsPath, "utf-8");
				const recheckSecrets = JSON.parse(recheckContent);
				if (recheckSecrets.backupPassword && typeof recheckSecrets.backupPassword === "string") {
					return recheckSecrets.backupPassword;
				}
			} catch (error) {
				// Only proceed if file is missing or invalid JSON; re-throw other errors
				if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
					// File disappeared, proceed with write
				} else if (error instanceof SyntaxError && recheckContent) {
					// Invalid JSON - try to salvage backupPassword before overwriting
					log.warn({ file: "secrets.json" }, "secrets.json has invalid JSON, attempting to salvage backupPassword");
					// Use the already-read recheckContent instead of re-reading the file
					const backupPasswordMatch = recheckContent.match(/"backupPassword"\s*:\s*"([^"]+)"/);
					if (backupPasswordMatch?.[1]) {
						log.warn({ file: "secrets.json" }, "Found existing backupPassword in invalid JSON, preserving it");
						return backupPasswordMatch[1];
					}
					log.warn({ file: "secrets.json" }, "Could not salvage backupPassword, existing backups may become inaccessible");
					// Proceed with write
				} else {
					// Unexpected error (e.g., EACCES permission denied), re-throw
					throw error;
				}
			}

			const updatedSecrets = { ...secrets, backupPassword: newPassword };

			// Write atomically with restrictive permissions
			const tempPath = `${this.secretsPath}.tmp`;
			await fs.writeFile(tempPath, JSON.stringify(updatedSecrets, null, 2), {
				encoding: "utf-8",
				mode: 0o600,
			});
			await fs.rename(tempPath, this.secretsPath);
			await fs.chmod(this.secretsPath, 0o600);

			return newPassword;
		} catch (error) {
			// If secrets file doesn't exist, create it with just the backup password
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
				const newPassword = crypto.randomBytes(32).toString("base64");
				const secrets = { backupPassword: newPassword };

				try {
					// Ensure directory exists
					const dir = path.dirname(this.secretsPath);
					await fs.mkdir(dir, { recursive: true });

					// Write with restrictive permissions and 'wx' flag to fail if file exists (race guard)
					await fs.writeFile(this.secretsPath, JSON.stringify(secrets, null, 2), {
						encoding: "utf-8",
						mode: 0o600,
						flag: "wx",
					});
					await fs.chmod(this.secretsPath, 0o600);

					return newPassword;
				} catch (writeError) {
					// If write failed because file now exists (race condition), read and return existing password
					if (
						writeError &&
						typeof writeError === "object" &&
						"code" in writeError &&
						writeError.code === "EEXIST"
					) {
						try {
							const existingContent = await fs.readFile(this.secretsPath, "utf-8");
							const existingSecrets = JSON.parse(existingContent);
							if (
								existingSecrets.backupPassword &&
								typeof existingSecrets.backupPassword === "string"
							) {
								return existingSecrets.backupPassword;
							}
						} catch (readError) {
							// Only fall through to original error if read failed due to expected reasons
							// Re-throw if it's an unexpected error (e.g., permission denied)
							if (
								readError &&
								typeof readError === "object" &&
								"code" in readError &&
								readError.code === "ENOENT"
							) {
								// File was deleted between EEXIST and read, fall through to original error
							} else if (readError instanceof SyntaxError) {
								// File exists but has invalid JSON, fall through to original error
							} else {
								// Unexpected error (e.g., EACCES), re-throw
								throw readError;
							}
						}
					}
					throw new Error(`Failed to create secrets file: ${writeError}`);
				}
			}

			throw new Error(`Failed to read/write secrets file: ${error}`);
		}
	}

	/**
	 * Create a backup and save it to filesystem (encrypted)
	 *
	 * @param appVersion - Application version string
	 * @param type - Backup type (manual, scheduled, update)
	 * @param options.includeTrashBackups - Include TRaSH ARR config snapshots (can be large)
	 */
	async createBackup(
		appVersion: string,
		type: BackupType = "manual",
		options: { includeTrashBackups?: boolean } = {},
	): Promise<BackupFileInfo> {
		// 1. Ensure backups directory exists
		await ensureBackupsDirectory(this.backupsDir);

		// 2. Export all database data
		const data = await exportDatabase(this.prisma, { includeTrashBackups: options.includeTrashBackups });

		// 3. Read secrets file
		const secrets = await readSecrets(this.secretsPath);

		// 4. Create backup structure
		const backup: BackupData = {
			version: BACKUP_VERSION,
			appVersion,
			timestamp: new Date().toISOString(),
			data,
			secrets,
		};

		// 5. Estimate backup size before stringification to detect potential memory issues
		// This is a rough estimate based on record counts to fail fast before JSON.stringify
		const estimatedRecordCount =
			// Core tables
			data.users.length +
			data.sessions.length +
			data.serviceInstances.length +
			data.serviceTags.length +
			data.serviceInstanceTags.length +
			(data.oidcProviders?.length || 0) +
			data.oidcAccounts.length +
			data.webAuthnCredentials.length +
			// System settings
			(data.systemSettings?.length || 0) +
			// TRaSH Guides
			(data.trashTemplates?.length || 0) +
			(data.trashSettings?.length || 0) +
			(data.trashSyncSchedules?.length || 0) +
			(data.templateQualityProfileMappings?.length || 0) +
			(data.instanceQualityProfileOverrides?.length || 0) +
			(data.standaloneCFDeployments?.length || 0) +
			(data.trashSyncHistory?.length || 0) +
			(data.templateDeploymentHistory?.length || 0) +
			(data.trashBackups?.length || 0) +
			// Hunting
			(data.huntConfigs?.length || 0) +
			(data.huntLogs?.length || 0) +
			(data.huntSearchHistory?.length || 0);

		// Average ~1KB per record (conservative estimate including encrypted fields)
		const estimatedSizeMB = (estimatedRecordCount * 1024) / (1024 * 1024);

		if (estimatedSizeMB > RECOMMENDED_MAX_BACKUP_SIZE_MB) {
			const message = `Backup size estimate (${estimatedSizeMB.toFixed(2)} MB) exceeds recommended limit (${RECOMMENDED_MAX_BACKUP_SIZE_MB} MB). This may cause memory issues or timeouts. Consider implementing backup streaming or pruning old data.`;
			log.error({ estimatedSizeMB, limitMB: RECOMMENDED_MAX_BACKUP_SIZE_MB }, "Backup size estimate exceeds recommended limit");
			throw new Error(message);
		}
		if (estimatedSizeMB > WARNING_BACKUP_SIZE_MB) {
			log.warn({ estimatedSizeMB, warningThresholdMB: WARNING_BACKUP_SIZE_MB }, "Backup size estimate is large, consider monitoring memory usage");
		}

		// 6. Convert to JSON
		const backupJson = JSON.stringify(backup);

		// 7. Encrypt the backup data
		const password = await this.getBackupPassword();
		const encryptedEnvelope = await encryptBackupData(backupJson, password);

		// 8. Convert encrypted envelope to JSON (pretty-printed for storage)
		const envelopeJson = JSON.stringify(encryptedEnvelope, null, 2);

		// 9. Generate filename using the same timestamp from backup payload to avoid drift
		const filename = `arr-dashboard-backup-${backup.timestamp.replace(/[:.]/g, "-")}.json`;

		// 10. Determine backup path (organized by type)
		const typeDir = path.join(this.backupsDir, type);
		await fs.mkdir(typeDir, { recursive: true });
		let backupPath = path.join(typeDir, filename);

		// 11. Save encrypted backup to file with restrictive permissions (owner read/write only)
		// Use 'wx' flag to fail if file already exists (prevents accidental overwrite)
		// Retry with random suffix on timestamp collision to improve resilience
		let attempt = 0;
		let finalPath = backupPath;
		while (attempt < 5) {
			try {
				await fs.writeFile(finalPath, envelopeJson, { encoding: "utf-8", mode: 0o600, flag: "wx" });
				break; // Success
			} catch (error) {
				// If file exists and we have retries left, add random suffix and retry
				if (
					error &&
					typeof error === "object" &&
					"code" in error &&
					error.code === "EEXIST" &&
					attempt < 4
				) {
					const suffix = crypto.randomBytes(4).toString("hex");
					finalPath = backupPath.replace(".json", `-${suffix}.json`);
					attempt++;
				} else {
					// Re-throw on other errors or if retries exhausted
					throw error;
				}
			}
		}
		backupPath = finalPath; // Update backupPath for subsequent operations

		// Fallback: explicitly set permissions to ensure they're enforced
		// This handles cases where the file system doesn't support mode during creation
		await fs.chmod(backupPath, 0o600);

		// 12. Get file stats
		const stats = await fs.stat(backupPath);

		// 13. Create backup info (excluding internal path from public response)
		const backupInfo: BackupFileInfo = {
			id: generateBackupId(backupPath),
			filename,
			type,
			timestamp: backup.timestamp,
			size: stats.size,
		};

		return backupInfo;
	}

	/**
	 * List all backups from filesystem
	 * Returns public BackupFileInfo without internal path
	 */
	async listBackups(): Promise<BackupFileInfo[]> {
		const internalBackups = await this.listBackupsInternal();

		// Strip internal path field from public response
		return internalBackups.map(({ path, ...publicInfo }) => publicInfo);
	}

	/**
	 * List all backups with internal path information (server-side only)
	 */
	private async listBackupsInternal(): Promise<BackupFileInfoInternal[]> {
		await ensureBackupsDirectory(this.backupsDir);

		const backups: BackupFileInfoInternal[] = [];
		const types: BackupType[] = ["manual", "scheduled", "update"];

		for (const type of types) {
			const typeDir = path.join(this.backupsDir, type);

			try {
				const files = await fs.readdir(typeDir);

				for (const filename of files) {
					if (!filename.endsWith(".json")) continue;

					const backupPath = path.join(typeDir, filename);
					const stats = await fs.stat(backupPath);

					// Parse timestamp from filename instead of decrypting the file
					const timestamp = parseTimestampFromFilename(filename, stats.mtime);

					backups.push({
						id: generateBackupId(backupPath),
						filename,
						type,
						timestamp,
						size: stats.size,
						path: backupPath,
					});
				}
			} catch (_error) {
				// Type directory doesn't exist yet, skip
			}
		}

		// Sort by timestamp descending (newest first)
		backups.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

		return backups;
	}

	/**
	 * Get a specific backup by ID (public info without path)
	 */
	async getBackupById(id: string): Promise<BackupFileInfo | null> {
		const backups = await this.listBackups();
		return backups.find((b) => b.id === id) || null;
	}

	/**
	 * Get a specific backup by ID with internal path (server-side only)
	 */
	async getBackupByIdInternal(id: string): Promise<BackupFileInfoInternal | null> {
		const backups = await this.listBackupsInternal();
		return backups.find((b) => b.id === id) || null;
	}

	/**
	 * Delete a backup by ID
	 */
	async deleteBackup(id: string): Promise<void> {
		const backup = await this.getBackupByIdInternal(id);
		if (!backup) {
			throw new Error(`Backup with ID ${id} not found`);
		}

		await fs.unlink(backup.path);
	}

	/**
	 * Check if a backup password is configured (either in database or env var)
	 * Returns the source of the password configuration for UI display
	 */
	async getPasswordStatus(): Promise<{
		configured: boolean;
		source: "database" | "environment" | "none";
	}> {
		// Check database first
		if (this.encryptor) {
			const settings = await this.prisma.backupSettings.findUnique({
				where: { id: 1 },
				select: { encryptedPassword: true, passwordIv: true },
			});

			if (settings?.encryptedPassword && settings?.passwordIv) {
				return { configured: true, source: "database" };
			}
		}

		// Check environment variable
		if (process.env.BACKUP_PASSWORD) {
			return { configured: true, source: "environment" };
		}

		return { configured: false, source: "none" };
	}

	/**
	 * Set the backup password in the database (encrypted)
	 * This takes precedence over the BACKUP_PASSWORD environment variable
	 */
	async setPassword(password: string): Promise<void> {
		if (!this.encryptor) {
			throw new Error("Encryptor not available - cannot store encrypted password");
		}

		if (!password || password.length < 8) {
			throw new Error("Password must be at least 8 characters");
		}

		// Encrypt the password
		const { value, iv } = this.encryptor.encrypt(password);

		// Upsert into backup settings
		await this.prisma.backupSettings.upsert({
			where: { id: 1 },
			create: {
				id: 1,
				encryptedPassword: value,
				passwordIv: iv,
			},
			update: {
				encryptedPassword: value,
				passwordIv: iv,
			},
		});
	}

	/**
	 * Remove the backup password from the database
	 * The system will fall back to BACKUP_PASSWORD env var if set
	 */
	async removePassword(): Promise<void> {
		await this.prisma.backupSettings.updateMany({
			where: { id: 1 },
			data: {
				encryptedPassword: null,
				passwordIv: null,
			},
		});
	}

	/**
	 * Restore from a backup file on filesystem
	 * Delegates to restoreBackup which handles both encrypted and plaintext formats
	 */
	async restoreBackupFromFile(id: string): Promise<BackupMetadata> {
		const backup = await this.getBackupByIdInternal(id);
		if (!backup) {
			throw new Error(`Backup with ID ${id} not found`);
		}

		// Optional: Validate file size before reading (defense-in-depth against malicious files)
		// While createBackup enforces ~100 MB limit, manually created or maliciously large backup files
		// could cause OOM errors. Allow slightly larger files than creation limit for flexibility.
		const sizeMB = backup.size / (1024 * 1024);
		if (sizeMB > MAX_RESTORE_SIZE_MB) {
			throw new Error(
				`Backup file too large (${sizeMB.toFixed(1)} MB). Maximum allowed: ${MAX_RESTORE_SIZE_MB} MB`,
			);
		}

		// Read backup file
		const fileContent = await fs.readFile(backup.path, "utf-8");

		// Delegate to restoreBackup which handles both encrypted and plaintext formats
		return this.restoreBackup(fileContent);
	}

	/**
	 * Restore from a backup (accepts both encrypted envelope or plaintext JSON)
	 * For uploaded backups, this receives the base64-decoded backup data
	 */
	async restoreBackup(backupData: string): Promise<BackupMetadata> {
		let parsed: unknown;

		try {
			// Try to parse JSON
			parsed = JSON.parse(backupData);

			// Strictly validate format with type checks to avoid misclassification
			if (isEncryptedBackupEnvelope(parsed)) {
				// It's an encrypted backup - decrypt it
				const password = await this.getBackupPassword();
				const decryptedBackupJson = await decryptBackupData(parsed, password);
				// Re-parse after decryption
				parsed = JSON.parse(decryptedBackupJson);
			} else if (isPlaintextBackup(parsed)) {
				// It's a plaintext backup (legacy format) - parsed already contains the backup data
				// No need to parse again
			} else {
				throw new Error("Invalid backup format: unrecognized structure");
			}
		} catch (error) {
			// Properly extract error message instead of stringifying which becomes "[object Object]"
			const errorMessage = getErrorMessage(error);
			throw new Error(`Failed to parse backup data: ${errorMessage}`);
		}

		// 1. Validate backup structure (parsed now contains the backup object)
		const backup = parsed as BackupData;
		validateBackup(backup);

		// 2. Perform atomic restore with two-phase commit pattern to prevent partial restore
		const secretsBackupPath = `${this.secretsPath}.restore-backup`;
		let secretsBackedUp = false;

		try {
			// Phase 1: Backup current secrets before making any changes
			try {
				const currentSecrets = await fs.readFile(this.secretsPath, "utf-8");
				await fs.writeFile(secretsBackupPath, currentSecrets, { encoding: "utf-8", mode: 0o600 });
				secretsBackedUp = true;
			} catch (error) {
				// If secrets file doesn't exist yet, that's okay - no need to back up
				if (error && typeof error === "object" && "code" in error && error.code !== "ENOENT") {
					throw new Error(`Failed to backup current secrets: ${error}`);
				}
			}

			// Phase 2: Write new secrets
			await writeSecrets(this.secretsPath, backup.secrets);

			// Phase 3: Restore database (in a transaction for atomicity)
			// If this fails, we need to restore the backed-up secrets
			await restoreDatabase(this.prisma, backup.data);

			// Phase 4: Success - clean up backup
			if (secretsBackedUp) {
				await fs.unlink(secretsBackupPath).catch(() => {
					// Ignore errors during cleanup
				});
			}

			// 3. Return metadata
			return {
				version: backup.version,
				appVersion: backup.appVersion,
				timestamp: backup.timestamp,
				dataSize: JSON.stringify(backup).length,
			};
		} catch (error) {
			// Rollback: Restore the backed-up secrets if database restore failed
			if (secretsBackedUp) {
				try {
					const backedUpSecrets = await fs.readFile(secretsBackupPath, "utf-8");
					await fs.writeFile(this.secretsPath, backedUpSecrets, { encoding: "utf-8", mode: 0o600 });
					await fs.chmod(this.secretsPath, 0o600);
					await fs.unlink(secretsBackupPath).catch(() => {
						// Ignore errors during cleanup
					});
				} catch (rollbackError) {
					// Log rollback failure but throw original error
					log.error({ err: rollbackError }, "CRITICAL: Failed to rollback secrets after restore failure");
				}
			}

			// Re-throw the original error
			throw error;
		}
	}
}
