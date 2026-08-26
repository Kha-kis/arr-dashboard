import type { Prisma, PrismaClientInstance } from "../prisma.js";

export interface SyncRecoveryState {
	id: string;
	userId: string;
	instanceId: string;
	templateId: string | null;
	backupId: string | null;
	status: string;
	rolledBack: boolean;
	rollbackStatus: string | null;
	rollbackAttemptedAt: Date | null;
	rollbackProgress: string | null;
}

export interface DeploymentRecoveryState {
	id: string;
	userId: string;
	instanceId: string;
	templateId: string;
	backupId: string | null;
	status: string;
	rolledBack: boolean;
	undeployStatus: string | null;
	undeployAttemptedAt: Date | null;
	undeployProgress: string | null;
}

class RecoveryHistoryConflictError extends Error {}

function canonicalRecoveryRows<T extends { id: string }>(rows: T[]): T[] {
	return [...rows].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function assertSnapshotOwner(userId: string, state: { userId: string }): void {
	if (state.userId !== userId) throw new RecoveryHistoryConflictError();
}

function deploymentSnapshotWhere(userId: string, deployment: DeploymentRecoveryState) {
	assertSnapshotOwner(userId, deployment);
	return {
		id: deployment.id,
		userId: deployment.userId,
		instanceId: deployment.instanceId,
		templateId: deployment.templateId,
		backupId: deployment.backupId,
		status: deployment.status,
	};
}

function syncSnapshotWhere(userId: string, sync: SyncRecoveryState) {
	assertSnapshotOwner(userId, sync);
	return {
		id: sync.id,
		userId: sync.userId,
		instanceId: sync.instanceId,
		templateId: sync.templateId,
		backupId: sync.backupId,
		status: sync.status,
	};
}

async function claimRecoveryGroup(
	prisma: PrismaClientInstance,
	userId: string,
	deployments: DeploymentRecoveryState[],
	pairedSyncs: SyncRecoveryState[],
	attemptedAt: Date,
): Promise<boolean> {
	if (
		deployments.some((deployment) => deployment.rolledBack) ||
		pairedSyncs.some((sync) => sync.rolledBack)
	) {
		return false;
	}
	try {
		await prisma.$transaction(async (tx) => {
			// Every recovery transaction takes model locks in the same order, then
			// row locks by stable ID. PostgreSQL callers must never be able to enter
			// the same deployment/sync group through an inverse lock order.
			for (const deployment of canonicalRecoveryRows(deployments)) {
				const deploymentClaim = await tx.templateDeploymentHistory.updateMany({
					where: {
						...deploymentSnapshotWhere(userId, deployment),
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

			for (const sync of canonicalRecoveryRows(pairedSyncs)) {
				const syncClaim = await tx.trashSyncHistory.updateMany({
					where: {
						...syncSnapshotWhere(userId, sync),
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

export async function claimUndeployRecoveryGroup(
	prisma: PrismaClientInstance,
	userId: string,
	deployment: DeploymentRecoveryState,
	pairedSyncs: SyncRecoveryState[],
	attemptedAt: Date,
): Promise<boolean> {
	return await claimRecoveryGroup(prisma, userId, [deployment], pairedSyncs, attemptedAt);
}

export async function claimRollbackRecoveryGroup(
	prisma: PrismaClientInstance,
	userId: string,
	pairedSyncs: SyncRecoveryState[],
	pairedDeployments: DeploymentRecoveryState[],
	attemptedAt: Date,
): Promise<boolean> {
	return await claimRecoveryGroup(prisma, userId, pairedDeployments, pairedSyncs, attemptedAt);
}

export interface ClaimedRecoveryGroupMutation {
	deploymentData: (
		state: DeploymentRecoveryState,
	) => Prisma.TemplateDeploymentHistoryUpdateManyMutationInput;
	syncData: (state: SyncRecoveryState) => Prisma.TrashSyncHistoryUpdateManyMutationInput;
	conflictMessage: string;
}

/**
 * Persist a claimed recovery-group transition in the same model/ID lock order
 * used by claims. Snapshot topology remains part of every compare-and-set.
 */
export async function mutateClaimedRecoveryGroup(
	prisma: PrismaClientInstance,
	userId: string,
	deployments: DeploymentRecoveryState[],
	pairedSyncs: SyncRecoveryState[],
	attemptedAt: Date,
	mutation: ClaimedRecoveryGroupMutation,
): Promise<void> {
	await prisma.$transaction(async (tx) => {
		for (const deployment of canonicalRecoveryRows(deployments)) {
			const result = await tx.templateDeploymentHistory.updateMany({
				where: {
					...deploymentSnapshotWhere(userId, deployment),
					rolledBack: false,
					undeployStatus: "IN_PROGRESS",
					undeployAttemptedAt: attemptedAt,
				},
				data: mutation.deploymentData(deployment),
			});
			if (result.count !== 1) throw new Error(mutation.conflictMessage);
		}

		for (const sync of canonicalRecoveryRows(pairedSyncs)) {
			const result = await tx.trashSyncHistory.updateMany({
				where: {
					...syncSnapshotWhere(userId, sync),
					rolledBack: false,
					rollbackStatus: "IN_PROGRESS",
					rollbackAttemptedAt: attemptedAt,
				},
				data: mutation.syncData(sync),
			});
			if (result.count !== 1) throw new Error(mutation.conflictMessage);
		}
	});
}
