import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { FastifyBaseLogger } from "fastify";
import { JellyfinClient, JellyfinEpisodePageResponseError } from "./jellyfin-client.js";
import {
	type JellyfinEpisodePageWorkerFailureCategory,
	type JellyfinEpisodePageWorkerResult,
	parseJellyfinEpisodePageWorkerRequest,
	parseJellyfinEpisodePageWorkerResult,
} from "./jellyfin-episode-page-worker-protocol.js";

/** One existing validated GET, with no database or mutation responsibility. */
export async function executeJellyfinEpisodePage(
	value: unknown,
): Promise<JellyfinEpisodePageWorkerResult> {
	const input = parseJellyfinEpisodePageWorkerRequest(value);
	if (!input) return { status: "failed", category: "invalid-request" };
	let failure: JellyfinEpisodePageWorkerFailureCategory = "provider-unavailable";
	const log = {
		trace() {},
		debug() {},
		info() {},
		error() {},
		fatal() {},
		child() {
			return this;
		},
		warn(details: unknown) {
			if (typeof details !== "object" || details === null) return;
			const { category, kind } = details as { category?: unknown; kind?: unknown };
			if (category !== "jellyfin-provider-read-failure") return;
			// Read the client's closed diagnostic only. Never forward logger fields or errors.
			switch (kind) {
				case "timeout":
					failure = "provider-timeout";
					break;
				case "http-error":
				case "unexpected-content-type":
				case "invalid-json":
				case "schema":
					failure = "provider-response";
					break;
			}
		},
	} as unknown as FastifyBaseLogger;
	try {
		const client = new JellyfinClient(
			input.baseUrl,
			input.apiKey,
			log,
			input.requestTimeoutMs,
			input.httpAuthHeaders,
		);
		const readPage = input.uncounted
			? client.getUncountedEpisodeItemsPageWithCoverage.bind(client)
			: client.getEpisodeItemsPageWithCoverage.bind(client);
		const page = await readPage(input.userId, input.libraryId, input.startIndex, input.limit);
		return (
			parseJellyfinEpisodePageWorkerResult({ status: "page", page }, input) ?? {
				status: "failed",
				category: "provider-response",
			}
		);
	} catch (error) {
		// Never inspect, format, or return provider error text/cause/stack.
		return {
			status: "failed",
			category: error instanceof JellyfinEpisodePageResponseError ? "provider-response" : failure,
		};
	}
}

const workerPort = parentPort;
if (!isMainThread && workerPort) {
	void executeJellyfinEpisodePage(workerData).then((result) => {
		workerPort.postMessage(result);
		workerPort.close();
	});
}
