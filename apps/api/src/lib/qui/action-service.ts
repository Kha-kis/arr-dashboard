/**
 * qui action service (Phase 4.1).
 *
 * Wraps `QuiClient.bulkAction` with audit logging. Every mutation
 * arr-dashboard initiates against a qui instance flows through here so
 * the operator gets a tamper-evident `QuiActionLog` row for each
 * attempt — including failures.
 *
 * Lifecycle per call:
 *   1. Insert a `pending` row (records intent before the network hop, so
 *      a crash mid-call still leaves evidence the action was requested).
 *   2. Invoke qui.
 *   3. Transition the row to `success` (with `completedAt`) or `failed`
 *      (with `completedAt` + sanitized `error`).
 *
 * Trust posture (per qui-integration-design.md §9):
 *   - Ownership is verified by the caller (route handler uses
 *     `requireQuiInstance` which scopes to `request.currentUser.id`).
 *   - This service trusts the caller has already done that check —
 *     re-checking here would double-fetch the ServiceInstance row.
 *   - `error` strings are passed through verbatim from qui's response
 *     body; we don't try to redact, but qui itself doesn't echo the
 *     API key on errors. If that ever changes upstream, the redaction
 *     belongs in `client-helpers.ts:readErrorMessage`, not here.
 */

import type { QuiAction, QuiActionPayload } from "@arr/shared";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { getErrorMessage } from "../utils/error-message.js";
import type { QuiClient } from "./client-factory.js";

export interface ExecuteQuiActionArgs {
	app: FastifyInstance;
	client: QuiClient;
	/** Pre-validated user id from `request.currentUser.id`. */
	userId: string;
	/** Pre-validated qui ServiceInstance id (FK target). */
	serviceInstanceId: string;
	/** qui's qBit instance id from the URL path. */
	qbitInstanceId: number;
	/** One-or-more info hashes targeted by this call. */
	hashes: string[];
	/** Action vocabulary — already validated by route schema. */
	action: QuiAction;
	/**
	 * Action-specific payload. Already validated against
	 * `quiActionPayloadSchemas[action]` by the caller. Spread directly into
	 * qui's bulk-action body and stored as `JSON.stringify(payload)` in
	 * the audit log so the operator can see exactly what was sent.
	 */
	payload?: QuiActionPayload;
	log?: FastifyBaseLogger;
}

export interface ExecuteQuiActionResult {
	/** Number of audit-log rows created (one per (action, hash) pair). */
	logRowCount: number;
	/** New status — terminal after the call, never `pending` past return. */
	status: "success" | "failed";
	/** Sanitized error message when status === "failed"; null otherwise. */
	error: string | null;
}

/**
 * Execute one qui bulk action and record the outcome in `QuiActionLog`.
 *
 * Audit-log granularity is per-hash: a 50-torrent bulk pause creates 50
 * audit rows that share `requestedAt` + `completedAt` but each carries
 * its own (serviceInstanceId, torrentHash) so the per-torrent history
 * surface (Phase 3.2 + 4.1's My Actions) can query by hash without
 * splitting a JSON array column.
 */
export async function executeQuiAction(
	args: ExecuteQuiActionArgs,
): Promise<ExecuteQuiActionResult> {
	const {
		app,
		client,
		userId,
		serviceInstanceId,
		qbitInstanceId,
		hashes,
		action,
		payload,
		log = app.log,
	} = args;

	if (hashes.length === 0) {
		// Defensive: the route schema already enforces min(1), but a future
		// refactor could change that. Returning a no-op result keeps the
		// service contract honest rather than silently calling qui with [].
		return { logRowCount: 0, status: "success", error: null };
	}

	// Audit log captures the entire payload so an operator can reconstruct
	// exactly what was sent. `null` for actions with no extras (pause/resume
	// /recheck/reannounce/forceStart) — empty `{}` would also work but null
	// reads as "no payload" more clearly.
	const payloadString =
		payload !== undefined && Object.keys(payload).length > 0 ? JSON.stringify(payload) : null;

	// 1. Create pending audit rows in one batch — atomic so we don't leak
	//    half-recorded intent if the DB layer fails between rows.
	const requestedAt = new Date();
	const createdRows = await app.prisma.$transaction(
		hashes.map((torrentHash) =>
			app.prisma.quiActionLog.create({
				data: {
					userId,
					serviceInstanceId,
					qbitInstanceId,
					torrentHash,
					action,
					payload: payloadString,
					status: "pending",
					requestedAt,
				},
				select: { id: true },
			}),
		),
	);
	const rowIds = createdRows.map((r) => r.id);

	// 2. Invoke qui. Failure semantics for the two halves of this dance are
	//    DIFFERENT, so we deliberately split the try blocks:
	//      a. If qui itself fails (non-2xx, network), mark the audit rows
	//         `failed` so the operator sees the failure in My Actions.
	//      b. If qui SUCCEEDED but the post-success bookkeeping update fails
	//         (transient DB error between qui's 200 and our updateMany), we
	//         must NOT mark the rows `failed` — that would lie to the operator
	//         and prompt a duplicate action. Leave the rows `pending` and log
	//         loudly; a follow-up reconciler can drain pending rows later.
	let quiOutcome: "ok" | "fail" = "ok";
	let quiError: unknown = null;
	try {
		// Pass extras as undefined when payload is empty so the client
		// doesn't spread `{}` into qui's POST body (cleaner wire shape, and
		// preserves the existing test contract that a no-extras action
		// receives `extras: undefined`).
		const hasExtras = payload !== undefined && Object.keys(payload).length > 0;
		await client.bulkAction({
			qbitInstanceId,
			hashes,
			action,
			extras: hasExtras ? (payload as Record<string, unknown>) : undefined,
		});
	} catch (error) {
		quiOutcome = "fail";
		quiError = error;
	}

	const completedAt = new Date();
	if (quiOutcome === "fail") {
		const message = getErrorMessage(quiError, "qui action failed");
		// Mark rows failed. If THIS write itself fails, the rows stay pending —
		// which is correct ("we tried, we don't know the outcome"). Surface
		// the secondary failure so an operator can reconcile manually.
		try {
			await app.prisma.quiActionLog.updateMany({
				where: { id: { in: rowIds } },
				data: { status: "failed", completedAt, error: message },
			});
		} catch (updateErr) {
			log.error(
				{ err: updateErr, rowIds, userId, serviceInstanceId, action },
				"qui action failed AND audit-log update failed — pending rows require manual reconciliation",
			);
		}
		log.warn(
			{
				err: quiError,
				userId,
				serviceInstanceId,
				qbitInstanceId,
				action,
				hashCount: hashes.length,
			},
			"qui action failed",
		);
		return { logRowCount: rowIds.length, status: "failed", error: message };
	}

	// qui succeeded. The action HAS happened on the remote system; the
	// bookkeeping below cannot un-happen it. So a write failure here must
	// not be misreported as a failed mutation — return success and let the
	// operator's audit row stay `pending` (the operator can see the gap and
	// we have an error log for triage).
	try {
		await app.prisma.quiActionLog.updateMany({
			where: { id: { in: rowIds } },
			data: { status: "success", completedAt },
		});
	} catch (updateErr) {
		log.error(
			{ err: updateErr, rowIds, userId, serviceInstanceId, action, hashCount: hashes.length },
			"qui action succeeded but audit-log success-update failed — rows left pending; manual reconciliation required",
		);
	}
	log.info(
		{ userId, serviceInstanceId, qbitInstanceId, action, hashCount: hashes.length },
		"qui action succeeded",
	);
	return { logRowCount: rowIds.length, status: "success", error: null };
}
