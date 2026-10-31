/**
 * Seerr Action Logger
 *
 * Joined best-effort helper for recording user actions in the SeerrActionLog table.
 * Never throws — wraps all DB operations in try/catch to avoid breaking user actions.
 */

import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { SeerrMutationOutcomeUnknownError } from "../errors.js";

/** Preserve ambiguity in the legacy boolean audit row without a schema change. */
export function seerrActionFailureDetail(error: unknown): {
	detail?: { outcome: "unknown" };
} {
	return error instanceof SeerrMutationOutcomeUnknownError
		? { detail: { outcome: "unknown" } }
		: {};
}

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

export async function logSeerrAction(
	app: FastifyInstance,
	log: FastifyBaseLogger,
	entry: SeerrActionLogEntry,
): Promise<void> {
	try {
		await app.prisma.seerrActionLog.create({
			data: {
				instanceId: entry.instanceId,
				userId: entry.userId,
				action: entry.action,
				targetType: entry.targetType,
				targetId: entry.targetId,
				detail: entry.detail ? JSON.stringify(entry.detail) : null,
				success: entry.success ?? true,
			},
		});
	} catch (err) {
		log.warn({ err, entry }, "Failed to log Seerr action");
	}
}
