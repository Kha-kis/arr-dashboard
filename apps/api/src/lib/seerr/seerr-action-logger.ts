/**
 * Seerr Action Logger
 *
 * Fire-and-forget helper for recording user actions in the SeerrActionLog table.
 * Never throws — wraps all DB operations in try/catch to avoid breaking user actions.
 */

import type { FastifyBaseLogger, FastifyInstance } from "fastify";

/** Enumerated action types for audit consistency */
export type SeerrAction =
	| "approve_request"
	| "decline_request"
	| "delete_request"
	| "retry_request"
	| "bulk_approve_request"
	| "bulk_decline_request"
	| "bulk_delete_request"
	| "add_issue_comment"
	| "update_issue_status";

export interface SeerrActionLogEntry {
	instanceId: string;
	userId: string;
	action: SeerrAction;
	targetType: "request" | "issue";
	targetId: string;
	detail?: Record<string, unknown>;
	success?: boolean;
}

export function logSeerrAction(
	app: FastifyInstance,
	log: FastifyBaseLogger,
	entry: SeerrActionLogEntry,
): void {
	app.prisma.seerrActionLog
		.create({
			data: {
				instanceId: entry.instanceId,
				userId: entry.userId,
				action: entry.action,
				targetType: entry.targetType,
				targetId: entry.targetId,
				detail: entry.detail ? JSON.stringify(entry.detail) : null,
				success: entry.success ?? true,
			},
		})
		.catch((err) => {
			log.warn({ err, entry }, "Failed to log Seerr action");
		});
}
