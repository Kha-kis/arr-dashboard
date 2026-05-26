/**
 * Generic server-sent-events handler.
 *
 * Originally inlined in `routes/qui.ts` for the qui webhook → SSE
 * push channel (Phase 5.2). Extracted here so additional push channels
 * (auto-tag webhook events, Pulse alerts, future scheduler emitters)
 * don't copy-paste the headers / heartbeat / cleanup pattern — three
 * different copies of "did we wire the cleanup to BOTH close and error
 * AND reply.raw.close" is exactly the kind of drift that produces silent
 * socket / timer leaks under production load.
 *
 * Design points (DON'T relitigate without operator signoff):
 *
 * 1. **Guarded write semantics**: Node's `http.ServerResponse#write`
 *    returns `false` and emits a deferred `'error'` rather than throwing
 *    when the peer has half-closed. We must detect that synchronously
 *    or the heartbeat keeps firing into a black hole waiting for the
 *    deferred `'close'` event. `safeWrite` short-circuits via
 *    `writableEnded`/`destroyed` and triggers cleanup on any failure.
 *
 * 2. **Idempotent cleanup**: every teardown path (request close, request
 *    error, reply close, reply error) funnels into the same `cleanup`
 *    function, guarded by a `cleanedUp` flag so multiple inbound events
 *    on the same socket reset don't trigger duplicate work.
 *
 * 3. **`unref()` on the heartbeat timer**: graceful shutdown completes
 *    even while a long-lived stream is open. Without unref, `setInterval`
 *    keeps the event loop alive past `process.exit()`.
 *
 * 4. **Listener cap is the bus's responsibility, not ours**: callers
 *    pass a `subscribe()` returning `() => void | null`. A null return
 *    means "the bus refused; tell the client we hit the cap and close
 *    cleanly." See `lib/qui/event-bus.ts` for the cap implementation.
 *
 * 5. **Header set BEFORE writeHead**: setting headers after `writeHead`
 *    throws. The qui consumer also writes a primer (`": stream open\n\n"`)
 *    so the headers are flushed eagerly — without that, some proxies
 *    buffer until the first 0.5 KiB of body, delaying the operator's
 *    "channel open" signal.
 */

import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from "fastify";

/**
 * Subscribe function — returns an unsubscribe callback on success, or
 * `null` when the underlying bus has hit a per-user cap. Mirrors the
 * shape of `quiEventBus.subscribe()`.
 */
export type SseSubscribe<TMessage> = (
	listener: (msg: TMessage) => void,
	log?: FastifyBaseLogger,
) => (() => void) | null;

/**
 * Serializer turning an in-process message into the SSE wire frame.
 * Defaults to `event: ${eventName}\ndata: ${JSON.stringify(msg)}\n\n`,
 * which is the shape EventSource expects. Override only when a channel
 * has non-trivial framing requirements (binary, alternate event types).
 */
export type SseSerialize<TMessage> = (msg: TMessage) => string;

export interface CreateSseHandlerArgs<TMessage> {
	request: FastifyRequest;
	reply: FastifyReply;
	/** Subscribe-or-reject. Caller's bus handles the cap. */
	subscribe: SseSubscribe<TMessage>;
	/** SSE event name (default `"message"`). EventSource clients
	 * listen via `source.addEventListener("<eventName>", ...)`. */
	eventName?: string;
	/** Wire-frame serializer; defaults to `event: <name>\ndata: <json>\n\n`. */
	serialize?: SseSerialize<TMessage>;
	/** Heartbeat interval in ms (default 25 s). Lower than typical
	 * proxy idle timeouts (Nginx default 60 s, Cloudflare 100 s) so
	 * the connection stays warm without operator config. */
	heartbeatMs?: number;
	/** Optional opening comment that flushes headers eagerly. */
	primer?: string;
	/** Per-channel name for logs — surfaces in pino events. */
	channel: string;
}

/**
 * Mount an SSE stream on the given Fastify reply.
 *
 * Returns `reply` (Fastify-idiomatic so the route handler can `return`
 * directly) — the connection stays open after the route handler resolves
 * because Fastify checks `reply.sent`, which we never set.
 */
export function createSseHandler<TMessage>(args: CreateSseHandlerArgs<TMessage>): FastifyReply {
	const {
		request,
		reply,
		subscribe,
		eventName = "message",
		serialize = (msg: TMessage) => `event: ${eventName}\ndata: ${JSON.stringify(msg)}\n\n`,
		heartbeatMs = 25_000,
		primer,
		channel,
	} = args;

	reply.raw.setHeader("Content-Type", "text/event-stream");
	reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
	reply.raw.setHeader("Connection", "keep-alive");
	// nginx hint — disable response buffering so events flush immediately.
	reply.raw.setHeader("X-Accel-Buffering", "no");
	reply.raw.writeHead(200);

	let cleanedUp = false;
	let heartbeatTimer: NodeJS.Timeout | null = null;
	let unsubscribe: (() => void) | null = null;

	const cleanup = () => {
		if (cleanedUp) return;
		cleanedUp = true;
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		heartbeatTimer = null;
		unsubscribe?.();
		unsubscribe = null;
	};

	const safeWrite = (chunk: string): boolean => {
		if (cleanedUp) return false;
		if (reply.raw.writableEnded || reply.raw.destroyed) {
			cleanup();
			return false;
		}
		try {
			return reply.raw.write(chunk);
		} catch (err) {
			request.log.warn({ err, channel }, "SSE write threw — tearing down stream");
			cleanup();
			return false;
		}
	};

	if (primer) safeWrite(primer);

	heartbeatTimer = setInterval(() => {
		if (!safeWrite(": heartbeat\n\n")) cleanup();
	}, heartbeatMs);
	heartbeatTimer.unref?.();

	const maybeUnsub = subscribe((msg) => {
		if (!safeWrite(serialize(msg))) cleanup();
	}, request.log);

	if (!maybeUnsub) {
		// Bus refused the subscription (per-user cap). Tell the client
		// we hit the limit and close cleanly — EventSource sees the
		// end-of-stream + won't retry until the user closes another tab.
		safeWrite(`event: stream-rejected\ndata: too-many-streams\n\n`);
		reply.raw.end();
		return reply;
	}
	unsubscribe = maybeUnsub;

	// Bind cleanup to every teardown path. `close` fires on normal client
	// disconnect; `error` fires on socket-level errors; the `reply.raw`
	// side covers proxy timeouts that close the response without touching
	// the underlying request socket.
	request.raw.on("close", cleanup);
	request.raw.on("error", cleanup);
	reply.raw.on("close", cleanup);
	reply.raw.on("error", cleanup);

	return reply;
}
