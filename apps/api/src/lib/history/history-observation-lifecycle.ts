type HistoryDeleteDelegate = {
	deleteMany(args: {
		where: { instanceId: string; instance: { userId: string } };
	}): Promise<unknown>;
};

type HistoryObservationLifecyclePrisma = {
	historyObservation: HistoryDeleteDelegate;
	historySourceStatus: HistoryDeleteDelegate;
};

/**
 * Remove only the durable History state owned by one service instance.
 *
 * Both predicates retain the instance relation ownership fence. This helper
 * is intended to run inside the caller's transaction so a failed second
 * delete rolls back the first delete and the connection update together.
 */
export async function clearDurableHistoryObservationState(
	prisma: HistoryObservationLifecyclePrisma,
	instanceId: string,
	userId: string,
): Promise<void> {
	await prisma.historyObservation.deleteMany({
		where: { instanceId, instance: { userId } },
	});
	await prisma.historySourceStatus.deleteMany({
		where: { instanceId, instance: { userId } },
	});
}
