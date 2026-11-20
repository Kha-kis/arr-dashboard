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
	retentionBoundary?: NativeInventoryRetentionBoundary;
};

const RETENTION_OPERATIONS = [
	"candidate-enumeration",
	"transaction-start",
	"run-recheck",
	"protected-check",
	"writer-fence",
	"stage-select",
	"stage-delete",
	"seen-select",
	"seen-delete",
	"receipt-select",
	"receipt-delete",
	"pass-delete",
	"attempt-metadata",
	"run-delete",
	"remaining-pass-read",
	"transaction-finish",
	"pass-read",
] as const;
export type NativeInventoryRetentionOperation = (typeof RETENTION_OPERATIONS)[number];
export type NativeInventoryRetentionBoundary = {
	operation: NativeInventoryRetentionOperation;
	transactionEntered: boolean;
	nativeCode: "SQLITE_BUSY" | "SQLITE_BUSY_SNAPSHOT" | "SQLITE_LOCKED" | "unknown";
};
const retentionBoundaries = new WeakMap<object, NativeInventoryRetentionBoundary>();

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

/** Observational evidence only: never grants admission, retry or cleanup authority. */
export function rememberNativeInventoryRetentionBoundary(
	error: unknown,
	operation: NativeInventoryRetentionOperation,
	transactionEntered: boolean,
): void {
	if (typeof error !== "object" || error === null) return;
	const nativeCode = ownData(
		ownData(ownData(ownData(error, "meta"), "driverAdapterError"), "cause"),
		"originalCode",
	);
	retentionBoundaries.set(error, {
		operation,
		transactionEntered,
		nativeCode:
			nativeCode === "SQLITE_BUSY" ||
			nativeCode === "SQLITE_BUSY_SNAPSHOT" ||
			nativeCode === "SQLITE_LOCKED"
				? nativeCode
				: "unknown",
	});
}

/** Strict nested worker protocol; getters, inheritance and extra fields are refused. */
export function parseNativeInventoryRetentionBoundary(
	value: unknown,
): NativeInventoryRetentionBoundary | undefined {
	try {
		if (
			typeof value !== "object" ||
			value === null ||
			Object.getPrototypeOf(value) !== Object.prototype
		)
			return undefined;
		const keys = Reflect.ownKeys(value);
		if (
			keys.length !== 3 ||
			!keys.every(
				(key) => key === "operation" || key === "transactionEntered" || key === "nativeCode",
			)
		)
			return undefined;
		const rawOperation = ownData(value, "operation"),
			transactionEntered = ownData(value, "transactionEntered"),
			nativeCode = ownData(value, "nativeCode");
		const operation = RETENTION_OPERATIONS.find((name) => name === rawOperation);
		if (
			!operation ||
			typeof transactionEntered !== "boolean" ||
			!(
				nativeCode === "SQLITE_BUSY" ||
				nativeCode === "SQLITE_BUSY_SNAPSHOT" ||
				nativeCode === "SQLITE_LOCKED" ||
				nativeCode === "unknown"
			)
		)
			return undefined;
		return { operation, transactionEntered, nativeCode };
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
	const retentionBoundary =
		typeof value === "object" && value !== null
			? parseNativeInventoryRetentionBoundary(
					retentionBoundaries.get(value) ?? ownData(value, "retentionBoundary"),
				)
			: undefined;
	return {
		failurePhase: isNativeInventoryRetentionFailurePhase(phase) ? phase : "unknown",
		failureCode: isNativeInventoryRetentionFailureCode(code) ? code : "unknown",
		...(isTransportFailure(transport) ? { transportFailure: transport } : {}),
		...(retentionBoundary ? { retentionBoundary } : {}),
	};
}

export class NativeInventoryRetentionWorkerError extends Error {
	readonly failurePhase: NativeInventoryRetentionFailurePhase;
	readonly failureCode: NativeInventoryRetentionFailureCode;
	readonly transportFailure?: NativeInventoryRetentionTransportFailure;
	readonly retentionBoundary?: NativeInventoryRetentionBoundary;
	constructor(diagnostics?: NativeInventoryRetentionFailureDiagnostics) {
		super("Native inventory retention worker failed");
		this.name = "NativeInventoryRetentionWorkerError";
		const fields = nativeInventoryRetentionDiagnosticsFrom(diagnostics);
		this.failurePhase = fields.failurePhase;
		this.failureCode = fields.failureCode;
		if (fields.transportFailure) this.transportFailure = fields.transportFailure;
		if (fields.retentionBoundary) this.retentionBoundary = fields.retentionBoundary;
	}
}
