import { ConflictError } from "../errors.js";
import type { PrismaClient } from "../prisma.js";
import { isNonterminalRollback, isNonterminalUndeploy } from "../backup/backup-validation.js";

/** Prevent service deletion from cascading away retryable rollback or undeploy evidence. */
export async function assertNoActiveTrashRecoveryForInstance(
	prisma: PrismaClient,
	userId: string,
	instanceId: string,
): Promise<void> {
	const [rollbackHistory, undeployHistory] = await Promise.all([
		prisma.trashSyncHistory.findMany({
			where: { userId, instanceId },
			select: { id: true, rolledBack: true, rollbackStatus: true },
		}),
		prisma.templateDeploymentHistory.findMany({
			where: { userId, instanceId },
			select: { id: true, status: true, rolledBack: true, undeployStatus: true },
		}),
	]);

	if (rollbackHistory.some(isNonterminalRollback) || undeployHistory.some(isNonterminalUndeploy)) {
		throw new ConflictError(
			"This ARR instance has active TRaSH recovery work. Complete or explicitly resolve the rollback or undeploy before deleting the service.",
		);
	}
}
