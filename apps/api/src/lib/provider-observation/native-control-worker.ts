import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { FastifyBaseLogger } from "fastify";
import { PlexClient } from "../plex/plex-client.js";
import { JellyfinClient } from "../jellyfin/jellyfin-client.js";
import { createPlexNativeJobAdapter } from "../plex/plex-native-inventory.js";
import { createJellyfinNativeLibraryJobAdapter } from "../jellyfin/jellyfin-native-inventory.js";
import { createJellyfinNativeEpisodeJobAdapter } from "../jellyfin/jellyfin-native-episode-inventory.js";
import {
	parseNativeControlWorkerRequest,
	parseNativeControlWorkerResult,
	type NativeControlWorkerResult,
} from "./native-control-worker-protocol.js";

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

/** No environment, database or application startup; adapters retain normalization. */
export async function executeNativeControl(value: unknown): Promise<NativeControlWorkerResult> {
	const input = parseNativeControlWorkerRequest(value);
	if (!input) return { status: "failed", category: "invalid-request" };
	if (Date.now() >= input.deadlineAt) return { status: "unavailable", reason: "deadline-exceeded" };
	try {
		const deadlineAt = Math.min(input.deadlineAt, Date.now() + input.requestTimeoutMs);
		let result: NativeControlWorkerResult;
		if (input.provider === "plex") {
			const client = new PlexClient(
				input.baseUrl,
				input.apiKey,
				silentLog,
				input.requestTimeoutMs,
				input.httpAuthHeaders,
			);
			result =
				input.operation === "identity"
					? { status: "identity", identity: (await client.getIdentity()).machineIdentifier }
					: await createPlexNativeJobAdapter(client).discoverScopes(deadlineAt);
		} else {
			const client = new JellyfinClient(
				input.baseUrl,
				input.apiKey,
				silentLog,
				input.requestTimeoutMs,
				input.httpAuthHeaders,
			);
			result =
				input.operation === "identity"
					? { status: "identity", identity: (await client.getServerInfo()).id }
					: await (input.workKey === "library"
							? createJellyfinNativeLibraryJobAdapter(client)
							: createJellyfinNativeEpisodeJobAdapter(client)
						).discoverScopes(deadlineAt);
		}
		return (
			parseNativeControlWorkerResult(result, input) ?? {
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
	void executeNativeControl(workerData).then((result) => {
		workerPort.postMessage(result);
		workerPort.close();
	});
}
