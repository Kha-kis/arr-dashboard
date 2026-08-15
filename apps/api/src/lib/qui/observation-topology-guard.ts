/**
 * Serializes qUI observation writers and qUI topology mutations per user.
 *
 * The API runtime lease guarantees one live API process per database, so an
 * in-process queue is sufficient here. Without this guard, a sync that fetched
 * an old qUI endpoint could write those observations after a disable, delete,
 * or repoint transaction had already cleared them.
 */
const userQueues = new Map<string, Promise<void>>();

export async function withQuiObservationTopologyGuard<T>(
	userId: string,
	operation: () => Promise<T>,
): Promise<T> {
	const previous = userQueues.get(userId) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	userQueues.set(userId, current);

	await previous;
	try {
		return await operation();
	} finally {
		release();
		if (userQueues.get(userId) === current) {
			userQueues.delete(userId);
		}
	}
}
