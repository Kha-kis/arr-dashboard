import type { Prisma } from "../prisma.js";

type QueueCleanerOperation = "strike-state" | "run-result-commit";
type SafePrismaCode = "P1008" | "P2024" | "P2028" | "P2034";
type SafeNativeCode = "SQLITE_BUSY" | "SQLITE_BUSY_SNAPSHOT" | "SQLITE_LOCKED" | "unknown";
type Diagnostic = {
	job: "queue-cleaner";
	operation: QueueCleanerOperation;
	boundary: "transaction-admission" | "transaction-callback";
	transactionEntered: boolean;
	prismaCode: SafePrismaCode | "unknown";
	nativeCode: SafeNativeCode;
	elapsedMs: number;
	retryObserved: false;
	outcome: "failed";
};
const observed = new WeakMap<object, Diagnostic>();
const prismaCodes = ["P1008", "P2024", "P2028", "P2034"] as const;

function own(value: unknown, key: string): unknown {
	try {
		if (typeof value !== "object" || value === null) return undefined;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}

/** Records only the two fixed Queue Cleaner transaction boundaries. */
export function rememberQueueCleanerTransactionBoundary(
	error: unknown,
	operation: QueueCleanerOperation,
	transactionEntered: boolean,
	elapsedMs: number,
): void {
	if (typeof error !== "object" || error === null) return;
	const code = own(error, "code");
	const settledCause = own(error, "cause");
	const nativeCandidates = [
		code,
		own(own(own(own(error, "meta"), "driverAdapterError"), "cause"), "originalCode"),
		own(settledCause, "originalCode"),
		own(settledCause, "code"),
	];
	const prismaCode = prismaCodes.find((candidate) => candidate === code) ?? "unknown";
	const nativeCode =
		(nativeCandidates.find(
			(candidate) =>
				candidate === "SQLITE_BUSY" ||
				candidate === "SQLITE_BUSY_SNAPSHOT" ||
				candidate === "SQLITE_LOCKED",
		) as SafeNativeCode | undefined) ?? "unknown";
	observed.set(error, {
		job: "queue-cleaner",
		operation,
		boundary: transactionEntered ? "transaction-callback" : "transaction-admission",
		transactionEntered,
		prismaCode,
		nativeCode,
		elapsedMs: Math.min(60_000, Math.ceil(Math.max(0, elapsedMs) / 100) * 100),
		retryObserved: false,
		outcome: "failed",
	});
}

/** Returns a record only for an exact allowlisted Prisma/native contention code. */
export function queueCleanerSqliteDiagnosticsFrom(error: unknown): Diagnostic | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const value = observed.get(error);
	if (!value || (value.prismaCode === "unknown" && value.nativeCode === "unknown"))
		return undefined;
	return { ...value };
}

/** Measures exactly one existing transaction boundary without changing retry or admission policy. */
export async function runQueueCleanerSqliteTransaction<T>(
	databaseUrl: string | undefined,
	operation: QueueCleanerOperation,
	transaction: (callback: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>,
	callback: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
	const startedAt = performance.now();
	let transactionEntered = false;
	try {
		return await transaction(async (tx) => {
			transactionEntered = true;
			return callback(tx);
		});
	} catch (error) {
		if (typeof databaseUrl === "string" && /^file:/i.test(databaseUrl))
			rememberQueueCleanerTransactionBoundary(
				error,
				operation,
				transactionEntered,
				performance.now() - startedAt,
			);
		throw error;
	}
}
