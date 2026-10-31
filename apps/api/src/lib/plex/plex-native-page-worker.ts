import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { FastifyBaseLogger } from "fastify";
import { PlexClient } from "./plex-client.js";
import {
	type PlexNativePageWorkerResult,
	parsePlexNativePageWorkerRequest,
	parsePlexNativePageWorkerResult,
} from "./plex-native-page-worker-protocol.js";

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
export async function executePlexNativePage(value: unknown): Promise<PlexNativePageWorkerResult> {
	const input = parsePlexNativePageWorkerRequest(value);
	if (!input) return { status: "failed", category: "invalid-request" };
	try {
		const client = new PlexClient(
			input.baseUrl,
			input.apiKey,
			silentLog,
			input.requestTimeoutMs,
			input.httpAuthHeaders,
		);
		const page = await client.readNativeInventoryPage({
			domain: input.domain,
			sectionId: input.sectionId,
			startIndex: input.startIndex,
			limit: input.limit,
			deadlineAt: Math.min(input.deadlineAt, Date.now() + input.requestTimeoutMs),
		});
		return (
			parsePlexNativePageWorkerResult(page, input) ?? {
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
	void executePlexNativePage(workerData).then((result) => {
		workerPort.postMessage(result);
		workerPort.close();
	});
}
