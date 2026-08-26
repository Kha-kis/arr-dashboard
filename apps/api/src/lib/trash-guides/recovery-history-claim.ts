import type { PrismaClientInstance } from "../prisma.js";

export interface SyncRecoveryState {
	id: string;
	rolledBack: boolean;
	rollbackStatus: string | null;
	rollbackAttemptedAt: Date | null;
	rollbackProgress: string | null;
}

export interface DeploymentRecoveryState {
	id: string;
	status: string;
	rolledBack: boolean;
	undeployStatus: string | null;
	undeployAttemptedAt: Date | null;
	undeployProgress: string | null;
}

class RecoveryHistoryConflictError extends Error {}

export async function claimUndeployRecoveryGroup(
	prisma: PrismaClientInstance,
	userId: string,
	deployment: DeploymentRecoveryState,
	pairedSyncs: SyncRecoveryState[],
	attemptedAt: Date,
): Promise<boolean> {
	try {
		await prisma.$transaction(async (tx) => {
			const deploymentClaim = await tx.templateDeploymentHistory.updateMany({
				where: {
					id: deployment.id,
					userId,
					status: deployment.status,
					rolledBack: false,
					undeployStatus: deployment.undeployStatus,
					undeployAttemptedAt: deployment.undeployAttemptedAt,
					undeployProgress: deployment.undeployProgress,
				},
				data: {
					undeployStatus: "IN_PROGRESS",
					undeployAttemptedAt: attemptedAt,
				},
			});
			if (deploymentClaim.count !== 1) throw new RecoveryHistoryConflictError();

			for (const sync of pairedSyncs) {
				const syncClaim = await tx.trashSyncHistory.updateMany({
					where: {
						id: sync.id,
						userId,
						rolledBack: false,
						rollbackStatus: sync.rollbackStatus,
						rollbackAttemptedAt: sync.rollbackAttemptedAt,
						rollbackProgress: sync.rollbackProgress,
					},
					data: {
						rollbackStatus: "IN_PROGRESS",
						rollbackAttemptedAt: attemptedAt,
					},
				});
				if (syncClaim.count !== 1) throw new RecoveryHistoryConflictError();
			}
		});
		return true;
	} catch (error) {
		if (error instanceof RecoveryHistoryConflictError) return false;
		throw error;
	}
}

export async function claimRollbackRecoveryGroup(
	prisma: PrismaClientInstance,
	userId: string,
	pairedSyncs: SyncRecoveryState[],
	pairedDeployments: DeploymentRecoveryState[],
	attemptedAt: Date,
): Promise<boolean> {
	try {
		await prisma.$transaction(async (tx) => {
			for (const sync of pairedSyncs) {
				const syncClaim = await tx.trashSyncHistory.updateMany({
					where: {
						id: sync.id,
						userId,
						rolledBack: false,
						rollbackStatus: sync.rollbackStatus,
						rollbackAttemptedAt: sync.rollbackAttemptedAt,
						rollbackProgress: sync.rollbackProgress,
					},
					data: {
						rollbackStatus: "IN_PROGRESS",
						rollbackAttemptedAt: attemptedAt,
					},
				});
				if (syncClaim.count !== 1) throw new RecoveryHistoryConflictError();
			}

			for (const deployment of pairedDeployments) {
				const deploymentClaim = await tx.templateDeploymentHistory.updateMany({
					where: {
						id: deployment.id,
						userId,
						status: deployment.status,
						rolledBack: false,
						undeployStatus: deployment.undeployStatus,
						undeployAttemptedAt: deployment.undeployAttemptedAt,
						undeployProgress: deployment.undeployProgress,
					},
					data: {
						undeployStatus: "IN_PROGRESS",
						undeployAttemptedAt: attemptedAt,
					},
				});
				if (deploymentClaim.count !== 1) throw new RecoveryHistoryConflictError();
			}
		});
		return true;
	} catch (error) {
		if (error instanceof RecoveryHistoryConflictError) return false;
		throw error;
	}
}
