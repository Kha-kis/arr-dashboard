import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import type { BackupData, BackupMetadata } from "@arr/shared";

const BACKUP_VERSION = "1.0";
const PBKDF2_ITERATIONS = 100000;
const PBKDF2_KEY_LENGTH = 32; // 256 bits for AES-256
const PBKDF2_DIGEST = "sha256";

export class BackupService {
	constructor(
		private prisma: PrismaClient,
		private secretsPath: string,
	) {}

	/**
	 * Create an encrypted backup of the database and secrets
	 */
	async createBackup(password: string, appVersion: string): Promise<{
		encryptedBackup: string;
		metadata: BackupMetadata;
		filename: string;
	}> {
		// 1. Export all database data
		const data = await this.exportDatabase();

		// 2. Read secrets file
		const secrets = await this.readSecrets();

		// 3. Create backup structure
		const backup: BackupData = {
			version: BACKUP_VERSION,
			appVersion,
			timestamp: new Date().toISOString(),
			data,
			secrets,
		};

		// 4. Encrypt the backup
		const backupJson = JSON.stringify(backup);
		const encryptedBackup = this.encrypt(backupJson, password);

		// 5. Generate metadata
		const metadata: BackupMetadata = {
			version: BACKUP_VERSION,
			appVersion,
			timestamp: backup.timestamp,
			dataSize: backupJson.length,
		};

		// 6. Generate filename
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const filename = `arr-dashboard-backup-${timestamp}.enc`;

		return {
			encryptedBackup,
			metadata,
			filename,
		};
	}

	/**
	 * Restore from an encrypted backup
	 */
	async restoreBackup(encryptedBackup: string, password: string): Promise<BackupMetadata> {
		// 1. Decrypt the backup
		const decryptedBackup = this.decrypt(encryptedBackup, password);

		// 2. Parse and validate backup structure
		const backup = JSON.parse(decryptedBackup) as BackupData;
		this.validateBackup(backup);

		// 3. Restore database (in a transaction for atomicity)
		await this.restoreDatabase(backup.data);

		// 4. Restore secrets file
		await this.writeSecrets(backup.secrets);

		// 5. Return metadata
		return {
			version: backup.version,
			appVersion: backup.appVersion,
			timestamp: backup.timestamp,
			dataSize: decryptedBackup.length,
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
			oidcAccounts,
			webAuthnCredentials,
		] = await Promise.all([
			this.prisma.user.findMany(),
			this.prisma.session.findMany(),
			this.prisma.serviceInstance.findMany(),
			this.prisma.serviceTag.findMany(),
			this.prisma.serviceInstanceTag.findMany(),
			this.prisma.oIDCAccount.findMany(),
			this.prisma.webAuthnCredential.findMany(),
		]);

		return {
			users,
			sessions,
			serviceInstances,
			serviceTags,
			serviceInstanceTags,
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
			await tx.oIDCAuthState.deleteMany();
			await tx.webAuthnChallenge.deleteMany();
			await tx.serviceInstanceTag.deleteMany();
			await tx.serviceTag.deleteMany();
			await tx.serviceInstance.deleteMany();
			await tx.webAuthnCredential.deleteMany();
			await tx.oIDCAccount.deleteMany();
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

			// Service instances (depend on users)
			for (const instance of data.serviceInstances) {
				await tx.serviceInstance.create({ data: instance as any });
			}

			// Service tags (depend on users)
			for (const tag of data.serviceTags) {
				await tx.serviceTag.create({ data: tag as any });
			}

			// Service instance tags (depend on instances and tags)
			for (const instanceTag of data.serviceInstanceTags) {
				await tx.serviceInstanceTag.create({ data: instanceTag as any });
			}

			// OIDC accounts (depend on users)
			for (const oidcAccount of data.oidcAccounts) {
				await tx.oIDCAccount.create({ data: oidcAccount as any });
			}

			// WebAuthn credentials (depend on users)
			for (const credential of data.webAuthnCredentials) {
				await tx.webAuthnCredential.create({ data: credential as any });
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

		// Validate required secret fields
		if (
			typeof b.secrets.encryptionKey !== "string" ||
			typeof b.secrets.sessionCookieSecret !== "string"
		) {
			throw new Error("Invalid backup format: missing or invalid secrets");
		}
	}

	/**
	 * Encrypt data using password-based AES-256-GCM encryption
	 */
	private encrypt(plaintext: string, password: string): string {
		// Generate random salt and IV
		const salt = crypto.randomBytes(32);
		const iv = crypto.randomBytes(16);

		// Derive key from password using PBKDF2
		const key = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH, PBKDF2_DIGEST);

		// Encrypt using AES-256-GCM
		const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
		const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
		const authTag = cipher.getAuthTag();

		// Combine salt + iv + authTag + encrypted data
		const combined = Buffer.concat([salt, iv, authTag, encrypted]);

		// Return as base64
		return combined.toString("base64");
	}

	/**
	 * Decrypt data using password-based AES-256-GCM decryption
	 */
	private decrypt(encryptedData: string, password: string): string {
		try {
			// Decode from base64
			const combined = Buffer.from(encryptedData, "base64");

			// Extract components
			const salt = combined.subarray(0, 32);
			const iv = combined.subarray(32, 48);
			const authTag = combined.subarray(48, 64);
			const encrypted = combined.subarray(64);

			// Derive key from password using PBKDF2
			const key = crypto.pbkdf2Sync(
				password,
				salt,
				PBKDF2_ITERATIONS,
				PBKDF2_KEY_LENGTH,
				PBKDF2_DIGEST,
			);

			// Decrypt using AES-256-GCM
			const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
			decipher.setAuthTag(authTag);

			const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

			return decrypted.toString("utf8");
		} catch (error) {
			throw new Error("Failed to decrypt backup: invalid password or corrupted data");
		}
	}
}
