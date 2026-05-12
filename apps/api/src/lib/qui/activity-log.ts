/**
 * qui Activity Log emitter (Phase 3.2).
 *
 * Discrete, per-user event timeline for qui-related operations. Surfaces
 * to operators via the /qui-activity page as a chronological feed.
 *
 * Design intent:
 *   - **Emit-and-forget.** Activity logging is non-fatal — a failed insert
 *     never aborts the work the event describes (sync, gate firing, etc.).
 *   - **Bounded growth.** Each event type independently trims its own tail
 *     after insert. No global retention job; the table stays small without
 *     a sweeper.
 *   - **Extensible vocabulary.** New eventType strings can be added in
 *     future phases (Phase 4 mutations, Phase 5 webhook events) without
 *     schema churn — `details` is a JSON blob.
 */

import type { FastifyBaseLogger, FastifyInstance } from "fastify";

/** Per-user retention cap, applied per eventType. */
const EVENTS_PER_TYPE_PER_USER = 200;

export type QuiActivityStatus = "ok" | "warn" | "error";

export interface LogQuiActivityArgs<TDetails> {
	app: FastifyInstance;
	userId: string;
	eventType: string;
	details: TDetails;
	status?: QuiActivityStatus;
	log?: FastifyBaseLogger;
}

/**
 * Insert one activity row, then trim the user's tail for that eventType to
 * EVENTS_PER_TYPE_PER_USER. Both operations are idempotent on failure —
 * the caller's work continues regardless.
 */
export async function logQuiActivity<TDetails>(args: LogQuiActivityArgs<TDetails>): Promise<void> {
	const { app, userId, eventType, details, status = "ok", log = app.log } = args;
	try {
		await app.prisma.quiActivityLog.create({
			data: {
				userId,
				eventType,
				details: JSON.stringify(details),
				status,
			},
		});

		// Trim: delete the oldest rows beyond the cap for this (userId, eventType).
		// We use a cursor-style "keep newest N" via raw findMany + deleteMany
		// because Prisma doesn't expose a one-shot trim. Failures here are
		// non-fatal (table grows by 1; cleaned next time).
		const tailKeepCutoff = await app.prisma.quiActivityLog.findFirst({
			where: { userId, eventType },
			orderBy: { createdAt: "desc" },
			skip: EVENTS_PER_TYPE_PER_USER,
			select: { createdAt: true },
		});

		if (tailKeepCutoff) {
			await app.prisma.quiActivityLog.deleteMany({
				where: {
					userId,
					eventType,
					createdAt: { lte: tailKeepCutoff.createdAt },
				},
			});
		}
	} catch (err) {
		// Activity logging is observability, not control flow. A failed write
		// must never propagate to the caller — they're doing real work.
		log.warn(
			{ err, userId, eventType },
			"qui activity log write failed; continuing without log entry",
		);
	}
}

/** Detail shape for `qui_sync_complete` events (Phase 3.2). */
export interface QuiSyncCompleteDetails {
	instancesScanned: number;
	torrentsSeen: number;
	rowsUpdated: number;
	rowsCleared: number;
	errors: number;
	durationMs: number;
}

/** Detail shape for `qui_backfill_complete` events (Phase 3.2). */
export interface QuiBackfillCompleteDetails {
	itemsScanned: number;
	itemsUpdated: number;
	itemsWithoutHash: number;
	durationMs: number;
}
