import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loggers } from "../logger.js";
import { isValidEncryptionKey } from "./encryption.js";

const log = loggers.auth;

export interface Secrets {
	encryptionKey: string;
	sessionCookieSecret: string;
	/**
	 * Identifies this local installation independently of database contents.
	 * Backups intentionally omit it so restoring a database cannot make two
	 * live dashboard installations claim the same external resources.
	 */
	installationId: string;
}

type StoredSecrets = Omit<Secrets, "installationId"> & {
	installationId?: unknown;
	[key: string]: unknown;
};

type SecretOverrides = Partial<Pick<Secrets, "encryptionKey" | "sessionCookieSecret">>;

/**
 * Known legacy secrets paths from previous versions.
 * When the primary path doesn't exist, these are checked in order
 * to migrate secrets from an older installation (e.g., v2.8.x → v2.9).
 */
const LEGACY_SECRETS_PATHS = [
	"/app/api/data/secrets.json", // v2.8.x PostgreSQL Docker default
];

/**
 * Manages persistent secrets for the application.
 * Auto-generates secrets on first run and persists them to disk.
 */
export class SecretManager {
	private readonly secretsPath: string;

	constructor(secretsPath: string) {
		this.secretsPath = secretsPath;
	}

	/**
	 * Get or create secrets. If secrets file doesn't exist, checks legacy paths
	 * for migration before generating new secrets.
	 */
	getOrCreateSecrets(overrides: SecretOverrides = {}): Secrets {
		if (overrides.encryptionKey && !isValidEncryptionKey(overrides.encryptionKey)) {
			throw new Error("ENCRYPTION_KEY must decode to 32 bytes");
		}
		if (overrides.sessionCookieSecret && overrides.sessionCookieSecret.length < 32) {
			throw new Error("SESSION_COOKIE_SECRET must be at least 32 characters");
		}

		let preservedLocalFields: Record<string, unknown> = {};

		// Try to load existing secrets (no existence check to avoid TOCTOU race)
		try {
			const content = readFileSync(this.secretsPath, "utf-8");
			const secrets: unknown = JSON.parse(content);
			if (secrets && typeof secrets === "object") {
				preservedLocalFields = secrets as Record<string, unknown>;
			}

			// Validate loaded secrets
			if (this.isValidSecrets(secrets)) {
				return this.applyOverrides(this.ensureInstallationId(secrets), overrides);
			}

			// Missing or invalid cryptographic fields are resolved below while
			// preserving parseable deployment-local metadata.
			log.warn("Secrets file is missing required cryptographic fields");
		} catch (error) {
			// ENOENT is expected on first run — only log unexpected errors
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				log.error({ err: error }, "Failed to load secrets, regenerating");
			}
		}

		// Before generating new secrets, check legacy paths for migration.
		// This prevents data loss when upgrading from v2.8.x where PostgreSQL
		// secrets were stored at /app/api/data/secrets.json instead of /config/.
		const migrated = this.tryMigrateLegacySecrets();
		if (migrated) {
			return this.applyOverrides(migrated, overrides);
		}

		// Generate new secrets
		const secrets: Secrets = {
			...preservedLocalFields,
			encryptionKey:
				overrides.encryptionKey ??
				(typeof preservedLocalFields.encryptionKey === "string" &&
				isValidEncryptionKey(preservedLocalFields.encryptionKey)
					? preservedLocalFields.encryptionKey
					: randomBytes(32).toString("hex")),
			sessionCookieSecret:
				overrides.sessionCookieSecret ??
				(typeof preservedLocalFields.sessionCookieSecret === "string" &&
				preservedLocalFields.sessionCookieSecret.length >= 32
					? preservedLocalFields.sessionCookieSecret
					: randomBytes(32).toString("hex")),
			installationId:
				typeof preservedLocalFields.installationId === "string" &&
				/^[a-f0-9]{32}$/.test(preservedLocalFields.installationId)
					? preservedLocalFields.installationId
					: randomBytes(16).toString("hex"),
		};

		this.persistSecrets(secrets);
		log.info({ path: this.secretsPath }, "Generated new secrets");

		return secrets;
	}

	/**
	 * Check legacy secrets paths and migrate if found.
	 * Returns the migrated secrets, or null if no legacy file was found.
	 */
	private tryMigrateLegacySecrets(): Secrets | null {
		for (const legacyPath of LEGACY_SECRETS_PATHS) {
			// Skip if the legacy path is the same as the current path
			if (legacyPath === this.secretsPath) {
				continue;
			}

			try {
				const content = readFileSync(legacyPath, "utf-8");
				const secrets: unknown = JSON.parse(content);

				if (!this.isValidSecrets(secrets)) {
					log.warn({ legacyPath }, "Found legacy secrets file but format is invalid, skipping");
					continue;
				}

				// Migrate: copy legacy file to the new path
				log.info(
					{ from: legacyPath, to: this.secretsPath },
					"Migrating secrets from legacy path (v2.8.x upgrade)",
				);
				mkdirSync(dirname(this.secretsPath), { recursive: true });
				copyFileSync(legacyPath, this.secretsPath);

				return this.ensureInstallationId(secrets);
			} catch {
				// File doesn't exist or can't be read — try next legacy path
			}
		}

		return null;
	}

	private applyOverrides(secrets: Secrets, overrides: SecretOverrides): Secrets {
		const resolved: Secrets = {
			...secrets,
			...(overrides.encryptionKey ? { encryptionKey: overrides.encryptionKey } : {}),
			...(overrides.sessionCookieSecret
				? { sessionCookieSecret: overrides.sessionCookieSecret }
				: {}),
		};
		if (
			resolved.encryptionKey !== secrets.encryptionKey ||
			resolved.sessionCookieSecret !== secrets.sessionCookieSecret
		) {
			this.persistSecrets(resolved);
			log.info({ path: this.secretsPath }, "Synchronized active environment secrets");
		}
		return resolved;
	}

	private ensureInstallationId(secrets: StoredSecrets): Secrets {
		if (
			typeof secrets.installationId === "string" &&
			/^[a-f0-9]{32}$/.test(secrets.installationId)
		) {
			return secrets as Secrets;
		}

		const upgraded: Secrets = {
			...secrets,
			installationId: randomBytes(16).toString("hex"),
		};
		this.persistSecrets(upgraded);
		log.info({ path: this.secretsPath }, "Added local installation identity");
		return upgraded;
	}

	private persistSecrets(secrets: Secrets): void {
		mkdirSync(dirname(this.secretsPath), { recursive: true });
		const tmpPath = `${this.secretsPath}.tmp`;
		try {
			writeFileSync(tmpPath, JSON.stringify(secrets, null, 2), {
				mode: 0o600,
			});
			renameSync(tmpPath, this.secretsPath);
		} catch (error) {
			log.error({ err: error, path: this.secretsPath }, "Failed to persist secrets");
			throw new Error("Could not save secrets to disk");
		}
	}

	private isValidSecrets(secrets: unknown): secrets is StoredSecrets {
		if (!secrets || typeof secrets !== "object") {
			return false;
		}

		const s = secrets as Record<string, unknown>;
		return (
			typeof s.encryptionKey === "string" &&
			isValidEncryptionKey(s.encryptionKey) &&
			typeof s.sessionCookieSecret === "string" &&
			s.sessionCookieSecret.length >= 32
		);
	}
}
