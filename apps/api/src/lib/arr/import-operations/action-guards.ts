import { withIndependentCleanupOperationGuard } from "../../library-cleanup/cleanup-maintenance-gate.js";
import {
	acquireBorrowedQueueSourceAction,
	acquireQueueSourceAction,
	type QueueSourceActionPermit,
	queueDownloadKey,
} from "../../queue-cleaner/import-receipt.js";

export class ImportSourceConflictError extends Error {
	readonly statusCode = 409;
	constructor() {
		super(
			"An import source is unavailable or already protected by another action. No import was submitted.",
		);
		this.name = "ImportSourceConflictError";
	}
}

/**
 * Share source ownership with the cleaner, across same-owner connection aliases.
 * This is an actual-settlement guard, not a request/scheduler timeout lease.
 * Durable database claims remain a separate restart fence.
 */
export async function withImportActionGuards<T>(
	userId: string,
	downloadIds: string[],
	operation: () => Promise<T>,
	sourcePermit?: QueueSourceActionPermit,
): Promise<T> {
	if (!userId || !downloadIds.length || downloadIds.length > 1000)
		throw new ImportSourceConflictError();
	const sources = new Map<string, string>();
	for (const downloadId of downloadIds) {
		if (typeof downloadId !== "string" || !downloadId || downloadId !== downloadId.trim())
			throw new ImportSourceConflictError();
		const key = queueDownloadKey({ downloadId });
		if (!key) throw new ImportSourceConflictError();
		sources.set(key, downloadId);
	}
	return withIndependentCleanupOperationGuard(async () => {
		const releases: Array<() => void> = [];
		try {
			if (sourcePermit !== undefined && sources.size !== 1) throw new ImportSourceConflictError();
			for (const [, downloadId] of [...sources].sort(([a], [b]) => a.localeCompare(b))) {
				const release =
					sourcePermit === undefined
						? acquireQueueSourceAction(userId, { downloadId })
						: acquireBorrowedQueueSourceAction(userId, { downloadId }, sourcePermit);
				if (!release) throw new ImportSourceConflictError();
				releases.push(release);
			}
			return await operation();
		} finally {
			for (const release of releases.reverse()) release();
		}
	});
}
