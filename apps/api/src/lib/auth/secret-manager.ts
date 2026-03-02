import { randomBytes } from "node:crypto";
import {
	copyFileSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { loggers } from "../logger.js";

const log = loggers.auth;

export interface Secrets {
	encryptionKey: string;
	sessionCookieSecret: string;
}

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
	getOrCreateSecrets(): Secrets {
		// Try to load existing secrets (no existence check to avoid TOCTOU race)
		try {
			const content = readFileSync(this.secretsPath, "utf-8");
			const secrets = JSON.parse(content) as Secrets;

			// Validate loaded secrets
			if (this.isValidSecrets(secrets)) {
				return secrets;
			}

			// Invalid format, will regenerate below
			log.warn("Invalid secrets format, regenerating");
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
			return migrated;
		}

		// Generate new secrets
		const secrets: Secrets = {
			encryptionKey: randomBytes(32).toString("hex"),
			sessionCookieSecret: randomBytes(32).toString("hex"),
		};

		// Ensure directory exists (recursive is idempotent)
		mkdirSync(dirname(this.secretsPath), { recursive: true });

		// Persist to disk atomically (write to temp, then rename)
		const tmpPath = `${this.secretsPath}.tmp`;
		try {
			writeFileSync(tmpPath, JSON.stringify(secrets, null, 2), {
				mode: 0o600, // Read/write for owner only
			});
			renameSync(tmpPath, this.secretsPath);
			log.info({ path: this.secretsPath }, "Generated new secrets");
		} catch (error) {
			log.error({ err: error, path: this.secretsPath }, "Failed to persist secrets");
			throw new Error("Could not save secrets to disk");
		}

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
				const secrets = JSON.parse(content) as Secrets;

				if (!this.isValidSecrets(secrets)) {
					log.warn(
						{ legacyPath },
						"Found legacy secrets file but format is invalid, skipping",
					);
					continue;
				}

				// Migrate: copy legacy file to the new path
				log.info(
					{ from: legacyPath, to: this.secretsPath },
					"Migrating secrets from legacy path (v2.8.x upgrade)",
				);
				mkdirSync(dirname(this.secretsPath), { recursive: true });
				copyFileSync(legacyPath, this.secretsPath);

				return secrets;
			} catch {
				// File doesn't exist or can't be read — try next legacy path
				continue;
			}
		}

		return null;
	}

	private isValidSecrets(secrets: unknown): secrets is Secrets {
		if (!secrets || typeof secrets !== "object") {
			return false;
		}

		const s = secrets as Record<string, unknown>;
		return (
			typeof s.encryptionKey === "string" &&
			s.encryptionKey.length === 64 && // 32 bytes in hex
			typeof s.sessionCookieSecret === "string" &&
			s.sessionCookieSecret.length === 64
		);
	}
}
