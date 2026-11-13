import { AsyncLocalStorage } from "node:async_hooks";
import {
	retainRestoreRuntimeOperation,
	withRestoreRuntimeOperation,
} from "../backup/restore-runtime-admission.js";

/**
 * In-process reader/writer gate around cleanup-sensitive mutations.
 *
 * Stable 2.x supports one API process per database; runtime enforcement is
 * tracked separately in #829. This gate does not establish database ownership
 * across processes. Within the supported topology it lives outside the tables
 * that backup restore replaces: cleanup runs and topology writes are shared
 * readers, while a database restore is the exclusive writer.
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
function acquireCleanupOperationGuardState(options: { allowNestedExclusive?: boolean } = {}): {
	context: OperationGuardContext;
	release: () => void;
} {
	const nestedExclusiveOwner =
		options.allowNestedExclusive === true && operationGuardContext.getStore()?.active === true;
	if (maintenanceActive || (exclusiveCleanupOperationActive && !nestedExclusiveOwner)) {
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
 * Acquire a shared lease that is independent from the caller's async context.
 *
 * Background work must keep this lease after its request or scheduler callback
 * has returned. The returned release is idempotent and intentionally has no
 * promise or cancellation semantics: the owner releases it when the work has
 * actually settled.
 */
export function acquireIndependentCleanupOperationGuard(): () => void {
	return acquireCleanupOperationGuardState({ allowNestedExclusive: true }).release;
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
	return withRestoreRuntimeOperation(() => runCleanupOperationGuard(operation));
}

async function runCleanupOperationGuard<T>(operation: () => Promise<T>): Promise<T> {
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

/**
 * Give a detached producer its own shared lease, even when it was launched
 * from a request or scheduler callback that already owns one. The independent
 * context prevents the parent from releasing the producer's lease when the
 * parent returns before the producer settles.
 */
export async function withIndependentCleanupOperationGuard<T>(
	operation: () => Promise<T>,
): Promise<T> {
	return withRestoreRuntimeOperation(() => runIndependentCleanupOperationGuard(operation), {
		independent: true,
		source: "cleanup-independent",
	});
}

async function runIndependentCleanupOperationGuard<T>(operation: () => Promise<T>): Promise<T> {
	const { context, release } = acquireCleanupOperationGuardState({ allowNestedExclusive: true });
	try {
		return await operationGuardContext.run(context, operation);
	} finally {
		release();
	}
}

/** Retain accepted queued work; acquire cleanup exclusion only when it actually runs. */
export function retainCleanupOperation(): {
	run<T>(operation: () => Promise<T>): Promise<T>;
	release(): Promise<void>;
} {
	const retained = retainRestoreRuntimeOperation();
	return Object.freeze({
		run: <T>(operation: () => Promise<T>) =>
			retained
				? retained.run(() => runIndependentCleanupOperationGuard(operation))
				: runIndependentCleanupOperationGuard(operation),
		release: () => retained?.release() ?? Promise.resolve(),
	});
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
