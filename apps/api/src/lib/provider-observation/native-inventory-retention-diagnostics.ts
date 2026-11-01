export type NativeInventoryRetentionFailurePhase =
	| "runtime-open"
	| "client-create"
	| "retention"
	| "runtime-close"
	| "unknown";
export type NativeInventoryRetentionFailureCode =
	| "P1008"
	| "P2024"
	| "P2028"
	| "P2034"
	| "SQLITE_BUSY"
	| "SQLITE_BUSY_SNAPSHOT"
	| "SQLITE_LOCKED"
	| "unknown";
export type NativeInventoryRetentionTransportFailure =
	| "invalid-request"
	| "attach-failed"
	| "worker-construction-failed"
	| "worker-error"
	| "worker-messageerror"
	| "invalid-worker-result"
	| "worker-exited-without-result"
	| "worker-nonzero-exit"
	| "runtime-bridge-unavailable"
	| "bridge-close-failed";
export type NativeInventoryRetentionFailureDiagnostics = {
	failurePhase: NativeInventoryRetentionFailurePhase;
	failureCode: NativeInventoryRetentionFailureCode;
	transportFailure?: NativeInventoryRetentionTransportFailure;
};

/** Never read an accessor, inherited property, error message or cause. */
function ownData(value: unknown, key: string): unknown {
	try {
		if (typeof value !== "object" || value === null) return undefined;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}
export function isNativeInventoryRetentionFailurePhase(
	value: unknown,
): value is NativeInventoryRetentionFailurePhase {
	return (
		value === "runtime-open" ||
		value === "client-create" ||
		value === "retention" ||
		value === "runtime-close" ||
		value === "unknown"
	);
}
export function isNativeInventoryRetentionFailureCode(
	value: unknown,
): value is NativeInventoryRetentionFailureCode {
	return (
		value === "P1008" ||
		value === "P2024" ||
		value === "P2028" ||
		value === "P2034" ||
		value === "SQLITE_BUSY" ||
		value === "SQLITE_BUSY_SNAPSHOT" ||
		value === "SQLITE_LOCKED" ||
		value === "unknown"
	);
}
function isTransportFailure(value: unknown): value is NativeInventoryRetentionTransportFailure {
	return (
		value === "invalid-request" ||
		value === "attach-failed" ||
		value === "worker-construction-failed" ||
		value === "worker-error" ||
		value === "worker-messageerror" ||
		value === "invalid-worker-result" ||
		value === "worker-exited-without-result" ||
		value === "worker-nonzero-exit" ||
		value === "runtime-bridge-unavailable" ||
		value === "bridge-close-failed"
	);
}
export function nativeInventoryRetentionFailureCode(
	error: unknown,
): NativeInventoryRetentionFailureCode {
	const code = ownData(error, "code");
	return isNativeInventoryRetentionFailureCode(code) ? code : "unknown";
}

/** Closed projection only; diagnostics never authorize retention or classify contention. */
export function nativeInventoryRetentionDiagnosticsFrom(
	value: unknown,
): NativeInventoryRetentionFailureDiagnostics {
	const phase = ownData(value, "failurePhase");
	const code = ownData(value, "failureCode");
	const transport = ownData(value, "transportFailure");
	return {
		failurePhase: isNativeInventoryRetentionFailurePhase(phase) ? phase : "unknown",
		failureCode: isNativeInventoryRetentionFailureCode(code) ? code : "unknown",
		...(isTransportFailure(transport) ? { transportFailure: transport } : {}),
	};
}

export class NativeInventoryRetentionWorkerError extends Error {
	readonly failurePhase: NativeInventoryRetentionFailurePhase;
	readonly failureCode: NativeInventoryRetentionFailureCode;
	readonly transportFailure?: NativeInventoryRetentionTransportFailure;
	constructor(diagnostics?: NativeInventoryRetentionFailureDiagnostics) {
		super("Native inventory retention worker failed");
		this.name = "NativeInventoryRetentionWorkerError";
		const fields = nativeInventoryRetentionDiagnosticsFrom(diagnostics);
		this.failurePhase = fields.failurePhase;
		this.failureCode = fields.failureCode;
		if (fields.transportFailure) this.transportFailure = fields.transportFailure;
	}
}
