import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../prisma.js";
import {
	assertNoActiveTrashRecoveryForInstance,
	reconcileAbandonedTrashRecoveryClaims,
} from "../recovery-evidence.js";

function createRecoveryPrisma() {
	const rollbackUpdate = Promise.resolve({ count: 2 });
	const undeployUpdate = Promise.resolve({ count: 3 });
	const snapshotlessSyncUpdate = Promise.resolve({ count: 1 });
	const recoverableSyncUpdate = Promise.resolve({ count: 3 });
	const deploymentUpdate = Promise.resolve({ count: 1 });
	const trashSyncHistory = {
		findMany: vi.fn().mockResolvedValue([]),
		updateMany: vi
			.fn()
			.mockReturnValueOnce(rollbackUpdate)
			.mockReturnValueOnce(snapshotlessSyncUpdate)
			.mockReturnValueOnce(recoverableSyncUpdate),
	};
	const templateDeploymentHistory = {
		findMany: vi.fn().mockResolvedValue([]),
		updateMany: vi.fn().mockReturnValueOnce(undeployUpdate).mockReturnValueOnce(deploymentUpdate),
	};
	const $transaction = vi
		.fn()
		.mockResolvedValue([{ count: 2 }, { count: 3 }, { count: 1 }, { count: 3 }, { count: 1 }]);

	return {
		prisma: {
			trashSyncHistory,
			templateDeploymentHistory,
			$transaction,
		} as unknown as PrismaClient,
		trashSyncHistory,
		templateDeploymentHistory,
		$transaction,
		rollbackUpdate,
		undeployUpdate,
		snapshotlessSyncUpdate,
		recoverableSyncUpdate,
		deploymentUpdate,
	};
}

describe("reconcileAbandonedTrashRecoveryClaims", () => {
	it("atomically reconciles abandoned recovery claims and ordinary operation audits", async () => {
		const {
			prisma,
			trashSyncHistory,
			templateDeploymentHistory,
			$transaction,
			rollbackUpdate,
			undeployUpdate,
			snapshotlessSyncUpdate,
			recoverableSyncUpdate,
			deploymentUpdate,
		} = createRecoveryPrisma();

		const counts = await reconcileAbandonedTrashRecoveryClaims(prisma);

		expect(trashSyncHistory.updateMany).toHaveBeenNthCalledWith(1, {
			where: { rollbackStatus: "IN_PROGRESS" },
			data: {
				rollbackStatus: "PARTIAL",
				rollbackProgress:
					'[{"step":"rollback","status":"PARTIAL","errors":["Recovery was interrupted by an application restart; retry the operation."]}]',
			},
		});
		expect(templateDeploymentHistory.updateMany).toHaveBeenNthCalledWith(1, {
			where: { undeployStatus: "IN_PROGRESS" },
			data: {
				undeployStatus: "PARTIAL",
				undeployProgress:
					'[{"step":"remove-custom-formats","status":"PARTIAL","errors":["Recovery was interrupted by an application restart; retry the operation."]}]',
			},
		});
		expect(trashSyncHistory.updateMany).toHaveBeenNthCalledWith(2, {
			where: {
				status: { in: ["IN_PROGRESS", "RUNNING"] },
				backupId: null,
			},
			data: {
				status: "UNCERTAIN",
				errorLog:
					"Operation was interrupted by an application restart; final upstream state is uncertain.",
				rollbackStatus: null,
				rollbackProgress: null,
			},
		});
		expect(trashSyncHistory.updateMany).toHaveBeenNthCalledWith(3, {
			where: {
				status: { in: ["IN_PROGRESS", "RUNNING"] },
				backupId: { not: null },
			},
			data: {
				status: "UNCERTAIN",
				errorLog:
					"Operation was interrupted by an application restart; final upstream state is uncertain.",
				rollbackStatus: "PARTIAL",
				rollbackProgress:
					'[{"step":"rollback","status":"PARTIAL","errors":["Operation was interrupted by an application restart; final upstream state is uncertain."]}]',
			},
		});
		expect(templateDeploymentHistory.updateMany).toHaveBeenNthCalledWith(2, {
			where: { status: "IN_PROGRESS" },
			data: {
				status: "UNCERTAIN",
				errors:
					'["Operation was interrupted by an application restart; final upstream state is uncertain."]',
				undeployStatus: "PARTIAL",
				undeployProgress:
					'[{"step":"remove-custom-formats","status":"PARTIAL","errors":["Operation was interrupted by an application restart; final upstream state is uncertain."]}]',
			},
		});
		expect($transaction).toHaveBeenCalledWith([
			rollbackUpdate,
			undeployUpdate,
			snapshotlessSyncUpdate,
			recoverableSyncUpdate,
			deploymentUpdate,
		]);
		expect(counts).toEqual({
			rollback: 2,
			undeploy: 3,
			sync: 4,
			deployment: 1,
			total: 10,
		});
	});
});

describe("assertNoActiveTrashRecoveryForInstance", () => {
	it.each(["IN_PROGRESS", "RUNNING"])(
		"blocks deletion while an ordinary sync is %s without rollback state",
		async (status) => {
			const { prisma, trashSyncHistory } = createRecoveryPrisma();
			trashSyncHistory.findMany.mockResolvedValueOnce([
				{ id: "sync-1", status, rolledBack: false, rollbackStatus: null },
			]);

			await expect(
				assertNoActiveTrashRecoveryForInstance(prisma, "user-1", "instance-1"),
			).rejects.toThrow(/active TRaSH recovery work/i);
		},
	);

	it("blocks deletion while an ordinary deployment is in progress without undeploy state", async () => {
		const { prisma, templateDeploymentHistory } = createRecoveryPrisma();
		templateDeploymentHistory.findMany.mockResolvedValueOnce([
			{
				id: "deployment-1",
				status: "IN_PROGRESS",
				rolledBack: false,
				undeployStatus: null,
			},
		]);

		await expect(
			assertNoActiveTrashRecoveryForInstance(prisma, "user-1", "instance-1"),
		).rejects.toThrow(/active TRaSH recovery work/i);
	});
});
