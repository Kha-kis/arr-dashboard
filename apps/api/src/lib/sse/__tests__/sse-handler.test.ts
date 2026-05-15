/**
 * Unit tests for the generic SSE handler.
 *
 * Pin the socket-teardown contract so a future consumer (auto-tag
 * webhook events, Pulse push) that reuses this module can't
 * accidentally re-introduce the failure modes the qui consumer
 * already discovered:
 *
 *   1. Heartbeat must NOT keep firing after the socket half-closes
 *      (write() returns false silently rather than throwing).
 *   2. Cleanup must run exactly once even when both `close` and
 *      `error` fire on the same socket reset.
 *   3. Subscribe-refused (bus cap) must end the stream cleanly with
 *      a `stream-rejected` event, not hold the connection open.
 *   4. Headers + primer flush eagerly so proxy buffering doesn't
 *      delay the operator's "channel open" signal.
 */

import { EventEmitter } from "node:events";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSseHandler } from "../sse-handler.js";

// Minimal HTTP-like socket stub that emits the relevant events and
// tracks writes. Fastify's reply.raw is an http.ServerResponse; for
// these tests we only need writeHead/setHeader/write/end + EventEmitter
// semantics + the writableEnded/destroyed flags the handler reads.
function makeRawSocket() {
	const emitter = new EventEmitter();
	const writes: string[] = [];
	const headers: Record<string, string | number | readonly string[]> = {};
	let writableEnded = false;
	let destroyed = false;

	const raw = Object.assign(emitter, {
		setHeader: (name: string, value: string | number | readonly string[]) => {
			headers[name] = value;
		},
		writeHead: vi.fn(),
		write: vi.fn((chunk: string) => {
			if (writableEnded || destroyed) return false;
			writes.push(chunk);
			return true;
		}),
		end: vi.fn(() => {
			writableEnded = true;
			emitter.emit("close");
		}),
		get writableEnded() {
			return writableEnded;
		},
		get destroyed() {
			return destroyed;
		},
		__simulateHalfClose: () => {
			writableEnded = true;
		},
		__simulateDestroy: () => {
			destroyed = true;
			emitter.emit("error", new Error("ECONNRESET"));
			emitter.emit("close");
		},
		__writes: writes,
		__headers: headers,
	});

	return raw;
}

function makeRequestReply() {
	const requestRaw = makeRawSocket();
	const replyRaw = makeRawSocket();
	const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };

	const request = {
		raw: requestRaw,
		log,
	} as unknown as FastifyRequest;
	const reply = {
		raw: replyRaw,
	} as unknown as FastifyReply;
	return { request, reply, requestRaw, replyRaw, log };
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("createSseHandler", () => {
	it("flushes SSE headers + primer eagerly", () => {
		const { request, reply, replyRaw } = makeRequestReply();
		createSseHandler({
			request,
			reply,
			channel: "test",
			primer: ": opening\n\n",
			subscribe: () => () => {},
		});
		expect(replyRaw.__headers["Content-Type"]).toBe("text/event-stream");
		expect(replyRaw.__headers["Cache-Control"]).toBe("no-cache, no-transform");
		// X-Accel-Buffering: no — disables nginx response buffering so
		// each event flushes immediately. Operators behind reverse proxies
		// will silently degrade to polling-only freshness without this.
		expect(replyRaw.__headers["X-Accel-Buffering"]).toBe("no");
		expect(replyRaw.__writes).toContain(": opening\n\n");
	});

	it("delivers subscribed messages as SSE frames with the configured event name", () => {
		const { request, reply, replyRaw } = makeRequestReply();
		let publish!: (msg: { id: string }) => void;
		createSseHandler({
			request,
			reply,
			channel: "test",
			eventName: "custom-event",
			subscribe: (listener) => {
				publish = listener;
				return () => {};
			},
		});
		publish({ id: "abc" });
		// Default serializer formats as `event: <name>\ndata: <json>\n\n`.
		const frame = replyRaw.__writes.find((w) => w.includes("custom-event"));
		expect(frame).toBe('event: custom-event\ndata: {"id":"abc"}\n\n');
	});

	it("ends the stream with `stream-rejected` when subscribe returns null (cap hit)", () => {
		const { request, reply, replyRaw } = makeRequestReply();
		const subscribe = vi.fn(() => null);
		createSseHandler({ request, reply, channel: "test", subscribe });
		expect(replyRaw.__writes.some((w) => w.includes("stream-rejected"))).toBe(true);
		// `end()` must run so EventSource sees a clean end-of-stream and
		// doesn't retry against the same URL until the user closes a tab.
		expect(replyRaw.end).toHaveBeenCalled();
	});

	it("stops heartbeats after the request socket closes", () => {
		const { request, reply, replyRaw, requestRaw } = makeRequestReply();
		createSseHandler({
			request,
			reply,
			channel: "test",
			heartbeatMs: 1_000,
			subscribe: () => () => {},
		});
		// One tick should fire a heartbeat.
		vi.advanceTimersByTime(1_000);
		const beforeClose = replyRaw.__writes.filter((w) => w.includes("heartbeat")).length;
		expect(beforeClose).toBeGreaterThan(0);

		// Simulate client disconnect. The handler must clear the timer.
		requestRaw.emit("close");

		// Advance another second — no further heartbeats should land.
		vi.advanceTimersByTime(1_000);
		const afterClose = replyRaw.__writes.filter((w) => w.includes("heartbeat")).length;
		expect(afterClose).toBe(beforeClose);
	});

	it("is idempotent — close + error on the same reset only cleans up once", () => {
		const { request, reply, requestRaw } = makeRequestReply();
		const unsubscribe = vi.fn();
		createSseHandler({
			request,
			reply,
			channel: "test",
			subscribe: () => unsubscribe,
		});
		// Simulate a socket reset that fires BOTH events in quick succession.
		// Node's contract is that `error` always precedes `close` on a real
		// reset, but a misbehaving proxy can emit them out of order. We must
		// handle either ordering without double-running unsubscribe.
		requestRaw.emit("error", new Error("ECONNRESET"));
		requestRaw.emit("close");
		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it("doesn't keep firing heartbeats into a half-closed socket", () => {
		const { request, reply, replyRaw } = makeRequestReply();
		const unsubscribe = vi.fn();
		createSseHandler({
			request,
			reply,
			channel: "test",
			heartbeatMs: 1_000,
			subscribe: () => unsubscribe,
		});

		// Half-close — `writableEnded` is true but the `close` event hasn't
		// fired yet (browser sent FIN, our handlers haven't processed). The
		// pre-fix bug was that write() silently returned false, the heartbeat
		// catch was empty, and the interval kept firing forever waiting
		// for the deferred `close` to land.
		replyRaw.__simulateHalfClose();
		vi.advanceTimersByTime(5_000);

		// Heartbeat callback should have detected `writableEnded` on its
		// FIRST tick post-close and triggered cleanup. unsubscribe runs
		// exactly once.
		expect(unsubscribe).toHaveBeenCalledOnce();
	});
});
