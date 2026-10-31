import { type MessagePort, Worker } from "node:worker_threads";
import {
	attachRestoreRuntimeWorker,
	type RestoreRuntimeWorkerBinding,
} from "../backup/restore-runtime-admission.js";
import type {
	NativeInventoryRetentionCursor,
	NativeInventoryRetentionSlice,
} from "./native-inventory-retention.js";

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
	| { status: "failed" };
type WorkerLike = {
	stdout?: { resume(): unknown } | null;
	stderr?: { resume(): unknown } | null;
	postMessage(message: { kind: "cancel" }): void;
	on(event: "message" | "error" | "messageerror", listener: (value: unknown) => void): WorkerLike;
	on(event: "exit", listener: (code: number) => void): WorkerLike;
	terminate(): Promise<number> | number;
};

export class NativeInventoryRetentionWorkerError extends Error {
	constructor() {
		super("Native inventory retention worker failed");
		this.name = "NativeInventoryRetentionWorkerError";
	}
}

function record(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		Object.getPrototypeOf(value) === Object.prototype &&
		Reflect.ownKeys(value).every((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			return (
				typeof key === "string" && descriptor !== undefined && Object.hasOwn(descriptor, "value")
			);
		})
	);
}
function bounded(value: unknown, maximum: number, minimum = 0): value is number {
	return (
		typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
	);
}
function cursor(value: unknown): value is NativeInventoryRetentionCursor | null {
	return (
		value === null ||
		(record(value) &&
			Object.keys(value).length === 1 &&
			typeof value.id === "string" &&
			value.id.length > 0 &&
			value.id.length <= 256)
	);
}

/** Internal protocol only: never copy arbitrary fields or error details. */
export function parseNativeInventoryRetentionWorkerPayload(
	value: unknown,
): NativeInventoryRetentionWorkerPayload | null {
	if (
		!record(value) ||
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
	value: unknown,
	input: NativeInventoryRetentionWorkerPayload,
): NativeInventoryRetentionWorkerResult | null {
	if (!record(value)) return null;
	if (
		(value.status === "cancelled" || value.status === "failed") &&
		Object.keys(value).length === 1
	)
		return { status: value.status };
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
	if (!input) throw new NativeInventoryRetentionWorkerError();
	let bridge: Awaited<ReturnType<typeof attachRestoreRuntimeWorker>> | undefined;
	let worker: WorkerLike;
	try {
		bridge = await attachRestoreRuntimeWorker(input.databaseUrl);
		if (options.signal?.aborted) {
			await bridge.close();
			return { status: "cancelled" };
		}
		worker = (options.createWorker ?? createNativeInventoryRetentionWorker)(
			nativeInventoryRetentionWorkerUrl(),
			{ ...input, databaseUrl: bridge.binding.databaseUrl, runtimeBinding: bridge.binding },
			[bridge.binding.port],
		);
	} catch {
		try {
			await bridge?.close();
		} catch {
			/* Expose only the generic failure. */
		}
		throw new NativeInventoryRetentionWorkerError();
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
				const fail = () => {
					if (exited) return;
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
					else reject(new NativeInventoryRetentionWorkerError());
				});
				worker.on("error", fail);
				worker.on("messageerror", fail);
				worker.on("message", (message) => {
					if (exited || failed) return;
					if (received) return fail();
					received = true;
					const parsed = parseNativeInventoryRetentionWorkerResult(message, input);
					if (!parsed || parsed.status === "failed") return fail();
					result = parsed;
				});
				unsubscribe = bridge!.onUnavailable(fail);
				options.signal?.addEventListener("abort", cancel, { once: true });
				try {
					worker.stdout?.resume();
					worker.stderr?.resume();
				} catch {
					fail();
				}
				if (options.signal?.aborted) cancel();
			},
		);
	} finally {
		if (cancel) options.signal?.removeEventListener("abort", cancel);
		unsubscribe?.();
		await bridge.close().catch(() => {
			throw new NativeInventoryRetentionWorkerError();
		});
	}
}
