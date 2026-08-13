import type { Prisma, PrismaClient, ServiceInstance, ServiceType } from "../prisma.js";
import { plexConnectionFingerprint } from "../plex/service-instance-fingerprint.js";

type ProviderConnectionSource = Pick<
	ServiceInstance,
	| "service"
	| "baseUrl"
	| "encryptedApiKey"
	| "encryptionIv"
	| "encryptedHttpAuthCredentials"
	| "httpAuthEncryptionIv"
	| "connectionGeneration"
>;

export type ProviderConnectionIdentity = {
	service: ServiceType;
	connectionGeneration: number;
	connectionFingerprint: string;
};

export const PROVIDER_TRANSACTION_TIMEOUT_MS = 120_000;

export function providerConnectionIdentity(
	instance: ProviderConnectionSource,
): ProviderConnectionIdentity {
	return {
		service: instance.service,
		connectionGeneration: instance.connectionGeneration,
		connectionFingerprint: plexConnectionFingerprint(instance),
	};
}

export async function withCurrentProviderConnection<T>(
	prisma: Pick<PrismaClient, "$transaction">,
	instanceId: string,
	expected: ProviderConnectionIdentity | undefined,
	action: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<{ matched: true; value: T } | { matched: false }> {
	return await prisma.$transaction(
		async (tx) => {
			if (expected) {
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
					current.service !== expected.service ||
					current.connectionGeneration !== expected.connectionGeneration ||
					plexConnectionFingerprint(current) !== expected.connectionFingerprint
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
