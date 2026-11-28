import type { PrismaClient } from "../prisma.js";

export type QuiTopologyGeneration = Array<{ id: string; connectionGeneration: number }>;

export function captureQuiTopologyGeneration(
	instances: QuiTopologyGeneration,
): QuiTopologyGeneration {
	return instances
		.map(({ id, connectionGeneration }) => ({ id, connectionGeneration }))
		.sort((a, b) => a.id.localeCompare(b.id));
}

/** Call only inside withQuiObservationTopologyGuard, immediately before a hash write. */
export async function assertQuiTopologyGenerationCurrent(
	prisma: PrismaClient,
	userId: string,
	expected: QuiTopologyGeneration,
): Promise<void> {
	const current = captureQuiTopologyGeneration(
		await prisma.serviceInstance.findMany({
			where: { service: "QUI", userId, enabled: true },
			select: { id: true, connectionGeneration: true },
		}),
	);
	if (
		current.length !== expected.length ||
		current.some(
			(instance, index) =>
				instance.id !== expected[index]?.id ||
				instance.connectionGeneration !== expected[index]?.connectionGeneration,
		)
	) {
		throw new Error("qUI topology changed before hash publication");
	}
}
