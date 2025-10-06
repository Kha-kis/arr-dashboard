import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

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
    const keyBuffer = Buffer.from(
      secret,
      secret.length === 64 ? "base64" : "utf-8",
    );
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
    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
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

    const decrypted = Buffer.concat([
      decipher.update(cipherText),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  }

  safeCompare(a: string, b: string): boolean {
    const bufferA = Buffer.from(a);
    const bufferB = Buffer.from(b);
    if (bufferA.length !== bufferB.length) {
      return false;
    }
    return timingSafeEqual(bufferA, bufferB);
  }
}
