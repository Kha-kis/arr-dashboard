/**
 * Public qui webhook receiver (Phase 5.1).
 *
 * Registered at `/api/webhooks/qui` (no auth prefix — public route).
 * qui POSTs here when an event matching the user's NotificationTarget
 * fires. We authenticate via a per-user `?secret=` query param (matches
 * qui's `ApiKeyQuery` scheme; qui doesn't send a body HMAC) and log the
 * event verbatim into `QuiEventLog` for the My Events surface + SSE
 * fan-out in Phase 5.2.
 *
 * Failure posture:
 *   - Missing/invalid secret → 401, no log row (someone is probing).
 *   - Body fails envelope validation → 400, no log row (probably a misroute).
 *   - DB insert fails → 500, but we still return 200 to qui so it doesn't
 *     retry forever; the error is logged on our side. (Defensive: a DB
 *     hiccup shouldn't put a qui-side notification retry loop on us.)
 *
 * SSE broadcast happens in Phase 5.2; this route just records the event.
 */

import { quiWebhookEnvelopeSchema } from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import { logQuiActivity } from "../lib/qui/activity-log.js";
import { quiEventBus } from "../lib/qui/event-bus.js";
import { resolveUserFromQuiSecret } from "../lib/qui/webhook-secret.js";
import { getErrorMessage } from "../lib/utils/error-message.js";

const quiWebhookRoute: FastifyPluginCallback = (app, _opts, done) => {
	app.post<{ Querystring: { secret?: string } }>(
		"/webhooks/qui",
		{
			// Conservative bounds for an inbound notification body. qui's
			// notification payloads are small JSON envelopes; 64 KiB is
			// generous. The global Fastify default is 1 MiB which would
			// let an attacker (or misbehaving qui) bloat `QuiEventLog.payload`
			// indefinitely.
			bodyLimit: 65_536,
			// Per-route rate limit. This route is public (no session cookie
			// guards it), so a hostile prober can hit it from the internet.
			// Brute-forcing a 256-bit base64url secret is infeasible regardless;
			// the cap is here to prevent log pollution + DB-lookup amplification.
			config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
		},
		async (request, reply) => {
			const secret = request.query?.secret;
			const user = await resolveUserFromQuiSecret(app.prisma, secret);
			if (!user) {
				return reply.status(401).send({ error: "Invalid or missing secret" });
			}

			// Validate the envelope shape but don't reject on unknown keys — qui
			// extends NotificationEvent without our schema needing a bump. The
			// envelope schema uses `z.unknown()` for `payload` so anything
			// well-formed at the outer layer is accepted.
			const parsed = quiWebhookEnvelopeSchema.safeParse(request.body);
			if (!parsed.success) {
				return reply.status(400).send({ error: "Malformed event envelope" });
			}
			const envelope = parsed.data;

			// Extract a torrent hash if the payload looks like a per-torrent event.
			// Multiple shapes are tolerated because qui's event payloads aren't
			// uniformly documented; storing the raw payload means we can re-mine
			// the hash later if extraction logic improves.
			const torrentHash = extractTorrentHash(envelope.payload);

			try {
				const row = await app.prisma.quiEventLog.create({
					data: {
						userId: user.id,
						eventType: envelope.type,
						torrentHash,
						payload: JSON.stringify(envelope),
					},
				});
				// Phase 5.2 — fan the event out to any open SSE connections for
				// this user. Failures here are non-fatal: the event is already
				// persisted; SSE is just a freshness optimization. Pass
				// request.log so listener-side errors are correlated with the
				// originating webhook in structured logs (default is a
				// console-only fallback, which is fine but loses request id).
				try {
					quiEventBus.publish(
						user.id,
						{
							id: row.id,
							type: envelope.type,
							torrentHash,
							receivedAt: row.receivedAt.toISOString(),
						},
						request.log,
					);
				} catch (busErr) {
					request.log.warn({ err: busErr }, "qui event bus publish failed");
				}
				return reply.status(200).send({ ok: true, eventId: row.id });
			} catch (err) {
				// Log + return 200 to suppress qui-side retry storms.
				// Upgraded from warn → error: this is a real loss of operator
				// data they may want alert on. Pino's warn level often skips
				// the alerting filter that triggers on error+.
				request.log.error(
					{ err, userId: user.id, eventType: envelope.type },
					"qui event log insert failed; acknowledging anyway to suppress qui retries",
				);
				// Best-effort second-channel visibility — if QuiEventLog itself
				// is broken (schema drift, disk full), record the drop on the
				// activity-log table so the My Events tab's "no events yet"
				// message distinguishes "qui never fired" from "we dropped it".
				// `logQuiActivity` swallows its own write failures, so this
				// can't re-raise into the response path.
				await logQuiActivity({
					app,
					userId: user.id,
					eventType: "qui_webhook_dropped",
					details: { eventType: envelope.type, reason: getErrorMessage(err) },
					severity: "error",
					log: request.log,
				});
				return reply.status(200).send({ ok: true, eventId: null });
			}
		},
	);
	done();
};

function extractTorrentHash(payload: unknown): string | null {
	if (!payload || typeof payload !== "object") return null;
	const p = payload as Record<string, unknown>;
	// Try common qui payload shapes (covers single-torrent events and the
	// torrents array used in bulk events).
	if (typeof p.hash === "string") return p.hash;
	if (typeof p.infoHash === "string") return p.infoHash;
	if (p.torrent && typeof p.torrent === "object") {
		const t = p.torrent as Record<string, unknown>;
		if (typeof t.hash === "string") return t.hash;
	}
	if (Array.isArray(p.torrents) && p.torrents.length === 1) {
		const t = p.torrents[0] as Record<string, unknown> | undefined;
		if (t && typeof t.hash === "string") return t.hash;
	}
	return null;
}

export const registerQuiWebhookRoutes = quiWebhookRoute;
