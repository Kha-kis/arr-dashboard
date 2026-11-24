import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { FastifyBaseLogger } from "fastify";
import { UpstreamValidationError } from "../validation/parse-upstream.js";
import { JellyfinClient, JellyfinEpisodePageResponseError } from "./jellyfin-client.js";
import {
	type JellyfinEpisodePageWorkerFailureCategory,
	type JellyfinEpisodePageWorkerResult,
	type JellyfinEpisodeProviderReadDiagnostic,
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
	let providerRead: JellyfinEpisodeProviderReadDiagnostic | undefined;
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
			const { category, kind, status } = details as {
				category?: unknown;
				kind?: unknown;
				status?: unknown;
			};
			if (category !== "jellyfin-provider-read-failure") return;
			// Project the client's bounded diagnostic only. Never propagate provider data or errors.
			const httpStatus =
				typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
					? status
					: null;
			switch (kind) {
				case "timeout":
					failure = "provider-timeout";
					providerRead = { kind, httpStatus };
					break;
				case "http-error":
					failure = "provider-response";
					providerRead = {
						kind:
							httpStatus === 401
								? "http-authentication"
								: httpStatus === 403
									? "http-authorization"
									: kind,
						httpStatus,
					};
					break;
				case "unexpected-content-type":
				case "invalid-json":
					failure = "provider-response";
					providerRead = { kind, httpStatus };
					break;
				case "schema":
					failure = "provider-response";
					providerRead = { kind: "episode-page-envelope-schema", httpStatus };
					break;
				case "aborted":
				case "transport":
					providerRead = { kind, httpStatus };
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
				providerRead: { kind: "worker-page-invalid", httpStatus: null },
			}
		);
	} catch (error) {
		if (error instanceof JellyfinEpisodePageResponseError) {
			return {
				status: "failed",
				category: "provider-response",
				providerRead: { kind: error.kind, httpStatus: error.httpStatus },
			};
		}
		// Inspect only the schema's fixed path prefix. Never return issue text.
		if (
			error instanceof UpstreamValidationError &&
			providerRead?.kind === "episode-page-envelope-schema"
		) {
			if (error.issues.some((issue) => issue.startsWith("Items."))) {
				providerRead = { kind: "episode-row-schema", httpStatus: providerRead.httpStatus };
			}
		}
		return { status: "failed", category: failure, ...(providerRead ? { providerRead } : {}) };
	}
}

const workerPort = parentPort;
if (!isMainThread && workerPort) {
	void executeJellyfinEpisodePage(workerData).then((result) => {
		workerPort.postMessage(result);
		workerPort.close();
	});
}
