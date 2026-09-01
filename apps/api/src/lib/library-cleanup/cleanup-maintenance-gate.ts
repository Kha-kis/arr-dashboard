import { AsyncLocalStorage } from "node:async_hooks";

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
type OperationGuardContext = { active: boolean };
const operationGuardContext = new AsyncLocalStorage<OperationGuardContext>();

export class CleanupMaintenanceConflictError extends Error {
	readonly statusCode = 409;

	constructor(message = "Database maintenance cannot overlap a library cleanup operation") {
		super(message);
		this.name = "CleanupMaintenanceConflictError";
	}
}

/** Acquire a shared operation guard that remains active until the returned release is called. */
function acquireCleanupOperationGuardState(): {
	context: OperationGuardContext;
	release: () => void;
} {
	if (maintenanceActive || exclusiveCleanupOperationActive) {
		throw new CleanupMaintenanceConflictError(
			"Cleanup-sensitive changes are unavailable during database maintenance or ARR service deletion",
		);
	}
	activeCleanupOperations += 1;
	let released = false;
	const context = { active: true };
	const release = () => {
		if (released) return;
		released = true;
		context.active = false;
		activeCleanupOperations -= 1;
	};
	return { context, release };
}

export function acquireCleanupOperationGuard(): () => void {
	return acquireCleanupOperationGuardState().release;
}

/**
 * Run a destructive topology mutation only when every cleanup-sensitive
 * operation has settled, and prevent new operations from starting meanwhile.
 */
export async function withExclusiveCleanupOperationGuard<T>(
	operation: () => Promise<T>,
): Promise<T> {
	const ownedSharedLease = operationGuardContext.getStore()?.active === true ? 1 : 0;
	if (
		maintenanceActive ||
		exclusiveCleanupOperationActive ||
		activeCleanupOperations > ownedSharedLease
	) {
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
	if (operationGuardContext.getStore()?.active === true) {
		return await operation();
	}
	const { context, release } = acquireCleanupOperationGuardState();
	try {
		return await operationGuardContext.run(context, operation);
	} finally {
		release();
	}
}

export async function withCleanupMaintenanceGuard<T>(
	maintenance: () => Promise<T>,
	options: { holdAfterSuccess?: boolean } = {},
): Promise<T> {
	const ownedSharedLease = operationGuardContext.getStore()?.active === true ? 1 : 0;
	if (
		maintenanceActive ||
		exclusiveCleanupOperationActive ||
		activeCleanupOperations > ownedSharedLease
	) {
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
