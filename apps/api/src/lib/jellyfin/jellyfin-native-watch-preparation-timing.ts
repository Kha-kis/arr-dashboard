import type { NativeWatchPreparationTransactionKind } from "./jellyfin-native-watch-repository.js";

const KINDS = ["row-chunk", "receipt-chunk", "lease-checkpoint"] as const;
const ZERO = {
	requested: 0,
	callbackEntered: 0,
	succeeded: 0,
	failed: 0,
	refusedStart: 0,
	callbackFailed: 0,
	admissionTotalMs: 0,
	admissionMaxMs: 0,
	callbackToSuccessTotalMs: 0,
	callbackToSuccessMaxMs: 0,
	refusedStartTotalMs: 0,
	refusedStartMaxMs: 0,
	callbackToFailureTotalMs: 0,
	callbackToFailureMaxMs: 0,
};
type TransactionTiming = typeof ZERO;
export type NativeWatchPreparationTiming = {
	version: 1;
	transactions: Record<NativeWatchPreparationTransactionKind, TransactionTiming>;
};
const FIELDS = Object.keys(ZERO) as Array<keyof TransactionTiming>;
function isKind(value: unknown): value is NativeWatchPreparationTransactionKind {
	return value === "row-chunk" || value === "receipt-chunk" || value === "lease-checkpoint";
}
function ownData(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null) return undefined;
	return Object.getOwnPropertyDescriptor(value, key)?.value;
}

/** Rebuild only fixed numeric diagnostics; an invalid metric never changes publication. */
export function sanitizeNativeWatchPreparationTiming(
	value: unknown,
): NativeWatchPreparationTiming | undefined {
	try {
		if (ownData(value, "version") !== 1) return undefined;
		const input = ownData(value, "transactions");
		const transactions = {} as NativeWatchPreparationTiming["transactions"];
		for (const kind of KINDS) {
			const metrics = ownData(input, kind);
			const tx = { ...ZERO };
			for (const field of FIELDS) {
				const number = ownData(metrics, field);
				if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0)
					return undefined;
				tx[field] = number;
			}
			if (
				tx.requested !== tx.succeeded + tx.failed ||
				tx.callbackEntered !== tx.succeeded + tx.callbackFailed ||
				tx.failed !== tx.refusedStart + tx.callbackFailed ||
				tx.admissionMaxMs > tx.admissionTotalMs ||
				tx.callbackToSuccessMaxMs > tx.callbackToSuccessTotalMs ||
				tx.refusedStartMaxMs > tx.refusedStartTotalMs ||
				tx.callbackToFailureMaxMs > tx.callbackToFailureTotalMs
			)
				return undefined;
			transactions[kind] = tx;
		}
		if (!KINDS.some((kind) => transactions[kind].requested > 0)) return undefined;
		return { version: 1, transactions };
	} catch {
		return undefined;
	}
}

/** Serial transaction wall intervals, not CPU or insertion-only costs. */
export function createNativeWatchPreparationTiming(clock: () => number = () => performance.now()): {
	observe(event: unknown): void;
	snapshot(): NativeWatchPreparationTiming | undefined;
} {
	const transactions: NativeWatchPreparationTiming["transactions"] = {
		"row-chunk": { ...ZERO },
		"receipt-chunk": { ...ZERO },
		"lease-checkpoint": { ...ZERO },
	};
	let valid = true;
	let lastTime = Number.NEGATIVE_INFINITY;
	let active:
		| { kind: NativeWatchPreparationTransactionKind; requestedAt: number; enteredAt?: number }
		| undefined;
	const add = (
		tx: TransactionTiming,
		total: keyof TransactionTiming,
		max: keyof TransactionTiming,
		duration: number,
	) => {
		tx[total] += duration;
		tx[max] = Math.max(tx[max], duration);
	};
	return {
		observe(event) {
			if (!valid) return;
			try {
				const kind = ownData(event, "kind"),
					phase = ownData(event, "phase"),
					now = clock();
				if (!isKind(kind) || !Number.isFinite(now) || now < lastTime) {
					valid = false;
					return;
				}
				lastTime = now;
				const tx = transactions[kind];
				if (phase === "requested") {
					if (active) {
						valid = false;
						return;
					}
					tx.requested++;
					active = { kind, requestedAt: now };
					return;
				}
				if (!active || active.kind !== kind) {
					valid = false;
					return;
				}
				if (phase === "callback-entered") {
					if (active.enteredAt !== undefined) {
						valid = false;
						return;
					}
					tx.callbackEntered++;
					active.enteredAt = now;
					add(tx, "admissionTotalMs", "admissionMaxMs", now - active.requestedAt);
					return;
				}
				if (phase === "succeeded") {
					if (active.enteredAt === undefined) {
						valid = false;
						return;
					}
					tx.succeeded++;
					add(tx, "callbackToSuccessTotalMs", "callbackToSuccessMaxMs", now - active.enteredAt);
				} else if (phase === "failed") {
					tx.failed++;
					if (active.enteredAt === undefined) {
						tx.refusedStart++;
						add(tx, "refusedStartTotalMs", "refusedStartMaxMs", now - active.requestedAt);
					} else {
						tx.callbackFailed++;
						add(tx, "callbackToFailureTotalMs", "callbackToFailureMaxMs", now - active.enteredAt);
					}
				} else {
					valid = false;
					return;
				}
				active = undefined;
			} catch {
				valid = false;
			}
		},
		snapshot() {
			try {
				if (!valid || active) return undefined;
				const rounded = {} as NativeWatchPreparationTiming["transactions"];
				for (const kind of KINDS) {
					const tx = { ...ZERO };
					for (const field of FIELDS) tx[field] = Math.round(transactions[kind][field]);
					rounded[kind] = tx;
				}
				return sanitizeNativeWatchPreparationTiming({ version: 1, transactions: rounded });
			} catch {
				return undefined;
			}
		},
	};
}
