import { createHash } from "node:crypto";
import type { ServiceInstance } from "../prisma.js";

type Connection = Pick<
	ServiceInstance,
	"service" | "baseUrl" | "encryptedApiKey" | "encryptionIv" | "connectionGeneration"
> &
	Partial<Pick<ServiceInstance, "encryptedHttpAuthCredentials" | "httpAuthEncryptionIv">>;

export function jellyfinConnectionFingerprint(instance: Connection): string {
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
