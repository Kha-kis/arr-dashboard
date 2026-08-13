import type { Prisma, PrismaClient } from "../prisma.js";
import { PROVIDER_TRANSACTION_TIMEOUT_MS } from "../services/provider-connection-guard.js";
import { jellyfinConnectionFingerprint } from "./service-instance-fingerprint.js";

/** Keep Jellyfin/Emby cache and status writes tied to their originating connection. */
export async function withCurrentJellyfinConnection<T>(
	prisma: Pick<PrismaClient, "$transaction">,
	instanceId: string,
	expectedConnectionFingerprint: string | undefined,
	action: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<{ matched: true; value: T } | { matched: false }> {
	return await prisma.$transaction(
		async (tx) => {
			if (expectedConnectionFingerprint) {
				if (isPostgresqlDatabase()) {
					await tx.$queryRawUnsafe(
						'SELECT "id" FROM "ServiceInstance" WHERE "id" = $1 FOR UPDATE',
						instanceId,
					);
				}
				const current = await tx.serviceInstance.findUnique({
					where: { id: instanceId },
					select: {
						service: true,
						baseUrl: true,
						encryptedApiKey: true,
						encryptionIv: true,
						encryptedHttpAuthCredentials: true,
						httpAuthEncryptionIv: true,
						enabled: true,
						connectionGeneration: true,
					},
				});
				if (
					!current?.enabled ||
					(current.service !== "JELLYFIN" && current.service !== "EMBY") ||
					jellyfinConnectionFingerprint(current) !== expectedConnectionFingerprint
				) {
					return { matched: false };
				}
			}
			return { matched: true, value: await action(tx) };
		},
		isPostgresqlDatabase()
			? { timeout: PROVIDER_TRANSACTION_TIMEOUT_MS }
			: { isolationLevel: "Serializable", timeout: PROVIDER_TRANSACTION_TIMEOUT_MS },
	);
}

function isPostgresqlDatabase(): boolean {
	return /^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL ?? "");
}
