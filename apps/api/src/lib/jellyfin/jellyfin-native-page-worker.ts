import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { FastifyBaseLogger } from "fastify";
import { JellyfinClient } from "./jellyfin-client.js";
import {
	type JellyfinNativePageWorkerResult,
	parseJellyfinNativePageWorkerRequest,
	parseJellyfinNativePageWorkerResult,
} from "./jellyfin-native-page-worker-protocol.js";

const silentLog = {
	trace() {},
	debug() {},
	info() {},
	warn() {},
	error() {},
	fatal() {},
	child() {
		return this;
	},
} as unknown as FastifyBaseLogger;

/** Exactly the existing validated server-scoped read; no application or DB startup. */
export async function executeJellyfinNativePage(
	value: unknown,
): Promise<JellyfinNativePageWorkerResult> {
	const input = parseJellyfinNativePageWorkerRequest(value);
	if (!input) return { status: "failed", category: "invalid-request" };
	try {
		const client = new JellyfinClient(
			input.baseUrl,
			input.apiKey,
			silentLog,
			input.requestTimeoutMs,
			input.httpAuthHeaders,
		);
		const page = await client.readNativeInventoryPage({
			domain: input.domain,
			libraryId: input.libraryId,
			...(input.includeItemTypes !== undefined ? { includeItemTypes: input.includeItemTypes } : {}),
			startIndex: input.startIndex,
			limit: input.limit,
			deadlineAt: Math.min(input.deadlineAt, Date.now() + input.requestTimeoutMs),
		});
		return (
			parseJellyfinNativePageWorkerResult(page, input) ?? {
				status: "failed",
				category: "provider-unavailable",
			}
		);
	} catch {
		return { status: "failed", category: "provider-unavailable" };
	}
}

const workerPort = parentPort;
if (!isMainThread && workerPort) {
	void executeJellyfinNativePage(workerData).then((result) => {
		workerPort.postMessage(result);
		workerPort.close();
	});
}
