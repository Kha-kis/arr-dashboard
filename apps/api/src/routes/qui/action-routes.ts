import type { QuiAction, QuiActionPayload } from "@arr/shared";
import {
	coerceQuiAction,
	coerceQuiActionStatus,
	quiActionPayloadSchemas,
	quiBulkActionRequestSchema,
} from "@arr/shared";
import type { FastifyInstance } from "fastify";
import { executeQuiAction } from "../../lib/qui/action-service.js";
import { createQuiClient } from "../../lib/qui/client-factory.js";
import { requireQuiInstance } from "../../lib/qui/instance-helpers.js";
import { validateRequest } from "../../lib/utils/validate.js";
import {
	ACTION_LOG_QUERY,
	ACTION_PARAMS,
	BULK_ACTION_PARAMS,
	safeParseJson,
} from "./qui-shared.js";

export function registerActionRoutes(app: FastifyInstance): void {
	// ────────────────────────────────────────────────────────────────────
	// Phase 4.1 — single-torrent action endpoint
	// ────────────────────────────────────────────────────────────────────

	app.post<{
		Params: { id: string; instanceId: string; hash: string; action: string };
		Body: unknown;
	}>(
		"/qui/instances/:id/qbit/:instanceId/torrents/:hash/actions/:action",
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const { id, instanceId, hash, action } = validateRequest(ACTION_PARAMS, request.params);
			const qbitInstanceId = Number.parseInt(instanceId, 10);
			if (!Number.isFinite(qbitInstanceId)) {
				return reply.status(400).send({ error: "qbit instanceId must be numeric" });
			}
			// Per-action payload validation: each action declares its own
			// required body shape in `quiActionPayloadSchemas`. The route
			// picks the right schema from URL `:action` and validates the
			// body against it — wrong-field-with-wrong-action becomes a
			// 400 with a precise Zod error path instead of "qui rejected it."
			const payloadSchema = quiActionPayloadSchemas[action as QuiAction];
			const payload = validateRequest(payloadSchema, request.body ?? {}) as QuiActionPayload;

			// Ownership: requireQuiInstance only returns the row when (userId, id)
			// match AND service=QUI. Other users' ids surface as 404, not 403.
			const instance = await requireQuiInstance(app, userId, id);
			const client = createQuiClient(app, instance);

			const result = await executeQuiAction({
				app,
				client,
				userId,
				serviceInstanceId: instance.id,
				qbitInstanceId,
				hashes: [hash],
				action,
				payload,
			});

			// Surface failures as 502 (upstream said no) — the audit log row
			// captures the precise reason; the response body just carries
			// enough for the UI to render a toast.
			if (result.status === "failed") {
				return reply.status(502).send({
					error: "qui mutation failed",
					message: result.error ?? "qui mutation failed",
				});
			}

			return reply.send({ status: "success", logRowCount: result.logRowCount });
		},
	);

	// ────────────────────────────────────────────────────────────────────
	// Phase 4.2 — bulk action endpoint (same service, hashes[] in body)
	// ────────────────────────────────────────────────────────────────────

	app.post<{
		Params: { id: string; instanceId: string; action: string };
		Body: unknown;
	}>("/qui/instances/:id/qbit/:instanceId/torrents/bulk-action/:action", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { id, instanceId, action } = validateRequest(BULK_ACTION_PARAMS, request.params);
		// First parse the envelope (`hashes[]` cap + format), then validate
		// the action-specific extras against `quiActionPayloadSchemas[action]`.
		// Two passes because the envelope and the per-action payload share
		// the same flat body — the second pass enforces field presence and
		// types for the action's extras (e.g. `category` for setCategory).
		const envelope = validateRequest(quiBulkActionRequestSchema, request.body);
		const qbitInstanceId = Number.parseInt(instanceId, 10);
		if (!Number.isFinite(qbitInstanceId)) {
			return reply.status(400).send({ error: "qbit instanceId must be numeric" });
		}
		const payloadSchema = quiActionPayloadSchemas[action as QuiAction];
		// Strip envelope-level fields (`hashes`) before payload validation —
		// otherwise emptyPayload's `passthrough()` would let `hashes` leak
		// into `extras` and qui would receive duplicated arrays in its POST
		// body. Field-specific payload schemas would reject unknown keys
		// silently here too without the strip.
		const rawBody = (request.body ?? {}) as Record<string, unknown>;
		const { hashes: _omitHashes, ...payloadBody } = rawBody;
		const payload = validateRequest(payloadSchema, payloadBody) as QuiActionPayload;

		const instance = await requireQuiInstance(app, userId, id);
		const client = createQuiClient(app, instance);

		const result = await executeQuiAction({
			app,
			client,
			userId,
			serviceInstanceId: instance.id,
			qbitInstanceId,
			hashes: envelope.hashes,
			action,
			payload,
		});

		if (result.status === "failed") {
			return reply.status(502).send({
				error: "qui mutation failed",
				message: result.error ?? "qui mutation failed",
			});
		}

		return reply.send({ status: "success", logRowCount: result.logRowCount });
	});

	// ────────────────────────────────────────────────────────────────────
	// Phase 4.1 — action log feed for the "My Actions" tab
	// ────────────────────────────────────────────────────────────────────
	//
	// Mirrors the activity feed pagination shape. Joins the ServiceInstance
	// label so the frontend can render "Primary qui" without a second query.
	// Failures: `error` text is included verbatim so the operator can see
	// what qui returned without leaving the timeline.

	app.get<{
		Querystring: { cursor?: string; limit?: string; action?: string; status?: string };
	}>("/qui/actions", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { cursor, limit, action, status } = validateRequest(ACTION_LOG_QUERY, request.query);
		const take = limit ?? 50;

		let cursorRequestedAt: Date | null = null;
		if (cursor) {
			const anchor = await app.prisma.quiActionLog.findUnique({
				where: { id: cursor },
				select: { requestedAt: true, userId: true },
			});
			if (anchor && anchor.userId === userId) {
				cursorRequestedAt = anchor.requestedAt;
			}
		}

		const rows = await app.prisma.quiActionLog.findMany({
			where: {
				userId,
				...(action ? { action } : {}),
				...(status ? { status } : {}),
				...(cursorRequestedAt ? { requestedAt: { lt: cursorRequestedAt } } : {}),
			},
			orderBy: { requestedAt: "desc" },
			take: take + 1,
			include: {
				serviceInstance: { select: { label: true } },
			},
		});

		const hasMore = rows.length > take;
		const trimmed = hasMore ? rows.slice(0, take) : rows;
		const nextCursor = hasMore ? (trimmed[trimmed.length - 1]?.id ?? null) : null;

		// Coerce the DB's String columns back through the shared enum so a
		// stray value (older deploy with a different enum, or a future enum
		// extension reaching an old client) can't type-lie into the response.
		// Unknown values are filtered + counted instead of crashing the
		// page — the client never sees an action/status it can't render.
		const entries = trimmed
			.map((r) => {
				const action = coerceQuiAction(r.action);
				const status = coerceQuiActionStatus(r.status);
				if (action === "unknown" || status === "unknown") {
					request.log.warn(
						{ rowId: r.id, rawAction: r.action, rawStatus: r.status, userId },
						"qui action-log row had unknown enum value — filtering from response",
					);
					return null;
				}
				const requestedAtIso = r.requestedAt.toISOString();
				return {
					id: r.id,
					serviceInstanceId: r.serviceInstanceId,
					serviceInstanceLabel: r.serviceInstance.label,
					qbitInstanceId: r.qbitInstanceId,
					torrentHash: r.torrentHash,
					action,
					status,
					error: r.error,
					payload: r.payload ? safeParseJson(r.payload) : null,
					requestedAt: requestedAtIso,
					/** Canonical timestamp alias — see schema notes. */
					timestamp: requestedAtIso,
					completedAt: r.completedAt ? r.completedAt.toISOString() : null,
				};
			})
			.filter((entry): entry is NonNullable<typeof entry> => entry !== null);

		return reply.send({ entries, nextCursor });
	});
}
