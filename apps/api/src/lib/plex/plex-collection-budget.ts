import type { FastifyBaseLogger } from "fastify";
import type { PlexReadContext, PlexReadPhase } from "./plex-client.js";

const CANONICAL_COLLECTION_BUDGET_MS = 10 * 60 * 1000;

/**
 * Bounds collection only, never a publication transaction. If a dependency
 * ignores cancellation, its late result has no path back to the publisher.
 */
export async function collectWithinPlexBudget<T>(
	log: FastifyBaseLogger,
	collect: (context: PlexReadContext) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	const startedAt = performance.now();
	let lastRead: PlexReadPhase | "not-started" = "not-started";
	let requests = 0;
	const timeoutError = new Error("Plex canonical collection deadline exceeded");
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			// Reject first so an abort-aware collector cannot turn expiry into a
			// partial success by swallowing the transport cancellation.
			reject(timeoutError);
			controller.abort(timeoutError);
		}, CANONICAL_COLLECTION_BUDGET_MS);
		timer.unref?.();
	});
	try {
		const result = await Promise.race([
			deadline,
			collect({
				signal: controller.signal,
				onRequest: (phase) => {
					lastRead = phase;
					requests++;
				},
			}),
		]);
		controller.signal.throwIfAborted();
		return result;
	} finally {
		clearTimeout(timer);
		log.info(
			{
				category: "plex-canonical-collection",
				outcome: controller.signal.aborted ? "deadline-exceeded" : "settled",
				lastRead,
				requests,
				durationMs: Math.round(performance.now() - startedAt),
			},
			"Plex canonical collection settled",
		);
	}
}
