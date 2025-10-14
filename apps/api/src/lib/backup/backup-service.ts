import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import type { BackupData, BackupFileInfo, BackupMetadata } from "@arr/shared";

const BACKUP_VERSION = "1.0";

type BackupType = "manual" | "scheduled" | "update";

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
	 * Create a backup and save it to filesystem (unencrypted JSON)
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

		// 5. Convert to JSON (pretty-printed for readability)
		const backupJson = JSON.stringify(backup, null, 2);

		// 6. Generate filename
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const filename = `arr-dashboard-backup-${timestamp}.json`;

		// 7. Determine backup path (organized by type)
		const typeDir = path.join(this.backupsDir, type);
		await fs.mkdir(typeDir, { recursive: true });
		const backupPath = path.join(typeDir, filename);

		// 8. Save backup to file
		await fs.writeFile(backupPath, backupJson, "utf-8");

		// 9. Get file stats
		const stats = await fs.stat(backupPath);

		// 10. Create backup info
		const backupInfo: BackupFileInfo = {
			id: this.generateBackupId(backupPath),
			filename,
			type,
			timestamp: backup.timestamp,
			size: stats.size,
			path: backupPath,
		};

		return backupInfo;
	}

	/**
	 * List all backups from filesystem
	 */
	async listBackups(): Promise<BackupFileInfo[]> {
		await this.ensureBackupsDirectory();

		const backups: BackupFileInfo[] = [];
		const types: BackupType[] = ["manual", "scheduled", "update"];

		for (const type of types) {
			const typeDir = path.join(this.backupsDir, type);

			try {
				const files = await fs.readdir(typeDir);

				for (const filename of files) {
					if (!filename.endsWith(".json")) continue;

					const backupPath = path.join(typeDir, filename);
					const stats = await fs.stat(backupPath);

					// Read the actual timestamp from the backup file
					let timestamp: string;
					try {
						const backupContent = await fs.readFile(backupPath, "utf-8");
						const backupData = JSON.parse(backupContent) as BackupData;
						timestamp = backupData.timestamp;
					} catch {
						// If we can't read the file, use the file modification time
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
				continue;
			}
		}

		// Sort by timestamp descending (newest first)
		backups.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

		return backups;
	}

	/**
	 * Get a specific backup by ID
	 */
	async getBackupById(id: string): Promise<BackupFileInfo | null> {
		const backups = await this.listBackups();
		return backups.find((b) => b.id === id) || null;
	}

	/**
	 * Delete a backup by ID
	 */
	async deleteBackup(id: string): Promise<void> {
		const backup = await this.getBackupById(id);
		if (!backup) {
			throw new Error(`Backup with ID ${id} not found`);
		}

		await fs.unlink(backup.path);
	}

	/**
	 * Restore from a backup file on filesystem
	 */
	async restoreBackupFromFile(id: string): Promise<BackupMetadata> {
		const backup = await this.getBackupById(id);
		if (!backup) {
			throw new Error(`Backup with ID ${id} not found`);
		}

		// Read backup file
		const backupData = await fs.readFile(backup.path, "utf-8");

		// Use existing restore logic
		return this.restoreBackup(backupData);
	}

	/**
	 * Restore from a backup (JSON format)
	 */
	async restoreBackup(backupData: string): Promise<BackupMetadata> {
		// 1. Parse and validate backup structure
		const backup = JSON.parse(backupData) as BackupData;
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
			dataSize: backupData.length,
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
				await tx.user.create({ data: user as any });
			}

			// Sessions (depend on users)
			for (const session of data.sessions) {
				await tx.session.create({ data: session as any });
			}

			// OIDC providers (no dependencies) - optional for backward compatibility
			if (data.oidcProviders) {
				for (const provider of data.oidcProviders) {
					await tx.oIDCProvider.create({ data: provider as any });
				}
			}

			// OIDC accounts (depend on users)
			for (const oidcAccount of data.oidcAccounts) {
				await tx.oIDCAccount.create({ data: oidcAccount as any });
			}

			// WebAuthn credentials (depend on users)
			for (const credential of data.webAuthnCredentials) {
				await tx.webAuthnCredential.create({ data: credential as any });
			}

			// Service instances (no user dependency based on schema)
			for (const instance of data.serviceInstances) {
				await tx.serviceInstance.create({ data: instance as any });
			}

			// Service tags (no dependencies)
			for (const tag of data.serviceTags) {
				await tx.serviceTag.create({ data: tag as any });
			}

			// Service instance tags (depend on instances and tags)
			for (const instanceTag of data.serviceInstanceTags) {
				await tx.serviceInstanceTag.create({ data: instanceTag as any });
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
	 * Write secrets to secrets.json
	 */
	private async writeSecrets(secrets: BackupData["secrets"]): Promise<void> {
		try {
			const secretsContent = JSON.stringify(secrets, null, 2);
			await fs.writeFile(this.secretsPath, secretsContent, "utf-8");
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

		for (const field of requiredFields) {
			if (!Array.isArray((b.data as any)[field])) {
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
