import { type MessagePort, Worker } from "node:worker_threads";
import {
	attachRestoreRuntimeWorker,
	type RestoreRuntimeWorkerBinding,
} from "../backup/restore-runtime-admission.js";
import type {
	NativeInventoryRetentionCursor,
	NativeInventoryRetentionSlice,
} from "./native-inventory-retention.js";
import {
	isNativeInventoryRetentionFailureCode,
	isNativeInventoryRetentionFailurePhase,
	nativeInventoryRetentionDiagnosticsFrom,
	nativeInventoryRetentionFailureCode,
	parseNativeInventoryRetentionBoundary,
	type NativeInventoryRetentionFailureDiagnostics,
	type NativeInventoryRetentionTransportFailure,
	NativeInventoryRetentionWorkerError,
} from "./native-inventory-retention-diagnostics.js";
export { NativeInventoryRetentionWorkerError } from "./native-inventory-retention-diagnostics.js";

export type NativeInventoryRetentionWorkerPayload = {
	databaseUrl: string;
	cutoff: Date;
	rowLimit: number;
	scanLimit: number;
	cursor: NativeInventoryRetentionCursor | null;
	runtimeBinding?: RestoreRuntimeWorkerBinding;
};
export type NativeInventoryRetentionWorkerResult =
	| ({ status: "completed" } & NativeInventoryRetentionSlice)
	| { status: "cancelled" }
	| { status: "failed" }
	| ({ status: "failed" } & Pick<
			NativeInventoryRetentionFailureDiagnostics,
			"failurePhase" | "failureCode" | "retentionBoundary"
	  >);
type WorkerLike = {
	stdout?: { resume(): unknown } | null;
	stderr?: { resume(): unknown } | null;
	postMessage(message: { kind: "cancel" }): void;
	on(event: "message" | "error" | "messageerror", listener: (value: unknown) => void): WorkerLike;
	on(event: "exit", listener: (code: number) => void): WorkerLike;
	terminate(): Promise<number> | number;
};

function record(value: unknown): Record<string, unknown> | null {
	try {
		if (
			typeof value !== "object" ||
			value === null ||
			Object.getPrototypeOf(value) !== Object.prototype
		)
			return null;
		const result: Record<string, unknown> = Object.create(null);
		for (const key of Reflect.ownKeys(value)) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (typeof key !== "string" || !descriptor || !Object.hasOwn(descriptor, "value"))
				return null;
			result[key] = descriptor.value;
		}
		return result;
	} catch {
		return null;
	}
}
function bounded(value: unknown, maximum: number, minimum = 0): value is number {
	return (
		typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
	);
}
function cursor(value: unknown): value is NativeInventoryRetentionCursor | null {
	const fields = record(value);
	return (
		value === null ||
		(fields !== null &&
			Object.keys(fields).length === 1 &&
			typeof fields.id === "string" &&
			fields.id.length > 0 &&
			fields.id.length <= 256)
	);
}

/** Internal protocol only: never copy arbitrary fields or error details. */
export function parseNativeInventoryRetentionWorkerPayload(
	input: unknown,
): NativeInventoryRetentionWorkerPayload | null {
	const value = record(input);
	if (
		!value ||
		typeof value.databaseUrl !== "string" ||
		!value.databaseUrl.startsWith("file:") ||
		value.databaseUrl.length <= 5 ||
		!(value.cutoff instanceof Date) ||
		!Number.isFinite(value.cutoff.getTime()) ||
		value.cutoff.getTime() > Date.now() - 24 * 60 * 60_000 ||
		!bounded(value.rowLimit, 500, 1) ||
		!bounded(value.scanLimit, 100, 1) ||
		!cursor(value.cursor)
	)
		return null;
	return {
		databaseUrl: value.databaseUrl,
		cutoff: value.cutoff,
		rowLimit: value.rowLimit,
		scanLimit: value.scanLimit,
		cursor: value.cursor,
		...(value.runtimeBinding === undefined
			? {}
			: { runtimeBinding: value.runtimeBinding as RestoreRuntimeWorkerBinding }),
	};
}

