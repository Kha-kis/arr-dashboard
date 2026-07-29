import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createQuiClient } from "../../lib/qui/client-factory.js";
import { quiEventBus } from "../../lib/qui/event-bus.js";
import { requireQuiInstance } from "../../lib/qui/instance-helpers.js";
import { generateQuiWebhookSecret, hashSecret } from "../../lib/qui/webhook-secret.js";
import { createSseHandler } from "../../lib/sse/sse-handler.js";
import { getErrorMessage } from "../../lib/utils/error-message.js";
import { validateRequest } from "../../lib/utils/validate.js";
import { QUI_INSTANCE_PARAM, safeParseJson } from "./qui-shared.js";

export function buildQuiNotificationTargetName(
	installationId: string,
	userId: string,
	serviceInstanceId: string,
	quiBaseUrl: string,
): string {
	const ownerId = buildQuiNotificationTargetOwnerId(installationId, userId, serviceInstanceId);
	return `arr-dashboard-${ownerId}-${buildQuiDeploymentId(userId, quiBaseUrl)}`;
}

export function buildQuiDeploymentId(userId: string, quiBaseUrl: string): string {
	const deploymentUrl = new URL(quiBaseUrl);
	deploymentUrl.hash = "";
	deploymentUrl.search = "";
	deploymentUrl.pathname = deploymentUrl.pathname.replace(/\/+$/, "");
	return createHash("sha256")
		.update(`${userId}\0${deploymentUrl.toString()}`)
		.digest("hex")
		.slice(0, 24);
}

export function buildQuiNotificationTargetOwnerId(
	installationId: string,
	userId: string,
	serviceInstanceId: string,
): string {
	return createHash("sha256")
		.update(`${installationId}\0${userId}\0${serviceInstanceId}`)
		.digest("hex")
		.slice(0, 24);
}

