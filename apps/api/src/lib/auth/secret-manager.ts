import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loggers } from "../logger.js";

const log = loggers.auth;

export interface Secrets {
	encryptionKey: string;
	sessionCookieSecret: string;
}

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
	 * Get or create secrets. If secrets file doesn't exist, generates new secrets
	 * and persists them to disk.
	 */
	getOrCreateSecrets(): Secrets {
		// If secrets file exists, load and return
		if (existsSync(this.secretsPath)) {
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
				log.error({ err: error }, "Failed to load secrets, regenerating");
			}
		}

		// Generate new secrets
		const secrets: Secrets = {
			encryptionKey: randomBytes(32).toString("hex"),
			sessionCookieSecret: randomBytes(32).toString("hex"),
		};

		// Ensure directory exists
		const dir = dirname(this.secretsPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		// Persist to disk
		try {
			writeFileSync(this.secretsPath, JSON.stringify(secrets, null, 2), {
				mode: 0o600, // Read/write for owner only
			});
			log.info({ path: this.secretsPath }, "Generated new secrets");
		} catch (error) {
			log.error({ err: error, path: this.secretsPath }, "Failed to persist secrets");
			throw new Error("Could not save secrets to disk");
		}

		return secrets;
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
