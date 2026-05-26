/**
 * qui cache pre-warm — pure logic.
 *
 * The Fastify plugin (`plugins/qui-cache-prewarm.ts`) is a thin shim
 * over these helpers; the interesting behavior lives here so it can be
 * unit-tested without spinning up a real Fastify instance.
 *
 * Design notes:
 *   - `prewarmInstance` runs ONE qui instance's paginated walk with a
 *     hard per-instance timeout. It never throws — failure is logged
 *     and the next instance proceeds.
 *   - `prewarmAllSequential` walks instances one-at-a-time. Sequential
 *     is the load-bearing OOM-safety property; do not switch to
 *     Promise.all without revisiting the heap math in the plugin's
 *     doc comment.
 *   - All clocks (`Date.now`, `setTimeout`) are injectable so tests
 *     can use fake timers without monkey-patching globals.
 */

import type { Logger } from "pino";
import type { QuiClient } from "./client-factory.js";

/** Minimal subset of a Prisma `ServiceInstance` the pre-warm needs. */
export interface PrewarmInstance {
	id: string;
	label: string;
}

export interface PrewarmInstanceDeps {
	createClient: (instance: PrewarmInstance) => QuiClient;
	getCachedAllTorrents: (
		instanceId: string,
		client: QuiClient,
	) => Promise<{ length: number } | unknown[]>;
	timeoutMs: number;
	logger: Pick<Logger, "info" | "warn">;
	/** Injectable clock for tests. */
	now?: () => number;
	/** Injectable timer for tests. */
	setTimer?: (cb: () => void, ms: number) => { unref?: () => void };
	/** Injectable timer cleanup for tests. */
	clearTimer?: (handle: unknown) => void;
}

/**
 * Pre-warm one instance. Resolves on success or failure — never throws.
 * The timeout race uses the deps' injected timer so tests can avoid
 * real-world delays.
 */
export async function prewarmInstance(
	instance: PrewarmInstance,
	deps: PrewarmInstanceDeps,
): Promise<void> {
	const now = deps.now ?? Date.now;
	const setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
	const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
	const start = now();
	let timerHandle: unknown;
	try {
		const client = deps.createClient(instance);
		const timeoutPromise = new Promise<never>((_, reject) => {
			timerHandle = setTimer(
				() => reject(new Error(`pre-warm timed out after ${deps.timeoutMs}ms`)),
				deps.timeoutMs,
			);
			// Don't hold the loop open during shutdown when this races a
			// real `getCachedAllTorrents`.
			const h = timerHandle as { unref?: () => void };
			h.unref?.();
		});
		const result = await Promise.race([
			deps.getCachedAllTorrents(instance.id, client),
			timeoutPromise,
		]);
		// Clear the timer as soon as the real fetch wins the race; on
		// timeout the rejection handler already fired so this is a no-op.
		//
		// Note: `Promise.race` leaves the losing promise in `pending`
		// state. That's a well-known property of the JavaScript Promise
		// model — there's no built-in cancellation. Cleaner-looking
		// "fixes" (e.g., manually rejecting `timeoutPromise` here) would
		// either need an attached `.catch` (or produce unhandled-rejection
		// noise) or require an AbortController flowed all the way into
		// `getCachedAllTorrents`, which is a bigger surface change. In
		// practice the pending promise is collected within microseconds
		// when this function returns and its closure falls out of scope.
		clearTimer(timerHandle);
		const torrentCount = Array.isArray(result)
			? result.length
			: ((result as { length?: number }).length ?? 0);
		deps.logger.info(
			{
				instanceId: instance.id,
				label: instance.label,
				torrentCount,
				elapsedMs: now() - start,
			},
			"qui torrent-list cache pre-warm complete",
		);
	} catch (err) {
		clearTimer(timerHandle);
		deps.logger.warn(
			{
				err,
				instanceId: instance.id,
				label: instance.label,
				elapsedMs: now() - start,
			},
			"qui torrent-list cache pre-warm failed (cold-start cliff remains for this instance)",
		);
	}
}

export interface PrewarmAllDeps<T extends PrewarmInstance> {
	prewarmOne: (instance: T) => Promise<void>;
	isCancelled: () => boolean;
	logger: Pick<Logger, "info">;
}

/**
 * Walk instances strictly sequentially — one in-flight fetch at a time.
 * Bails immediately when the cancellation flag flips (graceful shutdown
 * mid-walk shouldn't kick off the next instance).
 *
 * The generic `T` lets callers pass full Prisma `ServiceInstance` rows
 * through to their `prewarmOne` callback without a downcast — the lib
 * only reads `id` and `label`, but the closure preserves whatever
 * additional fields the caller needs (e.g., `createQuiClient` needs
 * the encrypted credentials).
 *
 * IMPORTANT: this is `for-of` + `await`, NOT `Promise.all`. The
 * sequential property bounds peak memory to `baseline + 1 instance`
 * during the fetch+parse spike. Switching to parallel would multiply
 * that by N and risk approaching the 768 MB per-process heap cap.
 */
export async function prewarmAllSequential<T extends PrewarmInstance>(
	instances: T[],
	deps: PrewarmAllDeps<T>,
): Promise<void> {
	if (instances.length === 0) {
		deps.logger.info("qui cache pre-warm: no enabled qui instances, skipping");
		return;
	}
	deps.logger.info(
		{ instanceCount: instances.length },
		"qui cache pre-warm: starting sequential walk",
	);
	for (const instance of instances) {
		if (deps.isCancelled()) return;
		await deps.prewarmOne(instance);
	}
	deps.logger.info("qui cache pre-warm: all instances complete");
}
