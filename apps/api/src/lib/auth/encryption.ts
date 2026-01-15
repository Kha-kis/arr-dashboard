import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export interface EncryptResult {
	value: string;
	iv: string;
}

export class Encryptor {
	private readonly key: Buffer;

	constructor(secret: string) {
		// Detect encoding: hex (64 chars), base64 (44 chars with padding), or utf-8
		let keyBuffer: Buffer;
		if (secret.length === 64 && /^[0-9a-f]+$/i.test(secret)) {
			// Hex encoded (32 bytes = 64 hex chars)
			keyBuffer = Buffer.from(secret, "hex");
		} else if (secret.length === 44 || secret.length === 43) {
			// Base64 encoded (32 bytes = 43-44 chars)
			keyBuffer = Buffer.from(secret, "base64");
		} else {
			// UTF-8 string
			keyBuffer = Buffer.from(secret, "utf-8");
		}

		if (keyBuffer.length !== 32) {
			throw new Error("ENCRYPTION_KEY must decode to 32 bytes");
		}
		this.key = keyBuffer;
	}

	encrypt(plaintext: string): EncryptResult {
		const iv = randomBytes(IV_LENGTH);
		const cipher = createCipheriv(ALGORITHM, this.key, iv, {
			authTagLength: AUTH_TAG_LENGTH,
		});
		const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
		const authTag = cipher.getAuthTag();
		const payload = Buffer.concat([encrypted, authTag]).toString("base64");

		return {
			value: payload,
			iv: iv.toString("base64"),
		};
	}

	decrypt(payload: EncryptResult): string {
		const iv = Buffer.from(payload.iv, "base64");
		const buffer = Buffer.from(payload.value, "base64");
		const cipherText = buffer.slice(0, buffer.length - AUTH_TAG_LENGTH);
		const authTag = buffer.slice(buffer.length - AUTH_TAG_LENGTH);

		const decipher = createDecipheriv(ALGORITHM, this.key, iv, {
			authTagLength: AUTH_TAG_LENGTH,
		});
		decipher.setAuthTag(authTag);

		const decrypted = Buffer.concat([decipher.update(cipherText), decipher.final()]);
		return decrypted.toString("utf8");
	}

	safeCompare(a: string, b: string): boolean {
		// Hash both inputs to fixed length to prevent length-based timing attacks
		const hashA = createHash("sha256").update(a).digest();
		const hashB = createHash("sha256").update(b).digest();
		return timingSafeEqual(hashA, hashB);
	}
}
