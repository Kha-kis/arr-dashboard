import { createHash } from "node:crypto";
import type { ServiceInstance } from "../prisma.js";

function requiredNonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
		throw new Error(`${label} is unavailable`);
	}
	return value.trim();
}

function canonicalServiceBaseUrl(value: unknown): string {
	const raw = requiredNonEmptyString(value, "ARR service URL");
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("ARR service URL is invalid");
	}
	if (
		(url.protocol !== "http:" && url.protocol !== "https:") ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new Error("ARR service URL is invalid");
	}
	url.pathname = url.pathname.replace(/\/+$/, "") || "/";
	return url.toString();
}

export function createArrServiceFingerprint(
	instance: Pick<
		ServiceInstance,
		| "id"
		| "service"
		| "baseUrl"
		| "encryptedApiKey"
		| "encryptionIv"
		| "encryptedHttpAuthCredentials"
		| "httpAuthEncryptionIv"
	>,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				instance.id,
				instance.service,
				canonicalServiceBaseUrl(instance.baseUrl),
				instance.encryptedApiKey,
				instance.encryptionIv,
				instance.encryptedHttpAuthCredentials,
				instance.httpAuthEncryptionIv,
			]),
		)
		.digest("hex");
}
