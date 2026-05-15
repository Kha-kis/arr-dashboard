/**
 * Unit tests for the in-process qui event bus (Phase 5.2).
 *
 * The bus is the seam between the webhook receiver and the SSE route;
 * regressions here would silently drop pushes to the UI. We cover:
 *   - Basic subscribe/publish flow.
 *   - Per-user isolation (subscribers on user A never see user B's events).
 *   - In-publish unsubscribe (a listener that detaches mid-fanout must
 *     not break iteration for siblings).
 *   - Listener errors don't poison the fanout for other subscribers.
 *   - Cleanup math — listener count tracks add/remove correctly.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_LISTENERS_PER_USER, type QuiEventBusMessage, quiEventBus } from "../event-bus.js";

const sampleMsg = (overrides: Partial<QuiEventBusMessage> = {}): QuiEventBusMessage => ({
	id: "evt-1",
	type: "torrent_added",
	torrentHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	receivedAt: "2026-05-14T10:00:00.000Z",
	...overrides,
});

/**
 * Helper for tests that don't care about the cap path. The narrower
 * `subscribe` return type — `(() => void) | null` — is correct in
 * production but adds null-handling noise to every test that just wants
 * a working subscription. `subscribeOrThrow` keeps the cap path
 * exercised by its dedicated test only.
 */
function subscribeOrThrow(userId: string, listener: (msg: QuiEventBusMessage) => void): () => void {
	const unsub = quiEventBus.subscribe(userId, listener);
	if (!unsub) throw new Error("unexpected listener cap hit in test");
	return unsub;
}

afterEach(() => {
	quiEventBus.clearForTests();
});

describe("QuiEventBus", () => {
	it("delivers a published message to a matching subscriber", () => {
		const listener = vi.fn();
		quiEventBus.subscribe("user-a", listener);
		const msg = sampleMsg();
		quiEventBus.publish("user-a", msg);
		expect(listener).toHaveBeenCalledOnce();
		expect(listener).toHaveBeenCalledWith(msg);
	});

	it("isolates subscribers per user (publish to A never reaches B)", () => {
		const aListener = vi.fn();
		const bListener = vi.fn();
		quiEventBus.subscribe("user-a", aListener);
		quiEventBus.subscribe("user-b", bListener);
		quiEventBus.publish("user-a", sampleMsg());
		expect(aListener).toHaveBeenCalledOnce();
		// Cross-tenant isolation is the whole point of keying by userId.
		// A cross-talk regression would surface other users' torrent state
		// changes via SSE — a serious privacy leak.
		expect(bListener).not.toHaveBeenCalled();
	});

	it("supports multiple subscribers for the same user (multi-tab)", () => {
		const tabOne = vi.fn();
		const tabTwo = vi.fn();
		quiEventBus.subscribe("user-a", tabOne);
		quiEventBus.subscribe("user-a", tabTwo);
		quiEventBus.publish("user-a", sampleMsg());
		expect(tabOne).toHaveBeenCalledOnce();
		expect(tabTwo).toHaveBeenCalledOnce();
	});

	it("returns an unsubscribe function that removes the listener", () => {
		const listener = vi.fn();
		const unsub = subscribeOrThrow("user-a", listener);
		expect(quiEventBus.listenerCountForTests("user-a")).toBe(1);
		unsub();
		expect(quiEventBus.listenerCountForTests("user-a")).toBe(0);
		quiEventBus.publish("user-a", sampleMsg());
		expect(listener).not.toHaveBeenCalled();
	});

	it("allows a listener to unsubscribe itself mid-publish without skipping siblings", () => {
		const survivor = vi.fn();
		let selfUnsub: (() => void) | undefined;
		const selfDetacher = vi.fn(() => {
			selfUnsub?.();
		});
		selfUnsub = subscribeOrThrow("user-a", selfDetacher);
		subscribeOrThrow("user-a", survivor);
		// The bus snapshots the set before iterating — without that, mutating
		// the underlying Set inside the loop would skip `survivor` on some JS
		// engines (the iterator state is implementation-defined when the
		// underlying Set is mutated mid-iteration).
		quiEventBus.publish("user-a", sampleMsg());
		expect(selfDetacher).toHaveBeenCalledOnce();
		expect(survivor).toHaveBeenCalledOnce();
	});

	it("isolates listener errors — one throw does not block siblings", () => {
		const thrower = vi.fn(() => {
			throw new Error("intentional");
		});
		const calm = vi.fn();
		quiEventBus.subscribe("user-a", thrower);
		quiEventBus.subscribe("user-a", calm);
		expect(() => quiEventBus.publish("user-a", sampleMsg())).not.toThrow();
		expect(thrower).toHaveBeenCalledOnce();
		// `calm` MUST still get the message — a misbehaving subscriber
		// must not drop events for the rest of the room.
		expect(calm).toHaveBeenCalledOnce();
	});

	it("publish with no listeners is a no-op (never throws)", () => {
		expect(() => quiEventBus.publish("nobody", sampleMsg())).not.toThrow();
	});

	it("prunes the per-user listener set when it empties out", () => {
		const unsubOne = subscribeOrThrow("user-a", vi.fn());
		const unsubTwo = subscribeOrThrow("user-a", vi.fn());
		expect(quiEventBus.listenerCountForTests("user-a")).toBe(2);
		unsubOne();
		expect(quiEventBus.listenerCountForTests("user-a")).toBe(1);
		unsubTwo();
		// Empty users get cleaned out of the parent Map so it doesn't grow
		// unbounded as connections come and go.
		expect(quiEventBus.listenerCountForTests("user-a")).toBe(0);
	});

	it("enforces the per-user listener cap and returns null at the limit", () => {
		// Fill the per-user slot count, then assert the next subscription
		// is rejected. The earlier subscriptions stay alive; the rejection
		// is silent at the API level (returns null) but the caller (SSE
		// route) interprets that as "send the client a polite end-of-stream".
		const unsubs: Array<() => void> = [];
		for (let i = 0; i < MAX_LISTENERS_PER_USER; i++) {
			const unsub = quiEventBus.subscribe("user-a", vi.fn());
			expect(unsub).not.toBeNull();
			if (unsub) unsubs.push(unsub);
		}
		expect(quiEventBus.listenerCountForTests("user-a")).toBe(MAX_LISTENERS_PER_USER);
		const rejected = quiEventBus.subscribe("user-a", vi.fn());
		expect(rejected).toBeNull();
		// The rejected listener must NOT count toward the per-user tally.
		// (Pre-fix versions silently added the listener over the cap.)
		expect(quiEventBus.listenerCountForTests("user-a")).toBe(MAX_LISTENERS_PER_USER);
		// Releasing one slot allows a new subscription.
		unsubs[0]!();
		const allowed = quiEventBus.subscribe("user-a", vi.fn());
		expect(allowed).not.toBeNull();
	});

	it("routes listener errors through the provided pino logger when supplied", () => {
		const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as {
			warn: ReturnType<typeof vi.fn>;
		};
		subscribeOrThrow("user-a", () => {
			throw new Error("listener boom");
		});
		quiEventBus.publish("user-a", sampleMsg(), log as never);
		// Pino-shaped warn call — error key on object, message as the
		// second argument — proves we routed through the logger and not
		// the console fallback.
		expect(log.warn).toHaveBeenCalledOnce();
		const [ctx, msg] = log.warn.mock.calls[0]!;
		expect(ctx).toMatchObject({ userId: "user-a" });
		expect(msg).toMatch(/listener threw/i);
	});
});