export function parseNativeInventoryRetentionWorkerResult(
	message: unknown,
	input: NativeInventoryRetentionWorkerPayload,
): NativeInventoryRetentionWorkerResult | null {
	const value = record(message);
	if (!value) return null;
	if (
		(value.status === "cancelled" || value.status === "failed") &&
		Object.keys(value).length === 1
	)
		return value.status === "failed" ? { status: "failed" } : { status: "cancelled" };
	if (
		value.status === "failed" &&
		(Object.keys(value).length === 3 || Object.keys(value).length === 4) &&
		isNativeInventoryRetentionFailurePhase(value.failurePhase) &&
		isNativeInventoryRetentionFailureCode(value.failureCode)
	) {
		const boundary = parseNativeInventoryRetentionBoundary(value.retentionBoundary);
		if (Object.keys(value).length === 4 && !boundary) return null;
		if (Object.keys(value).length === 3 && Object.hasOwn(value, "retentionBoundary")) return null;
		return {
			status: "failed",
			failurePhase: value.failurePhase,
			failureCode: value.failureCode,
			...(boundary ? { retentionBoundary: boundary } : {}),
		};
	}
	if (
		value.status !== "completed" ||
		Object.keys(value).length !== 6 ||
		!bounded(value.deletedRows, input.rowLimit) ||
		!bounded(value.deletedRuns, value.deletedRows) ||
		!bounded(value.scannedRuns, input.scanLimit) ||
		value.deletedRuns > value.scannedRuns ||
		typeof value.hasMore !== "boolean" ||
		!cursor(value.nextCursor) ||
		(value.scannedRuns === 0 && value.deletedRows !== 0)
	)
		return null;
	return {
		status: "completed",
		deletedRows: value.deletedRows,
		deletedRuns: value.deletedRuns,
		scannedRuns: value.scannedRuns,
		nextCursor: value.nextCursor,
		hasMore: value.hasMore,
	};
}

export function nativeInventoryRetentionWorkerUrl(moduleUrl = import.meta.url): URL {
	return moduleUrl.endsWith("/native-inventory-retention-worker-transport.ts")
		? new URL("./native-inventory-retention-worker.ts", moduleUrl)
		: new URL("./lib/provider-observation/native-inventory-retention-worker.js", moduleUrl);
}

export function createNativeInventoryRetentionWorker(
	url: URL,
	workerData: NativeInventoryRetentionWorkerPayload,
	transferList: MessagePort[],
): Worker {
	const options = { workerData, transferList, env: {}, execArgv: [], stdout: true, stderr: true };
	let worker: Worker;
	if (url.pathname.endsWith(".ts")) {
		const bootstrap = `const { parentPort } = require("node:worker_threads");
(async () => { const { register } = await import("tsx/esm/api"); register();
await import(${JSON.stringify(url.href)}); })().catch(() => { parentPort.postMessage({ status: "failed" }); parentPort.close(); });`;
		worker = new Worker(bootstrap, { ...options, eval: true });
	} else worker = new Worker(url, options);
	return worker;
}

