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

export class CleanupMaintenanceConflictError extends Error {
	readonly statusCode = 409;

	constructor(message = "Database maintenance cannot overlap a library cleanup operation") {
		super(message);
		this.name = "CleanupMaintenanceConflictError";
	}
}

export async function withCleanupOperationGuard<T>(operation: () => Promise<T>): Promise<T> {
	if (maintenanceActive) {
		throw new CleanupMaintenanceConflictError(
			"Library cleanup and service changes are unavailable while database maintenance is running",
		);
	}
	activeCleanupOperations += 1;
	try {
		return await operation();
	} finally {
		activeCleanupOperations -= 1;
	}
}

export async function withCleanupMaintenanceGuard<T>(
	maintenance: () => Promise<T>,
	options: { holdAfterSuccess?: boolean } = {},
): Promise<T> {
	if (maintenanceActive || activeCleanupOperations > 0) {
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
