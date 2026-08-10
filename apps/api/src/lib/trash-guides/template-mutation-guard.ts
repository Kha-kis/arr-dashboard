/**
 * Serializes template changes and deployments per user.
 *
 * The API runtime lease guarantees one live API process per database, so an
 * in-process queue can keep the template snapshot used by a deployment stable
 * until every upstream write and its finalization have completed.
 */
const userQueues = new Map<string, Promise<void>>();

export async function withTrashTemplateMutationGuard<T>(
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

export async function withTrashTemplateDeploymentGuard<T>(
	deps: Parameters<typeof withCleanupTopologyMutationLease>[0],
	userId: string,
	operation: () => Promise<T>,
): Promise<T> {
	return withCleanupTopologyMutationLease(deps, userId, () =>
		withTrashTemplateMutationGuard(userId, operation),
	);
}

import { withCleanupTopologyMutationLease } from "../library-cleanup/cleanup-executor.js";
