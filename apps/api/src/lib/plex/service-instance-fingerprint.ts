import { createHash } from "node:crypto";
import type { ServiceInstance } from "../prisma.js";

type PlexConnectionIdentity = Pick<
	ServiceInstance,
	"baseUrl" | "encryptedApiKey" | "encryptionIv"
> &
	Partial<
		Pick<ServiceInstance, "encryptedHttpAuthCredentials" | "httpAuthEncryptionIv">
	>;

/**
 * Bind cached Plex evidence to the exact connection snapshot that produced it.
 *
 * The digest is deliberately one-way because the input contains encrypted
 * credentials. Any URL, token, IV, or proxy-auth change invalidates prior
 * evidence, including a repoint that happens while a refresh is in flight.
 */
export function plexConnectionFingerprint(instance: PlexConnectionIdentity): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				instance.baseUrl,
				instance.encryptedApiKey,
				instance.encryptionIv,
				instance.encryptedHttpAuthCredentials,
				instance.httpAuthEncryptionIv,
			]),
		)
		.digest("hex");
}
