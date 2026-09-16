import type { PrismaClient, ServiceInstance } from "../prisma.js";

/** Reauthorize the connection used by the client immediately before an upstream action. */
export async function isCurrentAutoTagTarget(
	prisma: PrismaClient,
	userId: string,
	instance: ServiceInstance,
): Promise<boolean> {
	return Boolean(
		await prisma.serviceInstance.findFirst({
			where: {
				id: instance.id,
				userId,
				enabled: true,
				service: instance.service,
				connectionGeneration: instance.connectionGeneration,
				identityGeneration: instance.identityGeneration,
				baseUrl: instance.baseUrl,
				encryptedApiKey: instance.encryptedApiKey,
				encryptionIv: instance.encryptionIv,
				encryptedHttpAuthCredentials: instance.encryptedHttpAuthCredentials,
				httpAuthEncryptionIv: instance.httpAuthEncryptionIv,
			},
			select: { id: true },
		}),
	);
}

export class AutoTagAuthorityChangedError extends Error {
	constructor() {
		super("Auto-tag evidence or connection changed before the write");
		this.name = "AutoTagAuthorityChangedError";
	}
}
