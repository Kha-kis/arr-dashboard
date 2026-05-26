import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createQuiClient } from "../../lib/qui/client-factory.js";
import { quiEventBus } from "../../lib/qui/event-bus.js";
import { requireQuiInstance } from "../../lib/qui/instance-helpers.js";
import { generateQuiWebhookSecret } from "../../lib/qui/webhook-secret.js";
import { createSseHandler } from "../../lib/sse/sse-handler.js";
import { getErrorMessage } from "../../lib/utils/error-message.js";
import { validateRequest } from "../../lib/utils/validate.js";
import { QUI_INSTANCE_PARAM, safeParseJson } from "./qui-shared.js";

export function registerWebhookRoutes(app: FastifyInstance): void {
	// ────────────────────────────────────────────────────────────────────
	// Phase 5.1 — webhook config (GET + rotate + register-in-qui)
	// ────────────────────────────────────────────────────────────────────

	/**
	 * Resolve the public-facing URL used by the operator to wire qui's
	 * NotificationTarget back to this dashboard. Mirrors the resolution
	 * order used by `plugins/notification-service.ts` so the same value
	 * an operator sees in notification links is what qui will fire on.
	 *
	 * Preference order:
	 *   1. `SystemSettings.externalUrl` — admin-configured override,
	 *      typically set when the dashboard sits behind a reverse proxy.
	 *   2. `app.config.APP_URL` — validated env var (default localhost:3000).
	 */
	async function resolvePublicBaseUrl(): Promise<string> {
		const settings = await app.prisma.systemSettings.findUnique({ where: { id: 1 } });
		return settings?.externalUrl?.replace(/\/$/, "") ?? app.config.APP_URL;
	}

	app.get("/qui/webhook-config", async (request, reply) => {
		const userId = request.currentUser!.id;
		const user = await app.prisma.user.findUniqueOrThrow({
			where: { id: userId },
			select: { hashedQuiWebhookSecret: true },
		});
		const baseUrl = await resolvePublicBaseUrl();
		return reply.send({
			hasSecret: Boolean(user.hashedQuiWebhookSecret),
			// Public URL the operator pastes into qui's notification target.
			// The query-param placeholder is intentional — the actual secret
			// is only returned at rotation time; the operator copies the URL
			// + secret together on the rotate response.
			webhookUrl: `${baseUrl}/api/webhooks/qui`,
		});
	});

	app.post("/qui/webhook-config/rotate", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { plaintextSecret, hashedSecret } = generateQuiWebhookSecret();
		await app.prisma.user.update({
			where: { id: userId },
			data: { hashedQuiWebhookSecret: hashedSecret },
		});
		const baseUrl = await resolvePublicBaseUrl();
		return reply.send({
			hasSecret: true,
			webhookUrl: `${baseUrl}/api/webhooks/qui`,
			// Plaintext returned only here — never stored, never re-displayed.
			// Operators copy it into qui's notification-target URL once.
			secret: plaintextSecret,
		});
	});

	// `secret` is part of the validated body schema so we never reach for
	// `request.body as Record<string, unknown>` (a previous shape leaked
	// the unvalidated path through a bypass cast — see CLAUDE.md rule 5).
	const REGISTER_BODY = z.object({
		secret: z.string().min(16, "secret must be at least 16 characters"),
		eventTypes: z.array(z.string()).optional(),
	});

	app.post<{ Params: { id: string }; Body: unknown }>(
		"/qui/instances/:id/webhook-config/register",
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const { id } = validateRequest(QUI_INSTANCE_PARAM, request.params);
			const body = validateRequest(REGISTER_BODY, request.body ?? {});
			const instance = await requireQuiInstance(app, userId, id);
			const client = createQuiClient(app, instance);

			// Operator must rotate the secret first — we don't auto-create
			// a secret as a side effect of registration, because that would
			// silently reset any existing wired-up qui targets that depend
			// on the prior secret.
			const user = await app.prisma.user.findUniqueOrThrow({
				where: { id: userId },
				select: { hashedQuiWebhookSecret: true },
			});
			if (!user.hashedQuiWebhookSecret) {
				return reply.status(409).send({
					error: "No webhook secret configured. Rotate to generate one first.",
				});
			}

			const baseUrl = await resolvePublicBaseUrl();
			// The plaintext is supplied per-request in the validated body; we
			// don't have it on the server. The frontend captures it from the
			// rotate response and forwards it here.
			const targetUrl = `${baseUrl}/api/webhooks/qui?secret=${encodeURIComponent(body.secret)}`;

			try {
				const created = await client.createNotificationTarget({
					name: "arr-dashboard",
					url: targetUrl,
					eventTypes: body.eventTypes,
					enabled: true,
				});
				return reply.send({ ok: true, quiTargetId: created.id });
			} catch (err) {
				request.log.warn(
					{ err, instanceId: instance.id },
					"Failed to register webhook target in qui",
				);
				// If qui's error message echoes the URL we sent (e.g., a
				// "couldn't reach <url>" 500), it would leak the plaintext
				// secret back through the response and into any client-side
				// logging. Strip `secret=...` defensively before relaying.
				const rawMessage = getErrorMessage(err, "qui registration failed");
				const safeMessage = rawMessage.replace(/secret=[^&\s"']+/g, "secret=***");
				return reply.status(502).send({
					error: "qui rejected the notification target registration",
					message: safeMessage,
				});
			}
		},
	);

	// ────────────────────────────────────────────────────────────────────
	// Phase 5.1/5.2 — event log feed + SSE stream
	// ────────────────────────────────────────────────────────────────────

	const EVENTS_QUERY = z.object({
		cursor: z.string().optional(),
		limit: z
			.string()
			.optional()
			.transform((raw) => {
				const parsed = Number.parseInt(raw ?? "50", 10);
				if (!Number.isFinite(parsed)) return 50;
				return Math.max(1, Math.min(200, parsed));
			}),
	});

	app.get<{ Querystring: { cursor?: string; limit?: string } }>(
		"/qui/events",
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const { cursor, limit } = validateRequest(EVENTS_QUERY, request.query ?? {});

			let cursorReceivedAt: Date | null = null;
			if (cursor) {
				const anchor = await app.prisma.quiEventLog.findUnique({
					where: { id: cursor },
					select: { receivedAt: true, userId: true },
				});
				// Cross-tenant defense: silently drop a cursor pointing at
				// another user's row (return latest instead). Returning 403
				// here would create an enumeration vector — 200-empty does not.
				if (anchor && anchor.userId === userId) {
					cursorReceivedAt = anchor.receivedAt;
				}
			}

			const rows = await app.prisma.quiEventLog.findMany({
				where: {
					userId,
					...(cursorReceivedAt ? { receivedAt: { lt: cursorReceivedAt } } : {}),
				},
				orderBy: { receivedAt: "desc" },
				take: limit + 1,
				// Hydrate the instance label so the My Events tab can render
				// "main qui" instead of a raw cuid. Mirrors the include block
				// on /qui/actions (action-routes.ts). serviceInstance is null
				// when the row's instance was deleted after the event landed.
				include: {
					serviceInstance: { select: { label: true } },
				},
			});
			const hasMore = rows.length > limit;
			const trimmed = hasMore ? rows.slice(0, limit) : rows;
			const nextCursor = hasMore ? (trimmed[trimmed.length - 1]?.id ?? null) : null;
			return reply.send({
				entries: trimmed.map((r) => {
					const receivedAtIso = r.receivedAt.toISOString();
					return {
						id: r.id,
						serviceInstanceId: r.serviceInstanceId,
						serviceInstanceLabel: r.serviceInstance?.label ?? null,
						eventType: r.eventType,
						torrentHash: r.torrentHash,
						payload: safeParseJson(r.payload),
						receivedAt: receivedAtIso,
						/** Canonical timestamp alias — see schema notes. */
						timestamp: receivedAtIso,
					};
				}),
				nextCursor,
			});
		},
	);

	app.get("/qui/events/stream", async (request, reply) => {
		// Phase 5.2 — server-sent events stream. Delegates the headers /
		// heartbeat / cleanup pattern to `createSseHandler` so we can't
		// drift from the (already battle-tested) socket-teardown shape.
		// This handler's responsibility is just (a) name the channel
		// "qui-event" so frontend EventSource clients listen on the right
		// event type, and (b) bind subscriptions to the per-user
		// `quiEventBus`. A second push channel (e.g., auto-tag webhook
		// events) reuses the same handler with a different bus + name.
		const userId = request.currentUser!.id;
		return createSseHandler({
			request,
			reply,
			channel: "qui-events",
			eventName: "qui-event",
			primer: ": qui SSE stream open\n\n",
			subscribe: (listener, log) => quiEventBus.subscribe(userId, listener, log),
		});
	});
}
