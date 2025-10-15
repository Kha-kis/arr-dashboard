import crypto from "node:crypto";
import fs from "node:fs/promises";
import * as fsSync from "node:fs";
import path from "node:path";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BackupData, BackupFileInfo, BackupFileInfoInternal, BackupMetadata } from "@arr/shared";

const BACKUP_VERSION = "1.0";
const PBKDF2_ITERATIONS = 600000; // OWASP recommendation for PBKDF2-SHA256
const KEY_LENGTH = 32; // 256 bits for AES-256

type BackupType = "manual" | "scheduled" | "update";

// Encrypted backup envelope structure
interface EncryptedBackupEnvelope {
	version: string; // Envelope format version
	kdfParams: {
		algorithm: "pbkdf2";
		hash: "sha256";
		iterations: number;
		saltLength: number;
	};
	salt: string; // Base64-encoded salt
	iv: string; // Base64-encoded initialization vector
	tag: string; // Base64-encoded GCM authentication tag
	cipherText: string; // Base64-encoded encrypted backup data
}

export class BackupService {
	private backupsDir: string;

	constructor(
		private prisma: PrismaClient,
		private secretsPath: string,
	) {
		// Set backups directory next to the database file
		const dataDir = path.dirname(secretsPath);
		this.backupsDir = path.join(dataDir, "backups");
	}

	/**
	 * Get the backup password from environment, fail closed in production,
	 * or auto-generate and persist a secure password in development
	 */
	private getBackupPassword(): string {
		// If explicitly set via environment, use it
		const envPassword = process.env.BACKUP_PASSWORD;
		if (envPassword) {
			return envPassword;
		}

		// In production, fail closed - do not allow backups without explicit password
		const isProduction = process.env.NODE_ENV === "production";
		if (isProduction) {
			throw new Error(
				"FATAL: BACKUP_PASSWORD environment variable is required in production. " +
				"Set a strong password to enable encrypted backups."
			);
		}

		// In development, generate and persist a secure random password
		return this.getOrGenerateDevBackupPassword();
	}

