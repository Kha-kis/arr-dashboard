/**
 * Backup Encryption/Decryption
 *
 * Pure cryptographic operations for backup data using PBKDF2 key derivation
 * and AES-256-GCM authenticated encryption.
 */

import crypto from "node:crypto";

export const PBKDF2_ITERATIONS = 600000; // OWASP recommendation for PBKDF2-SHA256
export const KEY_LENGTH = 32; // 256 bits for AES-256

/** Encrypted backup envelope structure */
export interface EncryptedBackupEnvelope {
	version: string;
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

/**
 * Derive encryption key from password using PBKDF2
 * Uses async crypto.pbkdf2 to avoid blocking the event loop
 */
export function deriveKey(password: string, salt: Buffer, iterations: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		crypto.pbkdf2(password, salt, iterations, KEY_LENGTH, "sha256", (err, derivedKey) => {
			if (err) {
				reject(err);
			} else {
				resolve(derivedKey);
			}
		});
	});
}

/**
 * Encrypt backup data using password-based encryption
 * Uses PBKDF2 for key derivation and AES-256-GCM for encryption
 */
export async function encryptBackupData(
	backupJson: string,
	password: string,
): Promise<EncryptedBackupEnvelope> {
	// Generate random salt for PBKDF2
	const salt = crypto.randomBytes(32);

	// Derive encryption key from password using PBKDF2 (async to avoid blocking event loop)
	const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);

	// Generate random IV for AES-GCM (12 bytes is optimal for GCM per NIST recommendation)
	const iv = crypto.randomBytes(12);

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
export async function decryptBackupData(
	envelope: EncryptedBackupEnvelope,
	password: string,
): Promise<string> {
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

	// Sanity check decoded buffer lengths to fail fast on malformed input
	if (salt.length !== 32) {
		throw new Error(`Invalid salt length: expected 32 bytes, got ${salt.length}`);
	}
	if (iv.length !== 12) {
		throw new Error(`Invalid IV length: expected 12 bytes, got ${iv.length}`);
	}
	if (tag.length !== 16) {
		throw new Error(`Invalid auth tag length: expected 16 bytes, got ${tag.length}`);
	}
	if (cipherText.length === 0) {
		throw new Error("Invalid ciphertext: empty buffer");
	}

	// Derive decryption key using stored KDF parameters (async to avoid blocking event loop)
	const key = await deriveKey(password, salt, envelope.kdfParams.iterations);

	// Create decipher
	const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAuthTag(tag);

	try {
		// Decrypt and verify authentication tag
		const decrypted = Buffer.concat([decipher.update(cipherText), decipher.final()]);
		return decrypted.toString("utf8");
	} catch (_error) {
		throw new Error("Failed to decrypt backup: invalid password or corrupted data");
	}
}
