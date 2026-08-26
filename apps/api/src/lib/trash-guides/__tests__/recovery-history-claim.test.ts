import { describe, expect, it, vi } from "vitest";
import type { PrismaClientInstance } from "../../prisma.js";
import {
	claimRollbackRecoveryGroup,
	type DeploymentRecoveryState,
	mutateClaimedRecoveryGroup,
	type SyncRecoveryState,
} from "../recovery-history-claim.js";

const userId = "recovery-user";
const attemptedAt = new Date("2026-08-26T12:00:00.000Z");

function deployment(id: string): DeploymentRecoveryState {
	return {
		id,
		userId,
		instanceId: "instance-1",
		templateId: "template-1",
		backupId: "backup-1",
		status: "SUCCESS",
		rolledBack: false,
		undeployStatus: null,
		undeployAttemptedAt: null,
		undeployProgress: null,
	};
}

function sync(id: string): SyncRecoveryState {
	return {
		id,
		userId,
		instanceId: "instance-1",
		templateId: "template-1",
		backupId: "backup-1",
		status: "SUCCESS",
		rolledBack: false,
		rollbackStatus: null,
		rollbackAttemptedAt: null,
		rollbackProgress: null,
	};
}

function prismaRecorder(calls: string[]) {
	const deploymentUpdateMany = vi.fn(async ({ where }: { where: { id: string } }) => {
		calls.push(`deployment:${where.id}`);
		return { count: 1 };
	});
	const syncUpdateMany = vi.fn(async ({ where }: { where: { id: string } }) => {
		calls.push(`sync:${where.id}`);
		return { count: 1 };
	});
	const transactionClient = {
		templateDeploymentHistory: { updateMany: deploymentUpdateMany },
		trashSyncHistory: { updateMany: syncUpdateMany },
	};
	const prisma = {
		$transaction: vi.fn(async (callback) => callback(transactionClient)),
	} as unknown as PrismaClientInstance;
	return { prisma, deploymentUpdateMany, syncUpdateMany };
}

describe("recovery history claim ordering", () => {
	it("rejects terminal deployment and sync snapshots before opening a transaction", async () => {
		const calls: string[] = [];
		const { prisma } = prismaRecorder(calls);
		const terminalDeployment = { ...deployment("deployment-a"), rolledBack: true };
		const terminalSync = { ...sync("sync-a"), rolledBack: true };

		await expect(
			claimRollbackRecoveryGroup(
				prisma,
				userId,
				[sync("sync-current")],
				[terminalDeployment],
				attemptedAt,
			),
		).resolves.toBe(false);
		await expect(
			claimRollbackRecoveryGroup(
				prisma,
				userId,
				[terminalSync],
				[deployment("deployment-current")],
				attemptedAt,
			),
		).resolves.toBe(false);

		expect(prisma.$transaction).not.toHaveBeenCalled();
		expect(calls).toEqual([]);
	});

	it("claims deployment rows before sync rows, sorts IDs, and CASes the full topology", async () => {
		const calls: string[] = [];
		const { prisma, deploymentUpdateMany, syncUpdateMany } = prismaRecorder(calls);

		await expect(
			claimRollbackRecoveryGroup(
				prisma,
				userId,
				[sync("sync-z"), sync("sync-a")],
				[deployment("deployment-z"), deployment("deployment-a")],
				attemptedAt,
			),
		).resolves.toBe(true);

		expect(calls).toEqual([
			"deployment:deployment-a",
			"deployment:deployment-z",
			"sync:sync-a",
			"sync:sync-z",
		]);
		expect(deploymentUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					userId,
					instanceId: "instance-1",
					templateId: "template-1",
					backupId: "backup-1",
					status: "SUCCESS",
				}),
			}),
		);
		expect(syncUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					userId,
					instanceId: "instance-1",
					templateId: "template-1",
					backupId: "backup-1",
					status: "SUCCESS",
				}),
			}),
		);
	});

	it("uses the same canonical order for claimed progress and terminal transitions", async () => {
		const calls: string[] = [];
		const { prisma } = prismaRecorder(calls);

		await mutateClaimedRecoveryGroup(
			prisma,
			userId,
			[deployment("deployment-z"), deployment("deployment-a")],
			[sync("sync-z"), sync("sync-a")],
			attemptedAt,
			{
				deploymentData: () => ({ undeployStatus: "COMPLETED" }),
				syncData: () => ({ rollbackStatus: "COMPLETED" }),
				conflictMessage: "claim changed",
			},
		);

		expect(calls).toEqual([
			"deployment:deployment-a",
			"deployment:deployment-z",
			"sync:sync-a",
			"sync:sync-z",
		]);
	});
});
