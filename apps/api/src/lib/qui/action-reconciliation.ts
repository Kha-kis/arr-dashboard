import { QUI_ACTION_PENDING_GRACE_MS } from "@arr/shared";
import type { PrismaClient } from "../../generated/prisma/client.js";

export type QuiActionResolutionDecision = "applied" | "not_applied";
export type QuiActionResolutionStatus =
	| "operator_verified_applied"
	| "operator_verified_not_applied";

export class QuiActionReconciliationError extends Error {
	constructor() {
		super("qUI action not found or already resolved");
	}
}

/**
 * Record an explicit, per-hash operator judgment after an ambiguous qUI
 * request. This does not claim that qUI itself confirmed the outcome.
 * The first statement is a scoped write, so SQLite never upgrades a stale
 * read transaction while another API worker is resolving the same row.
 */
export async function reconcileQuiAction(args: {
	prisma: PrismaClient;
	userId: string;
	actionLogId: string;
	decision: QuiActionResolutionDecision;
}): Promise<QuiActionResolutionStatus> {
	const { prisma, userId, actionLogId, decision } = args;
	const status: QuiActionResolutionStatus =
		decision === "applied" ? "operator_verified_applied" : "operator_verified_not_applied";
	await prisma.$transaction(async (tx) => {
		const changed = await tx.quiActionLog.updateMany({
			where: {
				id: actionLogId,
				userId,
				status: { in: ["pending", "uncertain"] },
				requestedAt: { lt: new Date(Date.now() - QUI_ACTION_PENDING_GRACE_MS) },
			},
			data: { status, completedAt: new Date() },
		});
		if (changed.count !== 1) throw new QuiActionReconciliationError();

		const row = await tx.quiActionLog.findUniqueOrThrow({
			where: { id: actionLogId },
			select: { serviceInstanceId: true, qbitInstanceId: true, torrentHash: true, attemptId: true },
		});
		const claimKey = {
			userId,
			serviceInstanceId: row.serviceInstanceId,
			qbitInstanceId: row.qbitInstanceId,
			torrentHash: row.torrentHash.toLowerCase(),
		};
		const claim = await tx.quiActionClaim.findUnique({
			where: { userId_serviceInstanceId_qbitInstanceId_torrentHash: claimKey },
			select: { attemptId: true },
		});
		if (
			(row.attemptId === null) !== (claim === null) ||
			claim?.attemptId !== (row.attemptId ?? undefined)
		) {
			throw new QuiActionReconciliationError();
		}
		if (claim) {
			await tx.quiActionClaim.delete({
				where: { userId_serviceInstanceId_qbitInstanceId_torrentHash: claimKey },
			});
		}
	});
	return status;
}
