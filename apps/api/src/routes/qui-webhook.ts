/**
 * Public qui webhook receiver (Phase 5.1).
 *
 * Registered at `/api/webhooks/qui` (no auth prefix — public route).
 * qui POSTs here through its Shoutrrr generic notification target when a
 * configured event fires. We authenticate via a per-user `?secret=` query
 * param and normalize Shoutrrr's `{ title, message }` body into our event
 * envelope for the My Events surface + SSE fan-out in Phase 5.2.
 *
 * Failure posture:
 *   - Missing/invalid secret → 401, no log row (someone is probing).
 *   - Body fails envelope validation → 400, no log row (probably a misroute).
 *   - DB insert fails → 503 for recognized transient storage failures,
 *     500 otherwise. Only saved events receive a success acknowledgment.
 *
 * SSE failures after saving are nonfatal. Sender retries are not guaranteed,
 * and an acknowledgment lost after saving can still result in duplicate events.
 */

import { quiWebhookEnvelopeSchema } from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { logQuiActivity } from "../lib/qui/activity-log.js";
import { quiEventBus } from "../lib/qui/event-bus.js";
import { resolveUserFromQuiSecret } from "../lib/qui/webhook-secret.js";
import { buildQuiDeploymentId, buildQuiNotificationTargetOwnerId } from "./qui/webhook-routes.js";

const quiShoutrrrNotificationSchema = z
	.object({
		title: z.string().min(1),
		message: z.string(),
	})
	.passthrough();

/**
 * qUI v1.23 notification titles are human-readable while its target API stores
 * machine event keys. Preserve the keys operators see in qUI's event selector.
 * Unknown/custom titles still land as `notification` instead of being rejected,
 * which keeps the receiver forward-compatible with new qUI event definitions.
 */
const QUI_NOTIFICATION_EVENT_TYPES: Readonly<Record<string, string>> = {
	"Torrent added": "torrent_added",
	"Torrent completed": "torrent_completed",
	"Backup completed": "backup_succeeded",
	"Backup failed": "backup_failed",
	"Directory scan completed": "dir_scan_completed",
	"Directory scan failed": "dir_scan_failed",
	"Orphan scan completed": "orphan_scan_completed",
	"Orphan scan failed": "orphan_scan_failed",
	"Cross-seed RSS automation completed": "cross_seed_automation_succeeded",
	"Cross-seed RSS automation failed": "cross_seed_automation_failed",
	"Cross-seed seeded search completed": "cross_seed_search_succeeded",
	"Cross-seed seeded search failed": "cross_seed_search_failed",
	"Cross-seed completion search completed": "cross_seed_completion_succeeded",
	"Cross-seed completion search failed": "cross_seed_completion_failed",
	"Cross-seed webhook check completed": "cross_seed_webhook_succeeded",
	"Cross-seed webhook check failed": "cross_seed_webhook_failed",
	"Automations actions applied": "automations_actions_applied",
	"Automations run failed": "automations_run_failed",
};

function isForeignKeyConstraintError(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		(error as Error & { code?: unknown }).code === "P2003"
	);
}

/** Inspect only fixed data fields; never classify from private error text. */
function isTransientPersistenceError(error: unknown): boolean {
	const ownData = (value: unknown, key: string): unknown => {
		if (typeof value !== "object" || value === null) return undefined;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return descriptor && "value" in descriptor ? descriptor.value : undefined;
	};
	try {
		const code = ownData(error, "code") ?? ownData(error, "errorCode");
		const isStorageConflict = (value: unknown): boolean =>
			value === "SQLITE_BUSY" ||
			value === "SQLITE_BUSY_TIMEOUT" ||
			value === "SQLITE_BUSY_SNAPSHOT" ||
			value === "SQLITE_LOCKED" ||
			value === "40001" ||
			value === "40P01";
		if (
			code === "P1001" ||
			code === "P1002" ||
			code === "P1008" ||
			code === "P1017" ||
			code === "P2024" ||
			code === "P2034" ||
			isStorageConflict(code)
		)
			return true;
		// Prisma's adapter may wrap a native conflict as a raw-query failure.
		// An arbitrary P2010 or transaction error is not evidence of transience.
		return (
			code === "P2010" &&
			isStorageConflict(
				ownData(
					ownData(ownData(ownData(error, "meta"), "driverAdapterError"), "cause"),
					"originalCode",
				),
			)
		);
	} catch {
		return false;
	}
}