export function registerWebhookRoutes(app: FastifyInstance): void {
	// The dashboard runs as one Node process, so a per-user in-memory queue
	// is sufficient to make secret rotation and qUI target registration one
	// critical section. Without this, an older registration can pass its
	// hash check, pause on qUI I/O, then overwrite a newer rotated secret.
	const webhookConfigTails = new Map<string, Promise<void>>();
	async function withWebhookConfigLock<T>(userId: string, operation: () => Promise<T>): Promise<T> {
		const previous = webhookConfigTails.get(userId) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.catch(() => undefined).then(() => current);
		webhookConfigTails.set(userId, tail);

		await previous.catch(() => undefined);
		try {
			return await operation();
		} finally {
			release();
			if (webhookConfigTails.get(userId) === tail) {
				webhookConfigTails.delete(userId);
			}
		}
	}

	function isLoopbackAddress(value: string): boolean {
		const normalized = value
			.trim()
			.toLowerCase()
			.replace(/^\[|\]$/g, "");
		return (
			normalized === "localhost" ||
			normalized === "::1" ||
			/^127(?:\.\d{1,3}){3}$/.test(normalized) ||
			/^::ffff:127(?:\.\d{1,3}){3}$/.test(normalized)
		);
	}

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
	async function resolvePublicBaseUrl(request: FastifyRequest): Promise<string> {
		const settings = await app.prisma.systemSettings.findUnique({ where: { id: 1 } });
		if (settings?.externalUrl) {
			return settings.externalUrl.replace(/\/$/, "");
		}

		const appUrl = app.config.APP_URL.replace(/\/$/, "");
		const appHost = new URL(appUrl).hostname;
		const appUrlIsLoopback = isLoopbackAddress(appHost);
		if (!appUrlIsLoopback) {
			return appUrl;
		}

		// Next's production rewrite changes Host to the internal API address,
		// but always preserves the browser-facing Host in X-Forwarded-Host.
		// Read that header explicitly only when the direct peer is loopback,
		// which is the trusted in-container Next -> API hop. A remote client
		// must not be able to forge this header and redirect qUI notifications
		// (including their callback credential) to an attacker-controlled host.
		const forwardedHostHeader = request.headers["x-forwarded-host"];
		const forwardedHost = Array.isArray(forwardedHostHeader)
			? forwardedHostHeader[0]
			: forwardedHostHeader?.split(",")[0]?.trim();
		const directPeerIsLoopback = isLoopbackAddress(request.raw.socket.remoteAddress ?? "");
		if (forwardedHost && directPeerIsLoopback) {
			const forwardedProtoHeader = request.headers["x-forwarded-proto"];
			const forwardedProtoValue = Array.isArray(forwardedProtoHeader)
				? forwardedProtoHeader[0]
				: forwardedProtoHeader?.split(",")[0]?.trim();
			const forwardedProto =
				forwardedProtoValue === "http" || forwardedProtoValue === "https"
					? forwardedProtoValue
					: request.protocol;
			try {
				const forwardedOrigin = new URL(`${forwardedProto}://${forwardedHost}`).origin;
				const forwardedHostname = new URL(forwardedOrigin).hostname;
				if (!isLoopbackAddress(forwardedHostname)) {
					return forwardedOrigin;
				}
			} catch {
				// Ignore malformed proxy metadata and continue to the direct
				// request origin / configured APP_URL fallbacks below.
			}
		}

		// With trustProxy enabled, request.host/protocol can also be derived
		// from forwarded headers. Do not fall through to those values for a
		// non-local peer after rejecting its forwarded host.
		if (!directPeerIsLoopback) {
			return appUrl;
		}

		// Direct development requests do not pass through Next's rewrite.
		const requestOrigin = `${request.protocol}://${request.host}`;
		const requestHost = new URL(requestOrigin).hostname;
		return isLoopbackAddress(requestHost) ? appUrl : requestOrigin;
	}

	/**
	 * qui notification targets are Shoutrrr service URLs, not ordinary HTTP
	 * callback URLs. Its generic service converts `generic://` back to HTTPS
	 * (or HTTP when `disabletls=yes`) and `template=json` makes the delivered
	 * body `{ title, message }`, which our public receiver understands.
	 *
	 * Unknown query keys are forwarded by Shoutrrr, so `secret` reaches
	 * arr-dashboard without being treated as generic-service configuration.
	 */
	function buildQuiNotificationTargetUrl(
		baseUrl: string,
		secret?: string,
		source?: { instanceId: string; deploymentId: string; ownerId: string },
	): string {
		const callback = new URL(`${baseUrl}/api/webhooks/qui`);
		const usesPlainHttp = callback.protocol === "http:";
		if (!usesPlainHttp && callback.protocol !== "https:") {
			throw new TypeError("qui webhook callback must use http or https");
		}
		// WHATWG URL objects ignore an assignment that crosses from a special
		// scheme (`http`) to a non-special one (`generic`). Build a new URL
		// from the serialized callback instead of mutating `.protocol`.
		const target = new URL(callback.toString().replace(/^https?:/, "generic:"));
		target.searchParams.set("template", "json");
		if (usesPlainHttp) {
			target.searchParams.set("disabletls", "yes");
		}
		if (secret) {
			target.searchParams.set("secret", secret);
		}
		if (source) {
			target.searchParams.set("instanceId", source.instanceId);
			target.searchParams.set("deploymentId", source.deploymentId);
			target.searchParams.set("owner", source.ownerId);
		}
		return target.toString();
	}

	app.get("/qui/webhook-config", async (request, reply) => {
		const userId = request.currentUser!.id;
		const user = await app.prisma.user.findUniqueOrThrow({
			where: { id: userId },
			select: { hashedQuiWebhookSecret: true },
		});
		const baseUrl = await resolvePublicBaseUrl(request);
		return reply.send({
			hasSecret: Boolean(user.hashedQuiWebhookSecret),
			// Public URL the operator pastes into qui's notification target.
			// The query-param placeholder is intentional — the actual secret
			// is only returned at rotation time; the operator copies the URL
			// + secret together on the rotate response.
			webhookUrl: buildQuiNotificationTargetUrl(baseUrl),
		});
	});

	app.post("/qui/webhook-config/rotate", async (request, reply) => {
		const userId = request.currentUser!.id;
		return withWebhookConfigLock(userId, async () => {
			const baseUrl = await resolvePublicBaseUrl(request);
			const webhookUrl = buildQuiNotificationTargetUrl(baseUrl);
			const { plaintextSecret, hashedSecret } = generateQuiWebhookSecret();
			await app.prisma.user.update({
				where: { id: userId },
				data: { hashedQuiWebhookSecret: hashedSecret },
			});
			return reply.send({
				hasSecret: true,
				webhookUrl,
				// Plaintext returned only here — never stored, never re-displayed.
				// Operators copy it into qui's notification-target URL once.
				secret: plaintextSecret,
			});
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
			return withWebhookConfigLock(userId, async () => {
				if (!app.installationIdIsPersistent) {
					return reply.status(503).send({
						error:
							"qUI registration requires a writable secrets path with a persistent installation identity.",
					});
				}
				const instance = await requireQuiInstance(app, userId, id);
				const client = createQuiClient(app, instance);

				// Operator must rotate the secret first — we don't auto-create
				// a secret as a side effect of registration, because that would
				// silently reset any existing wired-up qui targets that depend
				// on the prior secret. This check intentionally happens inside
				// the rotate/register critical section so a stale request cannot
				// pass validation and later overwrite the current target.
				const user = await app.prisma.user.findUniqueOrThrow({
					where: { id: userId },
					select: { hashedQuiWebhookSecret: true },
				});
				if (!user.hashedQuiWebhookSecret) {
					return reply.status(409).send({
						error: "No webhook secret configured. Rotate to generate one first.",
					});
				}
				if (hashSecret(body.secret) !== user.hashedQuiWebhookSecret) {
					return reply.status(409).send({
						error:
							"This webhook secret is stale. Rotate the secret again before registering the target.",
					});
				}

				const baseUrl = await resolvePublicBaseUrl(request);
				// The plaintext is supplied per-request in the validated body; we
				// don't have it on the server. The frontend captures it from the
				// rotate response and forwards it here.
				const ownerId = buildQuiNotificationTargetOwnerId(app.installationId, userId, instance.id);
				const deploymentId = buildQuiDeploymentId(userId, instance.baseUrl);
				const deploymentKey = buildQuiDeploymentId("", instance.baseUrl);
				const otherQuiInstances = await app.prisma.serviceInstance.findMany({
					where: {
						service: "QUI",
						id: { not: instance.id },
					},
					select: { baseUrl: true, userId: true },
				});
				let normalizationUncertain = false;
				const deploymentPeers = otherQuiInstances.filter((otherInstance) => {
					try {
						return buildQuiDeploymentId("", otherInstance.baseUrl) === deploymentKey;
					} catch {
						// Fail closed if legacy data prevents us from proving
						// that the other qUI row belongs to a different server.
						normalizationUncertain = true;
						return false;
					}
				});
				const legacyTargetAdoption =
					normalizationUncertain ||
					deploymentPeers.some((otherInstance) => otherInstance.userId === userId)
						? "never"
						: "secret";
				const reportLegacyCleanupRequired = !normalizationUncertain && deploymentPeers.length === 0;
				const targetUrl = buildQuiNotificationTargetUrl(baseUrl, body.secret, {
					instanceId: instance.id,
					deploymentId,
					ownerId,
				});

				try {
					const created = await client.ensureNotificationTarget({
						name: buildQuiNotificationTargetName(
							app.installationId,
							userId,
							instance.id,
							instance.baseUrl,
						),
						url: targetUrl,
						ownerId,
						legacyTargetAdoption,
						reportLegacyCleanupRequired,
						eventTypes: body.eventTypes,
						enabled: true,
					});
					return reply.send({
						ok: true,
						quiTargetId: created.id,
						...(created.cleanupPending || created.legacyCleanupRequired
							? {
									cleanupPending: true,
									warning: created.legacyCleanupRequired
										? "Target registered, but an ownerless legacy target could not be verified safely. Remove the old arr-dashboard target manually in qUI."
										: "Target registered, but stale duplicate cleanup remains pending. Retry registration to reconcile it.",
								}
							: {}),
					});
				} catch (err) {
					// qUI/Shoutrrr errors can echo the rejected target URL. Sanitize
					// before both logging and returning so the one-time plaintext
					// secret never lands in server logs or client-side telemetry.
					const rawMessage = getErrorMessage(err, "qui registration failed");
					const safeMessage = rawMessage.replace(/secret=[^&\s"']+/g, "secret=***");
					request.log.warn(
						{ error: safeMessage, instanceId: instance.id },
						"Failed to register webhook target in qui",
					);
					return reply.status(502).send({
						error: "qui rejected the notification target registration",
						message: safeMessage,
					});
				}
			});
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
