import { Worker } from "node:worker_threads";
import type { JellyfinEpisodeCollectedPage } from "./jellyfin-client.js";
import {
	type JellyfinEpisodePageWorkerInput,
	type JellyfinEpisodePageWorkerRequest,
	parseJellyfinEpisodePageWorkerRequest,
	parseJellyfinEpisodePageWorkerResult,
} from "./jellyfin-episode-page-worker-protocol.js";

type WorkerLike = {
	on(event: "message" | "error" | "messageerror", listener: (value: unknown) => void): WorkerLike;
	on(event: "exit", listener: (code: number) => void): WorkerLike;
	terminate(): Promise<number> | number;
	stdout: { resume(): unknown } | null;
	stderr: { resume(): unknown } | null;
};

type FailureCategory =
	| "worker-timeout"
	| "worker-failed"
	| "invalid-message"
	| "cancelled"
	| "provider-unavailable";

export class JellyfinEpisodePageWorkerError extends Error {
	constructor(readonly category: FailureCategory) {
		super("Jellyfin episode page unavailable");
		this.name = category === "worker-timeout" ? "TimeoutError" : "JellyfinEpisodePageWorkerError";
	}
}

export function jellyfinEpisodePageWorkerUrl(moduleUrl = import.meta.url): URL {
	return moduleUrl.endsWith("/jellyfin-episode-page-worker-transport.ts")
		? new URL("./jellyfin-episode-page-worker.ts", moduleUrl)
		: new URL("./lib/jellyfin/jellyfin-episode-page-worker.js", moduleUrl);
}

export function createJellyfinEpisodePageWorker(
	url: URL,
	workerData: JellyfinEpisodePageWorkerRequest,
): Worker {
	const options = { workerData, env: {}, execArgv: [], stdout: true, stderr: true };
	if (url.pathname.endsWith(".ts")) {
		// Each source worker needs its own .js-to-.ts resolution registration.
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

/** No result (including failure) releases admitted work before independent exit. */
export async function runJellyfinEpisodePageWorker(
	input: JellyfinEpisodePageWorkerInput,
	options: {
		signal?: AbortSignal;
		createWorker?: (url: URL, data: JellyfinEpisodePageWorkerRequest) => WorkerLike;
		/** Internal test seams may shorten, never increase, production budgets. */
		timeoutMs?: number;
		requestTimeoutMs?: number;
	} = {},
): Promise<JellyfinEpisodeCollectedPage> {
	if (options.signal?.aborted) throw new JellyfinEpisodePageWorkerError("cancelled");
	const startedAt = performance.now();
	const timeoutMs = options.timeoutMs ?? 20_000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000)
		throw new JellyfinEpisodePageWorkerError("worker-failed");
	const payload = parseJellyfinEpisodePageWorkerRequest({
		...input,
		httpAuthHeaders: input.httpAuthHeaders ?? {},
		version: 1,
		requestTimeoutMs: options.requestTimeoutMs ?? 15_000,
	});
	if (!payload) throw new JellyfinEpisodePageWorkerError("worker-failed");
	let worker: WorkerLike;
	try {
		worker = (options.createWorker ?? createJellyfinEpisodePageWorker)(
			jellyfinEpisodePageWorkerUrl(),
			payload,
		);
	} catch {
		throw new JellyfinEpisodePageWorkerError("worker-failed");
	}
	return await new Promise<JellyfinEpisodeCollectedPage>((resolve, reject) => {
		let exited = false;
		let received = false;
		let stopRequested = false;
		let failure: FailureCategory | undefined;
		let page: JellyfinEpisodeCollectedPage | undefined;
		const requestStop = () => {
			if (stopRequested || exited) return;
			stopRequested = true;
			try {
				void Promise.resolve(worker.terminate()).catch(() => {
					// Refused termination is not closure proof. Keep awaiting exit.
				});
			} catch {
				// Synchronous refusal also leaves the caller owning active work.
			}
		};
		const fail = (category: FailureCategory) => {
			if (exited) return;
			failure ??= category;
			page = undefined;
			requestStop();
		};
		const remainingMs = timeoutMs - (performance.now() - startedAt);
		const timer = setTimeout(() => fail("worker-timeout"), Math.max(0, remainingMs));
		const abort = () => {
			// A message is provisional until exit; live work remains cancellable.
			fail("cancelled");
		};
		options.signal?.addEventListener("abort", abort, { once: true });
		worker.on("exit", (code: number) => {
			if (exited) return;
			exited = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			if (performance.now() - startedAt >= timeoutMs) failure ??= "worker-timeout";
			if (!failure && page && code === 0) resolve(page);
			else reject(new JellyfinEpisodePageWorkerError(failure ?? "worker-failed"));
		});
		worker.on("error", () => fail("worker-failed"));
		worker.on("messageerror", () => fail("invalid-message"));
		worker.on("message", (message: unknown) => {
			if (exited || failure) return;
			if (received) return fail("invalid-message");
			received = true;
			const result = parseJellyfinEpisodePageWorkerResult(message, payload);
			if (!result) return fail("invalid-message");
			if (result.status === "failed") return fail("provider-unavailable");
			page = result.page;
			// A success message is provisional; only a clean exit can return it.
		});
		// Discard explicit pipes; never inherit console or retain provider text.
		try {
			worker.stdout?.resume();
			worker.stderr?.resume();
		} catch {
			fail("worker-failed");
		}
		if (remainingMs <= 0) fail("worker-timeout");
		if (options.signal?.aborted) abort();
	});
}
