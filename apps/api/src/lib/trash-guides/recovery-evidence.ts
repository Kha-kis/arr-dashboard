import { ConflictError } from "../errors.js";
import type { PrismaClient } from "../prisma.js";

export type ReconciledRecoveryClaimCounts = {
	rollback: number;
	undeploy: number;
	sync: number;
	deployment: number;
	total: number;
};

const RESTART_INTERRUPTED_MESSAGE =
	"Recovery was interrupted by an application restart; retry the operation.";
const RESTART_UNCERTAIN_MESSAGE =
	"Operation was interrupted by an application restart; final upstream state is uncertain.";

function restartInterruptedProgress(
	step: "rollback" | "remove-custom-formats",
	message: string,
): string {
	return JSON.stringify([
		{
			step,
			status: "PARTIAL",
			errors: [message],
		},
	]);
}

/** Make restart-abandoned recovery claims retryable in one authoritative transaction. */
export async function reconcileAbandonedTrashRecoveryClaims(
	prisma: PrismaClient,
): Promise<ReconciledRecoveryClaimCounts> {
	const [rollback, undeploy, snapshotlessSync, recoverableSync, deployment] =
		await prisma.$transaction([
			prisma.trashSyncHistory.updateMany({
				where: { rollbackStatus: "IN_PROGRESS" },
				data: {
					rollbackStatus: "PARTIAL",
					rollbackProgress: restartInterruptedProgress("rollback", RESTART_INTERRUPTED_MESSAGE),
				},
			}),
			prisma.templateDeploymentHistory.updateMany({
				where: { undeployStatus: "IN_PROGRESS" },
				data: {
					undeployStatus: "PARTIAL",
					undeployProgress: restartInterruptedProgress(
						"remove-custom-formats",
						RESTART_INTERRUPTED_MESSAGE,
					),
				},
			}),
			prisma.trashSyncHistory.updateMany({
				where: {
					status: { in: ["IN_PROGRESS", "RUNNING"] },
					backupId: null,
				},
				data: {
					status: "UNCERTAIN",
					errorLog: RESTART_UNCERTAIN_MESSAGE,
					rollbackStatus: null,
					rollbackProgress: null,
				},
			}),
			prisma.trashSyncHistory.updateMany({
				where: {
					status: { in: ["IN_PROGRESS", "RUNNING"] },
					backupId: { not: null },
				},
				data: {
					status: "UNCERTAIN",
					errorLog: RESTART_UNCERTAIN_MESSAGE,
					rollbackStatus: "PARTIAL",
					rollbackProgress: restartInterruptedProgress("rollback", RESTART_UNCERTAIN_MESSAGE),
				},
			}),
			prisma.templateDeploymentHistory.updateMany({
				where: { status: "IN_PROGRESS" },
				data: {
					status: "UNCERTAIN",
					errors: JSON.stringify([RESTART_UNCERTAIN_MESSAGE]),
					undeployStatus: "PARTIAL",
					undeployProgress: restartInterruptedProgress(
						"remove-custom-formats",
						RESTART_UNCERTAIN_MESSAGE,
					),
				},
			}),
		]);
	const syncCount = snapshotlessSync.count + recoverableSync.count;

	return {
		rollback: rollback.count,
		undeploy: undeploy.count,
		sync: syncCount,
		deployment: deployment.count,
		total: rollback.count + undeploy.count + syncCount + deployment.count,
	};
}

/** Allow cascading history only after rollback or undeploy is explicitly terminal. */
export async function assertNoActiveTrashRecoveryForInstance(
	prisma: PrismaClient,
	userId: string,
	instanceId: string,
): Promise<void> {
	const [rollbackHistory, undeployHistory] = await Promise.all([
		prisma.trashSyncHistory.findMany({
			where: { userId, instanceId },
			select: { id: true, status: true, rolledBack: true, rollbackStatus: true },
		}),
		prisma.templateDeploymentHistory.findMany({
			where: { userId, instanceId },
			select: { id: true, status: true, rolledBack: true, undeployStatus: true },
		}),
	]);

	const hasActiveSync = rollbackHistory.some(
		(history) => !(history.rolledBack === true && history.rollbackStatus === "COMPLETED"),
	);
	const hasActiveDeployment = undeployHistory.some(
		(history) => !(history.rolledBack === true && history.undeployStatus === "COMPLETED"),
	);

	if (hasActiveSync || hasActiveDeployment) {
		throw new ConflictError(
			"This ARR instance has active TRaSH recovery work. Complete or explicitly resolve the rollback or undeploy before deleting the service.",
		);
	}
}
