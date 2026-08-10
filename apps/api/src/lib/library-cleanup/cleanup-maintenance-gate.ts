/**
 * In-process reader/writer gate around cleanup-sensitive mutations.
 *
 * The API runtime lease guarantees one live API process per database. That
 * lets this gate live outside the application tables that backup restore
 * replaces: cleanup runs and topology writes are shared readers, while a
 * database restore is the exclusive writer.
 */

let activeCleanupOperations = 0;
let maintenanceActive = false;
let exclusiveCleanupOperationActive = false;

export class CleanupMaintenanceConflictError extends Error {
	readonly statusCode = 409;

	constructor(message = "Database maintenance cannot overlap a library cleanup operation") {
		super(message);
		this.name = "CleanupMaintenanceConflictError";
	}
}

/** Acquire a shared operation guard that remains active until the returned release is called. */
export function acquireCleanupOperationGuard(): () => void {
	if (maintenanceActive || exclusiveCleanupOperationActive) {
		throw new CleanupMaintenanceConflictError(
			"Cleanup-sensitive changes are unavailable during database maintenance or ARR service deletion",
		);
	}
	activeCleanupOperations += 1;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		activeCleanupOperations -= 1;
	};
}

/**
 * Run a destructive topology mutation only when every cleanup-sensitive
 * operation has settled, and prevent new operations from starting meanwhile.
 */
export async function withExclusiveCleanupOperationGuard<T>(
	operation: () => Promise<T>,
): Promise<T> {
	if (maintenanceActive || exclusiveCleanupOperationActive || activeCleanupOperations > 0) {
		throw new CleanupMaintenanceConflictError(
			"This service cannot be deleted while database maintenance, TRaSH, or library cleanup work is active",
		);
	}
	exclusiveCleanupOperationActive = true;
	try {
		return await operation();
	} finally {
		exclusiveCleanupOperationActive = false;
	}
}

export async function withCleanupOperationGuard<T>(operation: () => Promise<T>): Promise<T> {
	const release = acquireCleanupOperationGuard();
	try {
		return await operation();
	} finally {
		release();
	}
}

export async function withCleanupMaintenanceGuard<T>(
	maintenance: () => Promise<T>,
	options: { holdAfterSuccess?: boolean } = {},
): Promise<T> {
	if (maintenanceActive || exclusiveCleanupOperationActive || activeCleanupOperations > 0) {
		throw new CleanupMaintenanceConflictError();
	}
	maintenanceActive = true;
	let completed = false;
	try {
		const result = await maintenance();
		completed = true;
		return result;
	} finally {
		if (!completed || !options.holdAfterSuccess) {
			maintenanceActive = false;
		}
	}
}
