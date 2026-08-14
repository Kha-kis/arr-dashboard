import type { Prisma, PrismaClient, ServiceType } from "../prisma.js";

export type ProviderConnectionIdentity = {
	service: ServiceType;
	connectionGeneration: number;
};

export function providerConnectionIdentity(
	instance: ProviderConnectionIdentity,
): ProviderConnectionIdentity {
	return {
		service: instance.service,
		connectionGeneration: instance.connectionGeneration,
	};
}

type GuardPrisma = Pick<PrismaClient, "$transaction">;
type GuardResult<T> = { matched: true; value: T } | { matched: false };

export type ProviderConnectionTransactionOptions = {
	maxWait?: number;
	timeout?: number;
};

/** Keep provider cache/status writes bound to the service generation that produced them. */
export async function withCurrentProviderConnection<T>(
	prisma: GuardPrisma,
	instanceId: string,
	expected: ProviderConnectionIdentity | undefined,
	action: (tx: Prisma.TransactionClient) => Promise<T>,
	options?: ProviderConnectionTransactionOptions,
): Promise<GuardResult<T>> {
	const postgresql = isPostgresqlDatabase();
	return await prisma.$transaction(
		async (tx) => {
			if (expected) {
				if (postgresql) {
					await tx.$queryRawUnsafe(
						'SELECT "id" FROM "ServiceInstance" WHERE "id" = $1 FOR UPDATE',
						instanceId,
					);
				}
				const current = await tx.serviceInstance.findUnique({
					where: { id: instanceId },
					select: { service: true, enabled: true, connectionGeneration: true },
				});
				if (
					!current?.enabled ||
					current.service !== expected.service ||
					current.connectionGeneration !== expected.connectionGeneration
				) {
					return { matched: false };
				}
			}

			return { matched: true, value: await action(tx) };
		},
		postgresql ? options : { isolationLevel: "Serializable", ...options },
	);
}

function isPostgresqlDatabase(): boolean {
	return /^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL ?? "");
}
