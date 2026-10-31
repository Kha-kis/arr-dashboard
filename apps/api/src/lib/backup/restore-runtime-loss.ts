/** Closed diagnostic categories only; never include an error, message or identity. */
export type RestoreRuntimeLossReason =
	| "runtime-unavailable"
	| "runtime-record-check-failed"
	| "native-owner-unavailable"
	| "native-participation-unavailable"
	| "storage-binding-invalid"
	| "client-invalid-journal"
	| "client-close-failed"
	| "transaction-cleanup-failed"
	| "worker-proof-timeout"
	| "worker-channel-unavailable"
	| "worker-proof-invalid"
	| "worker-proof-failed";

export type RestoreRuntimeLossDiagnostic = Readonly<{
	reason: RestoreRuntimeLossReason;
	runtimeAgeMs: number;
}>;

export function sanitizeRestoreRuntimeLossReason(value: unknown): RestoreRuntimeLossReason {
	switch (value) {
		case "runtime-record-check-failed":
		case "native-owner-unavailable":
		case "native-participation-unavailable":
		case "storage-binding-invalid":
		case "client-invalid-journal":
		case "client-close-failed":
		case "transaction-cleanup-failed":
		case "worker-proof-timeout":
		case "worker-channel-unavailable":
		case "worker-proof-invalid":
		case "worker-proof-failed":
			return value;
		default:
			return "runtime-unavailable";
	}
}

// Zero is admission; one remains the existing generic revocation sentinel.
// All diagnostic values are nonzero and therefore confer no authority.
const WORKER_LOSS_REASONS: readonly RestoreRuntimeLossReason[] = [
	"runtime-unavailable",
	"runtime-record-check-failed",
	"native-owner-unavailable",
	"native-participation-unavailable",
	"storage-binding-invalid",
	"client-invalid-journal",
	"client-close-failed",
	"transaction-cleanup-failed",
	"worker-proof-timeout",
	"worker-channel-unavailable",
	"worker-proof-invalid",
	"worker-proof-failed",
];

/** Fence first, retaining only the first closed cause even before IPC is dispatched. */
export function recordRestoreRuntimeWorkerLoss(
	words: Int32Array,
	reason: RestoreRuntimeLossReason,
): void {
	const code = WORKER_LOSS_REASONS.indexOf(sanitizeRestoreRuntimeLossReason(reason)) + 2;
	Atomics.compareExchange(words, 0, 0, code);
}

/** Unknown/revoked values stay fenced and provide no invented diagnostic cause. */
export function readRestoreRuntimeWorkerLoss(
	words: Int32Array,
): RestoreRuntimeLossReason | undefined {
	const code = Atomics.load(words, 0);
	return code >= 2 && code < WORKER_LOSS_REASONS.length + 2
		? WORKER_LOSS_REASONS[code - 2]
		: undefined;
}

/** Best-effort closed projection; a failed diagnostic sink must not skip shutdown. */
export function logRestoreRuntimeLoss(
	log: { error(fields: Record<string, unknown>, message: string): unknown },
	diagnostic: RestoreRuntimeLossDiagnostic,
): void {
	try {
		const age = diagnostic.runtimeAgeMs;
		log.error(
			{
				category: "restore-runtime-authority-lost",
				reason: sanitizeRestoreRuntimeLossReason(diagnostic.reason),
				...(typeof age === "number" && Number.isSafeInteger(age) && age >= 0
					? { runtimeAgeMs: age }
					: {}),
			},
			"Runtime admission stopped",
		);
	} catch {
		// The runtime has already fenced work. Diagnostics cannot change closure.
	}
}