	/**
	 * Get or generate a development backup password
	 * Generates a cryptographically strong random password and persists it to secrets.json
	 */
	private getOrGenerateDevBackupPassword(): string {
		try {
			// Try to read existing secrets file
			const secretsContent = fsSync.readFileSync(this.secretsPath, "utf-8");
			const secrets = JSON.parse(secretsContent);

			// If backup password already exists, return it
			if (secrets.backupPassword && typeof secrets.backupPassword === "string") {
				return secrets.backupPassword;
			}

			// Generate new password and merge with existing secrets
			const newPassword = crypto.randomBytes(32).toString("base64");
			const updatedSecrets = { ...secrets, backupPassword: newPassword };

			// Write atomically with restrictive permissions
			const tempPath = `${this.secretsPath}.tmp`;
			fsSync.writeFileSync(tempPath, JSON.stringify(updatedSecrets, null, 2), {
				encoding: "utf-8",
				mode: 0o600
			});
			fsSync.renameSync(tempPath, this.secretsPath);
			fsSync.chmodSync(this.secretsPath, 0o600);

			console.log("Generated new backup password for development (stored in secrets.json)");
			return newPassword;
		} catch (error) {
			// If secrets file doesn't exist, create it with just the backup password
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
				const newPassword = crypto.randomBytes(32).toString("base64");
				const secrets = { backupPassword: newPassword };

				try {
					// Ensure directory exists
					const dir = path.dirname(this.secretsPath);
					fsSync.mkdirSync(dir, { recursive: true });

					// Write with restrictive permissions
					fsSync.writeFileSync(this.secretsPath, JSON.stringify(secrets, null, 2), {
						encoding: "utf-8",
						mode: 0o600
					});
					fsSync.chmodSync(this.secretsPath, 0o600);

					console.log("Created secrets.json with generated backup password for development");
					return newPassword;
				} catch (writeError) {
					throw new Error(`Failed to create secrets file: ${writeError}`);
				}
			}

			throw new Error(`Failed to read/write secrets file: ${error}`);
		}
	}

	/**
	 * Encrypt backup data using password-based encryption
	 * Uses PBKDF2 for key derivation and AES-256-GCM for encryption
	 */
	private encryptBackup(backupJson: string): EncryptedBackupEnvelope {
		const password = this.getBackupPassword();

		// Generate random salt for PBKDF2
		const salt = crypto.randomBytes(32);

		// Derive encryption key from password using PBKDF2
		const key = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, "sha256");

		// Generate random IV for AES-GCM
		const iv = crypto.randomBytes(16);

		// Create cipher
		const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

		// Encrypt the backup data
		const encrypted = Buffer.concat([cipher.update(backupJson, "utf8"), cipher.final()]);

		// Get authentication tag
		const tag = cipher.getAuthTag();

		// Return encrypted envelope
		return {
			version: "1.0",
			kdfParams: {
				algorithm: "pbkdf2",
				hash: "sha256",
				iterations: PBKDF2_ITERATIONS,
				saltLength: salt.length,
			},
			salt: salt.toString("base64"),
			iv: iv.toString("base64"),
			tag: tag.toString("base64"),
			cipherText: encrypted.toString("base64"),
		};
	}

	/**
	 * Decrypt backup data using password-based encryption
	 * Verifies authentication tag to ensure data integrity
	 */
	private decryptBackup(envelope: EncryptedBackupEnvelope): string {
		const password = this.getBackupPassword();

		// Validate envelope version
		if (envelope.version !== "1.0") {
			throw new Error(`Unsupported encrypted backup version: ${envelope.version}`);
		}

		// Validate KDF parameters
		if (envelope.kdfParams.algorithm !== "pbkdf2" || envelope.kdfParams.hash !== "sha256") {
			throw new Error("Unsupported KDF algorithm or hash");
		}

		// Decode base64 values
		const salt = Buffer.from(envelope.salt, "base64");
		const iv = Buffer.from(envelope.iv, "base64");
		const tag = Buffer.from(envelope.tag, "base64");
		const cipherText = Buffer.from(envelope.cipherText, "base64");

		// Derive decryption key using stored KDF parameters
		const key = crypto.pbkdf2Sync(
			password,
			salt,
			envelope.kdfParams.iterations,
			KEY_LENGTH,
			"sha256"
		);

		// Create decipher
		const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
		decipher.setAuthTag(tag);

		try {
			// Decrypt and verify authentication tag
			const decrypted = Buffer.concat([decipher.update(cipherText), decipher.final()]);
			return decrypted.toString("utf8");
		} catch (error) {
			throw new Error("Failed to decrypt backup: invalid password or corrupted data");
		}
	}

	/**
	 * Create a backup and save it to filesystem (encrypted)
	 */
	async createBackup(
		appVersion: string,
		type: BackupType = "manual",
	): Promise<BackupFileInfo> {
		// 1. Ensure backups directory exists
		await this.ensureBackupsDirectory();

		// 2. Export all database data
		const data = await this.exportDatabase();

		// 3. Read secrets file
		const secrets = await this.readSecrets();

		// 4. Create backup structure
		const backup: BackupData = {
			version: BACKUP_VERSION,
			appVersion,
			timestamp: new Date().toISOString(),
			data,
			secrets,
		};

		// 5. Convert to JSON
		const backupJson = JSON.stringify(backup);

		// 6. Encrypt the backup data
		const encryptedEnvelope = this.encryptBackup(backupJson);

		// 7. Convert encrypted envelope to JSON (pretty-printed for storage)
		const envelopeJson = JSON.stringify(encryptedEnvelope, null, 2);

		// 8. Generate filename
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const filename = `arr-dashboard-backup-${timestamp}.json`;

		// 9. Determine backup path (organized by type)
		const typeDir = path.join(this.backupsDir, type);
		await fs.mkdir(typeDir, { recursive: true });
		const backupPath = path.join(typeDir, filename);

		// 10. Save encrypted backup to file with restrictive permissions (owner read/write only)
		await fs.writeFile(backupPath, envelopeJson, { encoding: "utf-8", mode: 0o600 });

		// Fallback: explicitly set permissions to ensure they're enforced
		// This handles cases where the file system doesn't support mode during creation
		await fs.chmod(backupPath, 0o600);

		// 11. Get file stats
		const stats = await fs.stat(backupPath);

		// 12. Create backup info (excluding internal path from public response)
		const backupInfo: BackupFileInfo = {
			id: this.generateBackupId(backupPath),
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
		await this.ensureBackupsDirectory();

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

					// Read the actual timestamp from the encrypted backup file
					let timestamp: string;
					try {
						const fileContent = await fs.readFile(backupPath, "utf-8");
						const envelope = JSON.parse(fileContent) as EncryptedBackupEnvelope;

						// Decrypt to get the original backup data
						const decryptedJson = this.decryptBackup(envelope);
						const backupData = JSON.parse(decryptedJson) as BackupData;
						timestamp = backupData.timestamp;
					} catch {
						// If we can't decrypt/read the file, use the file modification time
						timestamp = stats.mtime.toISOString();
					}

					backups.push({
						id: this.generateBackupId(backupPath),
						filename,
						type,
						timestamp,
						size: stats.size,
						path: backupPath,
					});
				}
			} catch (error) {
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
	 * Restore from a backup file on filesystem
	 */
	async restoreBackupFromFile(id: string): Promise<BackupMetadata> {
		const backup = await this.getBackupByIdInternal(id);
		if (!backup) {
			throw new Error(`Backup with ID ${id} not found`);
		}

		// Read encrypted backup file
		const fileContent = await fs.readFile(backup.path, "utf-8");

		// Parse as encrypted envelope
		const envelope = JSON.parse(fileContent) as EncryptedBackupEnvelope;

		// Decrypt to get original backup data
		const backupData = this.decryptBackup(envelope);

		// Use existing restore logic
		return this.restoreBackup(backupData);
	}

	/**
	 * Restore from a backup (accepts both encrypted envelope or plaintext JSON)
	 * For uploaded backups, this receives the base64-decoded backup data
	 */
	async restoreBackup(backupData: string): Promise<BackupMetadata> {
		let decryptedBackupJson: string;

		try {
			// Try to parse as encrypted envelope first
			const parsed = JSON.parse(backupData);

			// Check if it's an encrypted envelope
			if (parsed.version && parsed.kdfParams && parsed.salt && parsed.iv && parsed.cipherText) {
				// It's an encrypted backup
				decryptedBackupJson = this.decryptBackup(parsed as EncryptedBackupEnvelope);
			} else if (parsed.version && parsed.data && parsed.secrets) {
				// It's a plaintext backup (legacy format)
				decryptedBackupJson = backupData;
			} else {
				throw new Error("Invalid backup format: unrecognized structure");
			}
		} catch (error) {
			throw new Error(`Failed to parse backup data: ${error}`);
		}

		// 1. Parse and validate decrypted backup structure
		const backup = JSON.parse(decryptedBackupJson) as BackupData;
		this.validateBackup(backup);

		// 2. Restore database (in a transaction for atomicity)
		await this.restoreDatabase(backup.data);

		// 3. Restore secrets file
		await this.writeSecrets(backup.secrets);

		// 4. Return metadata
		return {
			version: backup.version,
			appVersion: backup.appVersion,
			timestamp: backup.timestamp,
			dataSize: decryptedBackupJson.length,
		};
	}

	/**
	 * Export all database tables
	 */
	private async exportDatabase() {
		// Export all tables in parallel
		const [
			users,
			sessions,
			serviceInstances,
			serviceTags,
			serviceInstanceTags,
			oidcProviders,
			oidcAccounts,
			webAuthnCredentials,
		] = await Promise.all([
			this.prisma.user.findMany(),
			this.prisma.session.findMany(),
			this.prisma.serviceInstance.findMany(),
			this.prisma.serviceTag.findMany(),
			this.prisma.serviceInstanceTag.findMany(),
			this.prisma.oIDCProvider.findMany(),
			this.prisma.oIDCAccount.findMany(),
			this.prisma.webAuthnCredential.findMany(),
		]);

		return {
			users,
			sessions,
			serviceInstances,
			serviceTags,
			serviceInstanceTags,
			oidcProviders,
			oidcAccounts,
			webAuthnCredentials,
		};
	}

	/**
	 * Restore database from backup data
	 */
	private async restoreDatabase(data: BackupData["data"]) {
		// Use a transaction to ensure atomicity
		await this.prisma.$transaction(async (tx) => {
			// Delete all existing data (in reverse order of dependencies)
			await tx.serviceInstanceTag.deleteMany();
			await tx.serviceTag.deleteMany();
			await tx.serviceInstance.deleteMany();
			await tx.webAuthnCredential.deleteMany();
			await tx.oIDCAccount.deleteMany();
			await tx.oIDCProvider.deleteMany();
			await tx.session.deleteMany();
			await tx.user.deleteMany();

			// Restore data (in order of dependencies)
			// Users first (no dependencies)
			for (const user of data.users) {
				await tx.user.create({ data: user as Prisma.UserCreateInput });
			}

			// Sessions (depend on users)
			for (const session of data.sessions) {
				await tx.session.create({ data: session as Prisma.SessionCreateInput });
			}

			// OIDC providers (no dependencies) - optional for backward compatibility
			if (data.oidcProviders) {
				for (const provider of data.oidcProviders) {
					await tx.oIDCProvider.create({ data: provider as Prisma.OIDCProviderCreateInput });
				}
			}

			// OIDC accounts (depend on users)
			for (const oidcAccount of data.oidcAccounts) {
				await tx.oIDCAccount.create({ data: oidcAccount as Prisma.OIDCAccountCreateInput });
			}

			// WebAuthn credentials (depend on users)
			for (const credential of data.webAuthnCredentials) {
				await tx.webAuthnCredential.create({ data: credential as Prisma.WebAuthnCredentialCreateInput });
			}

			// Service instances (no user dependency based on schema)
			for (const instance of data.serviceInstances) {
				await tx.serviceInstance.create({ data: instance as Prisma.ServiceInstanceCreateInput });
			}

			// Service tags (no dependencies)
			for (const tag of data.serviceTags) {
				await tx.serviceTag.create({ data: tag as Prisma.ServiceTagCreateInput });
			}

			// Service instance tags (depend on instances and tags)
			for (const instanceTag of data.serviceInstanceTags) {
				await tx.serviceInstanceTag.create({ data: instanceTag as Prisma.ServiceInstanceTagCreateInput });
			}
		});
	}

	/**
	 * Read secrets from secrets.json
	 */
	private async readSecrets(): Promise<BackupData["secrets"]> {
		try {
			const secretsContent = await fs.readFile(this.secretsPath, "utf-8");
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
	private async writeSecrets(secrets: BackupData["secrets"]): Promise<void> {
		try {
			// Read existing secrets to preserve fields not in backup (e.g., backupPassword)
			let existingSecrets: Record<string, unknown> = {};
			try {
				const existingContent = await fs.readFile(this.secretsPath, "utf-8");
				existingSecrets = JSON.parse(existingContent);
			} catch {
				// File doesn't exist or is invalid, start with empty object
			}

			// Merge backup secrets with existing ones
			// Backup secrets take precedence, but existing fields are preserved
			const mergedSecrets = { ...existingSecrets, ...secrets };

			const secretsContent = JSON.stringify(mergedSecrets, null, 2);
			// Write with restrictive permissions (owner read/write only)
			await fs.writeFile(this.secretsPath, secretsContent, { encoding: "utf-8", mode: 0o600 });

			// Fallback: explicitly set permissions to ensure they're enforced
			// This handles cases where the file existed with different permissions
			await fs.chmod(this.secretsPath, 0o600);
		} catch (error) {
			throw new Error(`Failed to write secrets file: ${error}`);
		}
	}

	/**
	 * Ensure backups directory exists
	 */
	private async ensureBackupsDirectory(): Promise<void> {
		await fs.mkdir(this.backupsDir, { recursive: true });
	}

	/**
	 * Generate a unique ID for a backup based on its path
	 */
	private generateBackupId(backupPath: string): string {
		// Use SHA-256 hash of the path as the ID
		return crypto.createHash("sha256").update(backupPath).digest("hex").substring(0, 16);
	}

	/**
	 * Validate backup structure
	 */
	private validateBackup(backup: unknown): asserts backup is BackupData {
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
		// oidcProviders was added later, so old backups may not have it
		if (b.data.oidcProviders !== undefined && !Array.isArray(b.data.oidcProviders)) {
			throw new Error("Invalid backup format: oidcProviders must be an array");
		}

		// Validate required secret fields
		if (
			typeof b.secrets.encryptionKey !== "string" ||
			typeof b.secrets.sessionCookieSecret !== "string"
		) {
			throw new Error("Invalid backup format: missing or invalid secrets");
		}
	}

}