/** Results remain provisional until real exit and all runtime bridge work joins. */
export async function runNativeInventoryRetentionWorker(
	payload: NativeInventoryRetentionWorkerPayload,
	options: {
		signal?: AbortSignal;
		createWorker?: (
			url: URL,
			data: NativeInventoryRetentionWorkerPayload,
			transferList: MessagePort[],
		) => WorkerLike;
	} = {},
): Promise<Exclude<NativeInventoryRetentionWorkerResult, { status: "failed" }>> {
	if (options.signal?.aborted) return { status: "cancelled" };
	const input = parseNativeInventoryRetentionWorkerPayload(payload);
	if (!input)
		throw new NativeInventoryRetentionWorkerError({
			failurePhase: "unknown",
			failureCode: "unknown",
			transportFailure: "invalid-request",
		});
	let bridge: Awaited<ReturnType<typeof attachRestoreRuntimeWorker>> | undefined;
	let worker: WorkerLike;
	let firstFailure: NativeInventoryRetentionWorkerError | undefined;
	const transportFailure = (failure: NativeInventoryRetentionTransportFailure, error?: unknown) =>
		(firstFailure ??= new NativeInventoryRetentionWorkerError({
			failurePhase: "unknown",
			failureCode: nativeInventoryRetentionFailureCode(error),
			transportFailure: failure,
		}));
	let setupFailure: NativeInventoryRetentionTransportFailure = "attach-failed";
	try {
		bridge = await attachRestoreRuntimeWorker(input.databaseUrl);
		if (options.signal?.aborted) {
			setupFailure = "bridge-close-failed";
			await bridge.close();
			return { status: "cancelled" };
		}
		setupFailure = "worker-construction-failed";
		worker = (options.createWorker ?? createNativeInventoryRetentionWorker)(
			nativeInventoryRetentionWorkerUrl(),
			{ ...input, databaseUrl: bridge.binding.databaseUrl, runtimeBinding: bridge.binding },
			[bridge.binding.port],
		);
	} catch (error) {
		const failure = transportFailure(setupFailure, error);
		try {
			await bridge?.close();
		} catch {
			/* Preserve the first failure while joining closure. */
		}
		throw failure;
	}
	let cancel: (() => void) | undefined;
	let unsubscribe: (() => void) | undefined;
	try {
		return await new Promise<Exclude<NativeInventoryRetentionWorkerResult, { status: "failed" }>>(
			(resolve, reject) => {
				let exited = false,
					received = false,
					failed = false,
					stopRequested = false;
				let result: Exclude<NativeInventoryRetentionWorkerResult, { status: "failed" }> | undefined;
				const fail = (
					failure: NativeInventoryRetentionWorkerError | NativeInventoryRetentionTransportFailure,
					error?: unknown,
				) => {
					if (exited) return;
					firstFailure ??= typeof failure === "string" ? transportFailure(failure, error) : failure;
					failed = true;
					result = undefined;
					if (stopRequested) return;
					stopRequested = true;
					try {
						void Promise.resolve(worker.terminate()).catch(() => {});
					} catch {
						/* Await independent exit even on refusal. */
					}
				};
				cancel = () => {
					if (exited || received) return;
					// An entered mutation owns its rollback/commit and physical exit.
					try {
						worker.postMessage({ kind: "cancel" });
					} catch {
						/* Retain lifetime. */
					}
				};
				worker.on("exit", (code) => {
					if (exited) return;
					exited = true;
					if (!failed && result && code === 0) resolve(result);
					else
						reject(
							firstFailure ??
								transportFailure(
									code === 0 ? "worker-exited-without-result" : "worker-nonzero-exit",
								),
						);
				});
				worker.on("error", (error) => fail("worker-error", error));
				worker.on("messageerror", (error) => fail("worker-messageerror", error));
				worker.on("message", (message) => {
					if (exited || failed) return;
					if (received) return fail("invalid-worker-result");
					received = true;
					const parsed = parseNativeInventoryRetentionWorkerResult(message, input);
					if (!parsed) return fail("invalid-worker-result");
					if (parsed.status === "failed")
						return fail(
							new NativeInventoryRetentionWorkerError(
								nativeInventoryRetentionDiagnosticsFrom(parsed),
							),
						);
					result = parsed;
				});
				unsubscribe = bridge!.onUnavailable(() => fail("runtime-bridge-unavailable"));
				options.signal?.addEventListener("abort", cancel, { once: true });
				try {
					worker.stdout?.resume();
					worker.stderr?.resume();
				} catch (error) {
					fail("worker-error", error);
				}
				if (options.signal?.aborted) cancel();
			},
		);
	} finally {
		if (cancel) options.signal?.removeEventListener("abort", cancel);
		unsubscribe?.();
		await bridge.close().catch((error) => {
			throw transportFailure("bridge-close-failed", error);
		});
	}
}
