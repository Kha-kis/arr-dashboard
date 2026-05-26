/**
 * In-process per-user event bus for qui webhook events (Phase 5.2).
 *
 * The webhook receiver (Phase 5.1) writes inbound qui events to
 * `QuiEventLog` and then calls `quiEventBus.publish(userId, ...)`.
 * Open SSE connections (`GET /api/qui/events/stream`) subscribe per user
 * and receive `event:` lines as they arrive — driving React Query
 * invalidation in the frontend without the per-component polling that
 * dominates the v1-v3 design.
 *
 * Why in-process: arr-dashboard is single-process per container. Cross-
 * process fan-out would require Redis pub/sub or similar — not in scope
 * for v1. If a future deployment scales horizontally, this module becomes
 * the swap point (replace the Map with a Redis-backed event store).
 *
 * Memory profile: each subscriber holds a callback reference + their
 * userId. We trim the per-user listener list on `unsubscribe()`; a leaked
 * subscriber would survive only until the next process restart. Listener
 * counts are capped per user (see `MAX_LISTENERS_PER_USER`) so a hostile
 * or buggy client opening many EventSource connections can't exhaust
 * Node FDs or timer slots for the rest of the process.
 */

import type { FastifyBaseLogger } from "fastify";

export interface QuiEventBusMessage {
	id: string;
	type: string;
	torrentHash: string | null;
	receivedAt: string;
}

type Listener = (msg: QuiEventBusMessage) => void;

/**
 * Per-user listener cap (≈ concurrent SSE connections allowed). Generous
 * enough for legitimate multi-tab/multi-device use but tight enough that
 * an attacker with a valid session can't open thousands of long-poll
 * sockets and force `EMFILE` on the host.
 */
export const MAX_LISTENERS_PER_USER = 50;

class QuiEventBus {
	private readonly listenersByUser = new Map<string, Set<Listener>>();

	/**
	 * Add a listener for `userId`. Returns an unsubscribe function on
	 * success, or `null` when the per-user cap is exceeded — callers
	 * should close the stream rather than retry. The cap check happens
	 * BEFORE the listener is added so a rejected subscription doesn't
	 * count toward the count.
	 */
	subscribe(userId: string, listener: Listener, log?: FastifyBaseLogger): (() => void) | null {
		let set = this.listenersByUser.get(userId);
		if (!set) {
			set = new Set();
			this.listenersByUser.set(userId, set);
		}
		if (set.size >= MAX_LISTENERS_PER_USER) {
			log?.warn(
				{ userId, currentListeners: set.size, cap: MAX_LISTENERS_PER_USER },
				"qui event bus: per-user listener cap reached, rejecting subscription",
			);
			return null;
		}
		set.add(listener);
		return () => {
			const current = this.listenersByUser.get(userId);
			if (!current) return;
			current.delete(listener);
			if (current.size === 0) {
				this.listenersByUser.delete(userId);
			}
		};
	}

	/**
	 * Fan out one message to every listener for `userId`. Listener errors
	 * are isolated so one misbehaving subscriber can't drop events for
	 * the rest of the room. The optional `log` lets the caller pass
	 * request.log so the warning is correlated with the originating
	 * webhook (no logger context = stdout-only fallback).
	 */
	publish(userId: string, msg: QuiEventBusMessage, log?: FastifyBaseLogger): void {
		const set = this.listenersByUser.get(userId);
		if (!set) return;
		// Snapshot the listener set before iterating — a listener may
		// unsubscribe itself (or another) inline, and mutating during
		// iteration would skip subscribers or throw.
		for (const listener of [...set]) {
			try {
				listener(msg);
			} catch (err) {
				if (log) {
					log.warn({ err, userId, msgType: msg.type }, "qui event bus listener threw");
				} else {
					// biome-ignore lint/suspicious/noConsole: no logger available — fallback only fires from synchronous publish paths invoked without a request context (e.g., future scheduler emitters); production paths from the webhook receiver always pass request.log
					console.warn("qui event bus listener threw:", err);
				}
			}
		}
	}

	/** Test-only: clear all listeners. Used by SSE route tests + bus unit tests. */
	clearForTests(): void {
		this.listenersByUser.clear();
	}

	/** Test-only: subscriber count for assertions. */
	listenerCountForTests(userId: string): number {
		return this.listenersByUser.get(userId)?.size ?? 0;
	}
}

export const quiEventBus = new QuiEventBus();
