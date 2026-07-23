import type { Encryptor } from "../auth/encryption.js";

export interface HttpAuthCredentials {
	username: string;
	password: string;
}

export interface StoredHttpAuthCredentials {
	encryptedHttpAuthCredentials?: string | null;
	httpAuthEncryptionIv?: string | null;
}

interface StoredPayload extends HttpAuthCredentials {
	v: 1;
}

export function encryptHttpAuthCredentials(
	encryptor: Pick<Encryptor, "encrypt">,
	credentials: HttpAuthCredentials,
): { encryptedHttpAuthCredentials: string; httpAuthEncryptionIv: string } {
	const encrypted = encryptor.encrypt(
		JSON.stringify({ v: 1, ...credentials } satisfies StoredPayload),
	);
	return {
		encryptedHttpAuthCredentials: encrypted.value,
		httpAuthEncryptionIv: encrypted.iv,
	};
}

export function decryptHttpAuthCredentials(
	encryptor: Pick<Encryptor, "decrypt">,
	stored: StoredHttpAuthCredentials,
): HttpAuthCredentials | null {
	if (!stored.encryptedHttpAuthCredentials || !stored.httpAuthEncryptionIv) return null;

	const plaintext = encryptor.decrypt({
		value: stored.encryptedHttpAuthCredentials,
		iv: stored.httpAuthEncryptionIv,
	});
	const parsed: unknown = JSON.parse(plaintext);
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		(parsed as Partial<StoredPayload>).v !== 1 ||
		typeof (parsed as Partial<StoredPayload>).username !== "string" ||
		typeof (parsed as Partial<StoredPayload>).password !== "string"
	) {
		throw new Error("Stored HTTP authentication credentials are invalid");
	}

	return {
		username: (parsed as StoredPayload).username,
		password: (parsed as StoredPayload).password,
	};
}

export function createHttpAuthHeaders(
	credentials: HttpAuthCredentials | null,
): Record<string, string> {
	if (!credentials) return {};
	const encoded = Buffer.from(`${credentials.username}:${credentials.password}`, "utf8").toString(
		"base64",
	);
	return { Authorization: `Basic ${encoded}` };
}

export function getStoredHttpAuthHeaders(
	encryptor: Pick<Encryptor, "decrypt">,
	stored: StoredHttpAuthCredentials,
): Record<string, string> {
	return createHttpAuthHeaders(decryptHttpAuthCredentials(encryptor, stored));
}

export function stripUrlCredentials(rawUrl: string): {
	baseUrl: string;
	credentials: HttpAuthCredentials | null;
} {
	const url = new URL(rawUrl);
	if (!url.username && !url.password) return { baseUrl: rawUrl, credentials: null };

	const credentials = {
		username: safeDecodeURIComponent(url.username),
		password: safeDecodeURIComponent(url.password),
	};
	url.username = "";
	url.password = "";
	return { baseUrl: url.toString().replace(/\/$/, ""), credentials };
}

function safeDecodeURIComponent(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
