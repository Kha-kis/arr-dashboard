import type { Prisma, PrismaClient } from "../prisma.js";
import { jellyfinConnectionFingerprint } from "./service-instance-fingerprint.js";

type GuardPrisma = Pick<PrismaClient, "$transaction">;

type GuardResult<T> = { matched: true; value: T } | { matched: false };

/**
 * Run a cache/status write only while the originating Jellyfin/Emby
 * connection is still current.
 *
 * PostgreSQL locks the service row before reading it and keeps that lock
 * through the write. SQLite uses a serializable transaction. This makes the
 * identity check and the dependent write one indivisible operation.
 */
export async function withCurrentJellyfinConnection<T>(
	prisma: GuardPrisma,
	instanceId: string,
	expectedConnectionFingerprint: string | undefined,
	action: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<GuardResult<T>> {
	return await prisma.$transaction(
		async (tx) => {
			if (expectedConnectionFingerprint) {
				if (isPostgresqlDatabase()) {
					await tx.$queryRawUnsafe(
						'SELECT "id" FROM "ServiceInstance" WHERE "id" = $1 FOR UPDATE',
						instanceId,
					);
				}
				const currentInstance = await tx.serviceInstance.findUnique({
					where: { id: instanceId },
					select: {
						service: true,
						baseUrl: true,
						encryptedApiKey: true,
						encryptionIv: true,
						encryptedHttpAuthCredentials: true,
						httpAuthEncryptionIv: true,
						enabled: true,
						updatedAt: true,
					},
				});
				if (
					!currentInstance?.enabled ||
					(currentInstance.service !== "JELLYFIN" && currentInstance.service !== "EMBY") ||
					jellyfinConnectionFingerprint(currentInstance) !== expectedConnectionFingerprint
				) {
					return { matched: false };
				}
			}

			return { matched: true, value: await action(tx) };
		},
		isPostgresqlDatabase() ? undefined : { isolationLevel: "Serializable" },
	);
}

function isPostgresqlDatabase(): boolean {
	return /^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL ?? "");
}
