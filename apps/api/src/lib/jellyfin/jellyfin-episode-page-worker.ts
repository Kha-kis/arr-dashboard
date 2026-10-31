import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { FastifyBaseLogger } from "fastify";
import { JellyfinClient } from "./jellyfin-client.js";
import {
	type JellyfinEpisodePageWorkerResult,
	parseJellyfinEpisodePageWorkerRequest,
	parseJellyfinEpisodePageWorkerResult,
} from "./jellyfin-episode-page-worker-protocol.js";

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

/** One existing validated GET, with no database or mutation responsibility. */
export async function executeJellyfinEpisodePage(
	value: unknown,
): Promise<JellyfinEpisodePageWorkerResult> {
	const input = parseJellyfinEpisodePageWorkerRequest(value);
	if (!input) return { status: "failed", category: "invalid-request" };
	try {
		const client = new JellyfinClient(
			input.baseUrl,
			input.apiKey,
			silentLog,
			input.requestTimeoutMs,
			input.httpAuthHeaders,
		);
		const page = await client.getEpisodeItemsPageWithCoverage(
			input.userId,
			input.libraryId,
			input.startIndex,
			input.limit,
		);
		return (
			parseJellyfinEpisodePageWorkerResult({ status: "page", page }, input) ?? {
				status: "failed",
				category: "provider-unavailable",
			}
		);
	} catch {
		// Never inspect, format, or return provider error text/cause/stack.
		return { status: "failed", category: "provider-unavailable" };
	}
}

const workerPort = parentPort;
if (!isMainThread && workerPort) {
	void executeJellyfinEpisodePage(workerData).then((result) => {
		workerPort.postMessage(result);
		workerPort.close();
	});
}
