import { Worker } from "node:worker_threads";
import type { JellyfinNativeInventoryPageResult } from "./jellyfin-client.js";
import {
	type JellyfinNativePageWorkerInput,
	type JellyfinNativePageWorkerRequest,
	parseJellyfinNativePageWorkerRequest,
	parseJellyfinNativePageWorkerResult,
} from "./jellyfin-native-page-worker-protocol.js";

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
export class JellyfinNativePageWorkerError extends Error {
	constructor(readonly category: FailureCategory) {
		super("Jellyfin native inventory page unavailable");
		this.name = category === "worker-timeout" ? "TimeoutError" : "JellyfinNativePageWorkerError";
	}
}
export function jellyfinNativePageWorkerUrl(moduleUrl = import.meta.url): URL {
	return moduleUrl.endsWith("/jellyfin-native-page-worker-transport.ts")
		? new URL("./jellyfin-native-page-worker.ts", moduleUrl)
		: new URL("./lib/jellyfin/jellyfin-native-page-worker.js", moduleUrl);
}
export function createJellyfinNativePageWorker(
	url: URL,
	workerData: JellyfinNativePageWorkerRequest,
): Worker {
	const options = { workerData, env: {}, execArgv: [], stdout: true, stderr: true };
	if (url.pathname.endsWith(".ts")) {
		const bootstrap = `const { parentPort } = require("node:worker_threads");
(async () => {
	const { register } = await import("tsx/esm/api");
	register();
	await import(${JSON.stringify(url.href)});
})().catch(() => { parentPort.postMessage({ status: "failed", category: "provider-unavailable" }); parentPort.close(); });`;
		return new Worker(bootstrap, { ...options, eval: true });
	}
	return new Worker(url, options);
}

/** Keep admission owned until independent worker exit, even if termination fails. */
export async function runJellyfinNativePageWorker(
	input: JellyfinNativePageWorkerInput,
	options: {
		signal?: AbortSignal;
		createWorker?: (url: URL, data: JellyfinNativePageWorkerRequest) => WorkerLike;
		/** Test seams may only shorten the production page budgets. */
		timeoutMs?: number;
		requestTimeoutMs?: number;
	} = {},
): Promise<JellyfinNativeInventoryPageResult> {
	if (options.signal?.aborted) throw new JellyfinNativePageWorkerError("cancelled");
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
		throw new JellyfinNativePageWorkerError("worker-failed");
	const remainingSliceMs = Math.floor(input.deadlineAt - Date.now());
	if (remainingSliceMs < 1) return { status: "unavailable", reason: "deadline-exceeded" };
	const timeoutMs = Math.min(requestedTimeout, remainingSliceMs);
	const payload = parseJellyfinNativePageWorkerRequest({
		...input,
		httpAuthHeaders: input.httpAuthHeaders ?? {},
		version: 1,
		requestTimeoutMs: Math.min(requestTimeout, timeoutMs),
	});
	if (!payload) throw new JellyfinNativePageWorkerError("worker-failed");
	let worker: WorkerLike;
	try {
		worker = (options.createWorker ?? createJellyfinNativePageWorker)(
			jellyfinNativePageWorkerUrl(),
			payload,
		);
	} catch {
		throw new JellyfinNativePageWorkerError("worker-failed");
	}
	return await new Promise<JellyfinNativeInventoryPageResult>((resolve, reject) => {
		let exited = false;
		let received = false;
		let stopRequested = false;
		let failure: FailureCategory | undefined;
		let page: JellyfinNativeInventoryPageResult | undefined;
		const requestStop = () => {
			if (stopRequested || exited) return;
			stopRequested = true;
			try {
				void Promise.resolve(worker.terminate()).catch(() => {
					/* Await independent exit. */
				});
			} catch {
				/* Synchronous refusal does not release active work. */
			}
		};
		const fail = (category: FailureCategory) => {
			if (exited) return;
			failure ??= category;
			page = undefined;
			requestStop();
		};
		const remainingMs = timeoutMs - (performance.now() - startedAt);
		const abort = () => fail("cancelled");
		const timer = setTimeout(() => fail("worker-timeout"), Math.max(0, remainingMs));
		worker.on("exit", (code) => {
			if (exited) return;
			exited = true;
			options.signal?.removeEventListener("abort", abort);
			clearTimeout(timer);
			if (performance.now() - startedAt >= timeoutMs || Date.now() >= input.deadlineAt)
				failure ??= "worker-timeout";
			if (!failure && page && code === 0) resolve(page);
			else reject(new JellyfinNativePageWorkerError(failure ?? "worker-failed"));
		});
		worker.on("error", () => fail("worker-failed"));
		worker.on("messageerror", () => fail("invalid-message"));
		worker.on("message", (message) => {
			if (exited || failure) return;
			if (received) return fail("invalid-message");
			received = true;
			const result = parseJellyfinNativePageWorkerResult(message, payload);
			if (!result) return fail("invalid-message");
			if (result.status === "failed") return fail("provider-unavailable");
			page = result;
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
