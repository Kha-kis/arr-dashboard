import { createHash } from "node:crypto";
import type { ServiceInstance } from "../prisma.js";

type JellyfinConnectionIdentity = Pick<
	ServiceInstance,
	"service" | "baseUrl" | "encryptedApiKey" | "encryptionIv" | "connectionGeneration"
> &
	Partial<Pick<ServiceInstance, "encryptedHttpAuthCredentials" | "httpAuthEncryptionIv">>;

/** Bind a cache refresh to the exact Jellyfin/Emby connection that produced it. */
export function jellyfinConnectionFingerprint(instance: JellyfinConnectionIdentity): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				instance.service,
				instance.baseUrl,
				instance.encryptedApiKey,
				instance.encryptionIv,
				instance.encryptedHttpAuthCredentials,
				instance.httpAuthEncryptionIv,
				instance.connectionGeneration,
			]),
		)
		.digest("hex");
}