const quiWebhookRoute: FastifyPluginCallback = (app, _opts, done) => {
	app.post<{
		Querystring: {
			secret?: string;
			instanceId?: string;
			deploymentId?: string;
			owner?: string;
		};
	}>(
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

			const instanceId = request.query?.instanceId;
			const deploymentId = request.query?.deploymentId;
			const owner = request.query?.owner;
			const sourceInstance = instanceId
				? await app.prisma.serviceInstance.findFirst({
						where: { id: instanceId, userId: user.id, service: "QUI" },
						select: { id: true, baseUrl: true },
					})
				: null;
			const hasValidSource =
				app.installationIdIsPersistent &&
				sourceInstance &&
				deploymentId &&
				owner &&
				buildQuiDeploymentId(user.id, sourceInstance.baseUrl) === deploymentId &&
				buildQuiNotificationTargetOwnerId(app.installationId, user.id, sourceInstance.id) === owner;
			if ((instanceId || deploymentId || owner) && !hasValidSource) {
				return reply.status(401).send({ error: "Invalid webhook source" });
			}

			const envelope = normalizeQuiWebhookBody(request.body);
			if (!envelope) {
				return reply.status(400).send({ error: "Malformed event envelope" });
			}

			// Extract a torrent hash if the payload looks like a per-torrent event.
			// Multiple shapes are tolerated because qui's event payloads aren't
			// uniformly documented; storing the raw payload means we can re-mine
			// the hash later if extraction logic improves.
			const torrentHash = extractTorrentHash(envelope.payload);
			// Secondary activity/SSE helpers may log their own errors. Keep those
			// request-correlated diagnostics free of raw errors and inbound types.
			const diagnosticLog = request.log.child(
				{},
				{
					serializers: {
						err: () => ({ message: "qUI webhook operation failed" }),
						msgType: () => undefined,
					},
				},
			);

			try {
				const eventData = {
					userId: user.id,
					serviceInstanceId: sourceInstance?.id ?? null,
					eventType: envelope.type,
					torrentHash,
					payload: JSON.stringify(envelope),
				};
				const row = await (async () => {
					try {
						return await app.prisma.quiEventLog.create({ data: eventData });
					} catch (err) {
						if (!sourceInstance || !isForeignKeyConstraintError(err)) {
							throw err;
						}
						// The source row can disappear after attribution but before
						// this insert. Correlation is best-effort, so preserve the
						// authenticated event without the now-stale foreign key.
						request.log.warn(
							{ instanceId: sourceInstance.id },
							"qUI source instance disappeared during webhook persistence; retrying uncorrelated",
						);
						return await app.prisma.quiEventLog.create({
							data: { ...eventData, serviceInstanceId: null },
						});
					}
				})();
				// Phase 5.2 — fan the event out to any open SSE connections for
				// this user. Failures here are non-fatal: the event is already
				// persisted; SSE is just a freshness optimization. Pass
				// the sanitized request logger so listener-side errors correlate with the
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
						diagnosticLog,
					);
				} catch (busErr) {
					diagnosticLog.warn({ err: busErr }, "qui event bus publish failed");
				}
				return reply.status(200).send({ ok: true, eventId: row.id });
			} catch (err) {
				const unavailable = isTransientPersistenceError(err);
				const reason = unavailable ? "storage-unavailable" : "storage-failure";
				request.log.error(
					{ userId: user.id, reason },
					"qui event log insert failed; event not acknowledged",
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
					details: { reason },
					severity: "error",
					log: diagnosticLog,
				});
				return reply.status(unavailable ? 503 : 500).send({
					error: unavailable ? "Event persistence unavailable" : "Event persistence failed",
				});
			}
		},
	);
	done();
};

function normalizeQuiWebhookBody(
	body: unknown,
): { type: string; payload?: unknown; timestamp?: string } | null {
	// Retain compatibility with the original/raw envelope contract in case an
	// upstream integration already posts it directly.
	const envelope = quiWebhookEnvelopeSchema.safeParse(body);
	if (envelope.success) {
		return envelope.data;
	}

	// qUI's notification service formats events for Shoutrrr and the generic
	// JSON template delivers this exact shape. Keep the original body as the
	// payload so My Events shows what qUI actually sent.
	const notification = quiShoutrrrNotificationSchema.safeParse(body);
	if (!notification.success) {
		return null;
	}
	const { title, message } = notification.data;
	return {
		type: QUI_NOTIFICATION_EVENT_TYPES[title.trim()] ?? "notification",
		payload: { title, message },
	};
}

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
