import { Worker } from "node:worker_threads";
import {
	type NativeControlWorkerInput,
	type NativeControlWorkerRequest,
	type NativeControlSuccess,
	type NativeControlWorkerResult,
	parseNativeControlWorkerRequest,
	parseNativeControlWorkerResult,
} from "./native-control-worker-protocol.js";

type WorkerLike = {
	on(event: "message" | "error" | "messageerror", listener: (value: unknown) => void): WorkerLike;
	on(event: "exit", listener: (code: number) => void): WorkerLike;
	terminate(): Promise<number> | number;
	stdout: { resume(): unknown } | null;
	stderr: { resume(): unknown } | null;
};
type FailureCategory =
	| "cancelled"
	| "worker-timeout"
	| "worker-failed"
	| "invalid-message"
	| "provider-unavailable";
export class NativeControlWorkerError extends Error {
	constructor(readonly category: FailureCategory) {
		super("Native inventory control read unavailable");
		this.name = category === "worker-timeout" ? "TimeoutError" : "NativeControlWorkerError";
	}
}
export function nativeControlWorkerUrl(moduleUrl = import.meta.url): URL {
	return moduleUrl.endsWith("/native-control-worker-transport.ts")
		? new URL("./native-control-worker.ts", moduleUrl)
		: new URL("./lib/provider-observation/native-control-worker.js", moduleUrl);
}
export function createNativeControlWorker(
	url: URL,
	workerData: NativeControlWorkerRequest,
): Worker {
	const options = { workerData, env: {}, execArgv: [], stdout: true, stderr: true };
	if (url.pathname.endsWith(".ts")) {
		const bootstrap = `const { parentPort } = require("node:worker_threads");
(async () => {
	const { register } = await import("tsx/esm/api"); register();
	await import(${JSON.stringify(url.href)});
})().catch(() => { parentPort.postMessage({ status: "failed", category: "provider-unavailable" }); parentPort.close(); });`;
		return new Worker(bootstrap, { ...options, eval: true });
	}
	return new Worker(url, options);
}

/** A result is provisional until independent exit; termination is only a request. */
export async function runNativeControlWorker<T extends NativeControlWorkerInput>(
	input: T,
	options: {
		signal?: AbortSignal;
		createWorker?: (url: URL, data: NativeControlWorkerRequest) => WorkerLike;
		timeoutMs?: number;
		requestTimeoutMs?: number;
	} = {},
): Promise<NativeControlSuccess<T>> {
	if (options.signal?.aborted) throw new NativeControlWorkerError("cancelled");
	const startedAt = performance.now();
	const requestedTimeout = options.timeoutMs ?? 20_000;
	const requestTimeout = options.requestTimeoutMs ?? 15_000;
	if (
		!Number.isSafeInteger(requestedTimeout) ||
		requestedTimeout < 1 ||
		requestedTimeout > 20_000 ||
		!Number.isSafeInteger(requestTimeout) ||
		requestTimeout < 1 ||
		requestTimeout > 15_000 ||
		!Number.isFinite(input.deadlineAt)
	)
		throw new NativeControlWorkerError("worker-failed");
	const remainingSliceMs = Math.floor(input.deadlineAt - Date.now());
	if (remainingSliceMs < 1)
		return { status: "unavailable", reason: "deadline-exceeded" } as NativeControlSuccess<T>;
	const timeoutMs = Math.min(requestedTimeout, remainingSliceMs);
	const payload = parseNativeControlWorkerRequest({
		...input,
		httpAuthHeaders: input.httpAuthHeaders ?? {},
		version: 1,
		requestTimeoutMs: Math.min(requestTimeout, timeoutMs),
	});
	if (!payload) throw new NativeControlWorkerError("worker-failed");
	let worker: WorkerLike;
	try {
		worker = (options.createWorker ?? createNativeControlWorker)(nativeControlWorkerUrl(), payload);
	} catch {
		throw new NativeControlWorkerError("worker-failed");
	}
	return await new Promise<NativeControlSuccess<T>>((resolve, reject) => {
		let exited = false;
		let received = false;
		let stopRequested = false;
		let failure: FailureCategory | undefined;
		let result: NativeControlWorkerResult | undefined;
		const requestStop = () => {
			if (stopRequested || exited) return;
			stopRequested = true;
			try {
				void Promise.resolve(worker.terminate()).catch(() => {
					/* Await independent exit. */
				});
			} catch {
				/* Refusal does not release ownership. */
			}
		};
		const fail = (category: FailureCategory) => {
			if (exited) return;
			failure ??= category;
			result = undefined;
			requestStop();
		};
		const abort = () => fail("cancelled");
		const remainingMs = timeoutMs - (performance.now() - startedAt);
		const timer = setTimeout(() => fail("worker-timeout"), Math.max(0, remainingMs));
		worker.on("exit", (code) => {
			if (exited) return;
			exited = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			if (performance.now() - startedAt >= timeoutMs || Date.now() >= input.deadlineAt)
				failure ??= "worker-timeout";
			if (!failure && result && code === 0) resolve(result as NativeControlSuccess<T>);
			else reject(new NativeControlWorkerError(failure ?? "worker-failed"));
		});
		worker.on("error", () => fail("worker-failed"));
		worker.on("messageerror", () => fail("invalid-message"));
		worker.on("message", (message) => {
			if (exited || failure) return;
			if (received) return fail("invalid-message");
			received = true;
			const parsed = parseNativeControlWorkerResult(message, payload);
			if (!parsed) return fail("invalid-message");
			if (parsed.status === "failed") return fail("provider-unavailable");
			result = parsed;
		});
		try {
			worker.stdout?.resume();
			worker.stderr?.resume();
		} catch {
			fail("worker-failed");
		}
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
		if (remainingMs <= 0) fail("worker-timeout");
	});
}
