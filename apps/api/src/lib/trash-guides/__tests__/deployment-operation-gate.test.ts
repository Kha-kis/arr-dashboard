import { describe, expect, it, vi } from "vitest";
import {
	assertNoActiveDeploymentOwnership,
	assertNoPendingDeploymentOperation,
	reconcileInterruptedDeploymentHistories,
} from "../deployment-operation-gate.js";

function backup(status: "pending" | "applied") {
	return {
		id: "backup-1",
		backupData: JSON.stringify({
			schemaVersion: 2,
			endpointKey: "endpoint",
			connectionStateToken: "connection",
			customFormats: [],
			customFormatDeployments: [
				{
					beforeFormat: { id: 7, name: "Foo" },
					action: "updated",
					resourceId: 7,
					name: "Foo",
					status,
					postStateToken: status === "applied" ? "post" : null,
				},
			],
			managedCustomFormats: [],
			managedCustomFormatsCaptured: false,
			qualityProfileDeployment: {
				beforeProfile: null,
				status: "not_started",
				action: "updated",
				profileId: null,
				postStateToken: null,
			},
			namingDeployment: null,
		}),
	};
}

function fullyAppliedBackup() {
	return {
		id: "backup-1",
		backupData: JSON.stringify({
			schemaVersion: 2,
			endpointKey: "endpoint",
			connectionStateToken: "connection",
			customFormats: [],
			customFormatDeployments: [
				{
					beforeFormat: null,
					action: "created",
					resourceId: 7,
					name: "Created CF",
					status: "applied",
					postStateToken: "created-post",
				},
				{
					beforeFormat: { id: 8, name: "Updated CF" },
					action: "updated",
					resourceId: 8,
					name: "Updated CF",
					status: "applied",
					postStateToken: "updated-post",
				},
			],
			managedCustomFormats: [],
			managedCustomFormatsCaptured: true,
			qualityProfileDeployment: {
				beforeProfile: { id: 9, name: "HD-1080p" },
				status: "applied",
				action: "updated",
				profileId: 9,
				profileName: "HD-1080p",
				postStateToken: "profile-post",
			},
			namingDeployment: {
				beforeConfig: { renameEpisodes: false },
				status: "applied",
				postStateToken: "naming-post",
			},
		}),
	};
}

describe("assertNoPendingDeploymentOperation", () => {
	it("blocks endpoint mutations while a rollback is partial and retryable", async () => {
		const prisma = {
			trashSyncHistory: {
				findMany: vi
					.fn()
					.mockResolvedValue([{ rollbackStatus: "PARTIAL", backup: fullyAppliedBackup() }]),
			},
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
		};

		await expect(
			assertNoPendingDeploymentOperation(prisma as never, "user-1", ["instance-1"]),
		).rejects.toThrow("unfinished rollback");
	});

	it("blocks endpoint mutations while an undeploy is partial and retryable", async () => {
		const prisma = {
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
			templateDeploymentHistory: {
				findMany: vi.fn().mockResolvedValue([
					{
						status: "SUCCESS",
						undeployStatus: "PARTIAL",
						backup: fullyAppliedBackup(),
					},
				]),
			},
		};

		await expect(
			assertNoPendingDeploymentOperation(prisma as never, "user-1", ["instance-1"]),
		).rejects.toThrow("unfinished undeploy");
	});

	it("blocks a new mutation when a durable pending state exists", async () => {
		const prisma = {
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([{ backup: backup("pending") }]) },
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
		};
		await expect(
			assertNoPendingDeploymentOperation(prisma as never, "user-1", ["instance-1"]),
		).rejects.toThrow("uncertain upstream result");
	});

	it("allows a fully verified operation", async () => {
		const prisma = {
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([{ backup: backup("applied") }]) },
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
		};
		await expect(
			assertNoPendingDeploymentOperation(prisma as never, "user-1", ["instance-1"]),
		).resolves.toBeUndefined();
	});

	it("fails closed when a current backup ledger is malformed", async () => {
		const malformed = backup("pending");
		malformed.backupData = JSON.stringify({ schemaVersion: 2, customFormatDeployments: [] });
		const prisma = {
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([{ backup: malformed }]) },
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
		};

		await expect(
			assertNoPendingDeploymentOperation(prisma as never, "user-1", ["instance-1"]),
		).rejects.toThrow("invalid deployment ledger");
	});

	it("does not treat a legacy array backup as a pending ledger", async () => {
		const prisma = {
			trashSyncHistory: {
				findMany: vi
					.fn()
					.mockResolvedValue([{ backup: { id: "legacy", backupData: JSON.stringify([]) } }]),
			},
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
		};

		await expect(
			assertNoPendingDeploymentOperation(prisma as never, "user-1", ["instance-1"]),
		).resolves.toBeUndefined();
	});

	it("blocks unrelated mutations while a score write is uncertain", async () => {
		const prisma = {
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
			instanceQualityProfileOverride: {
				findMany: vi.fn().mockResolvedValue([{ qualityProfileId: 4, customFormatId: 7 }]),
			},
		};

		await expect(
			assertNoPendingDeploymentOperation(prisma as never, "user-1", ["instance-1"]),
		).rejects.toThrow("score write has an uncertain upstream result");
	});

	it("allows an exact score-write retry to reconcile uncertain intent", async () => {
		const prisma = {
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
			instanceQualityProfileOverride: {
				findMany: vi.fn().mockResolvedValue([
					{
						qualityProfileId: 4,
						customFormatId: 7,
						intentOperation: "RESET_SCORE",
						intendedScore: 100,
					},
				]),
			},
		};

		await expect(
			assertNoPendingDeploymentOperation(prisma as never, "user-1", ["instance-1"], {
				qualityProfileId: 4,
				operation: "RESET_SCORE",
				scoreUpdates: [{ customFormatId: 7, score: 100 }],
			}),
		).resolves.toBeUndefined();
	});

	it.each([
		{
			name: "operation",
			retry: {
				qualityProfileId: 4,
				operation: "SET_SCORE" as const,
				scoreUpdates: [{ customFormatId: 7, score: 100 }],
			},
		},
		{
			name: "intended score",
			retry: {
				qualityProfileId: 4,
				operation: "RESET_SCORE" as const,
				scoreUpdates: [{ customFormatId: 7, score: 200 }],
			},
		},
		{
			name: "Custom Format set",
			retry: {
				qualityProfileId: 4,
				operation: "RESET_SCORE" as const,
				scoreUpdates: [{ customFormatId: 8, score: 100 }],
			},
		},
	])("blocks a retry whose $name does not match the durable intent", async ({ retry }) => {
		const prisma = {
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
			instanceQualityProfileOverride: {
				findMany: vi.fn().mockResolvedValue([
					{
						qualityProfileId: 4,
						customFormatId: 7,
						intentOperation: "RESET_SCORE",
						intendedScore: 100,
					},
				]),
			},
		};

		await expect(
			assertNoPendingDeploymentOperation(prisma as never, "user-1", ["instance-1"], retry),
		).rejects.toThrow("exact score update");
	});
});

describe("assertNoActiveDeploymentOwnership", () => {
	it("blocks a connection change that would strand an applied deployment", async () => {
		const prisma = {
			trashSyncHistory: {
				findMany: vi.fn().mockResolvedValue([{ backup: fullyAppliedBackup() }]),
			},
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
		};

		await expect(
			assertNoActiveDeploymentOwnership(prisma as never, "user-1", ["instance-1"]),
		).rejects.toThrow("active deployment ownership");
	});

	it("allows a connection change after all deployment ledgers are rolled back", async () => {
		const prisma = {
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
		};

		await expect(
			assertNoActiveDeploymentOwnership(prisma as never, "user-1", ["instance-1"]),
		).resolves.toBeUndefined();
	});
});

describe("reconcileInterruptedDeploymentHistories", () => {
	it("marks an interrupted undeploy partial without rewriting deployment status", async () => {
		const deploymentUpdate = vi.fn().mockResolvedValue({});
		const findMany = vi.fn().mockResolvedValue([
			{
				id: "deployment-undeploy",
				backupId: "backup-1",
				backup: fullyAppliedBackup(),
				status: "SUCCESS",
				undeployStatus: "IN_PROGRESS",
			},
		]);
		const prisma = {
			templateDeploymentHistory: { findMany, update: deploymentUpdate },
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
			$transaction: vi.fn(),
		};

		await expect(reconcileInterruptedDeploymentHistories(prisma as never)).resolves.toBe(1);
		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { OR: [{ status: "IN_PROGRESS" }, { undeployStatus: "IN_PROGRESS" }] },
			}),
		);
		expect(deploymentUpdate).toHaveBeenCalledWith({
			where: { id: "deployment-undeploy" },
			data: { undeployStatus: "PARTIAL" },
		});
	});

	it("marks an interrupted rollback partial without rewriting deployment status", async () => {
		const syncUpdate = vi.fn().mockResolvedValue({});
		const findMany = vi.fn().mockResolvedValue([
			{
				id: "sync-rollback",
				backupId: "backup-1",
				backup: fullyAppliedBackup(),
				rollbackStatus: "IN_PROGRESS",
			},
		]);
		const prisma = {
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
			trashSyncHistory: { findMany, update: syncUpdate },
			$transaction: vi.fn(),
		};

		await expect(reconcileInterruptedDeploymentHistories(prisma as never)).resolves.toBe(1);
		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					OR: [{ status: { in: ["IN_PROGRESS", "RUNNING"] } }, { rollbackStatus: "IN_PROGRESS" }],
				},
			}),
		);
		expect(syncUpdate).toHaveBeenCalledWith({
			where: { id: "sync-rollback" },
			data: { rollbackStatus: "PARTIAL" },
		});
	});

	it("atomically marks paired histories failed while preserving a pending safety gate", async () => {
		const deploymentUpdate = vi.fn().mockResolvedValue({});
		const syncUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
		const transaction = vi.fn(async (callback) =>
			callback({
				templateDeploymentHistory: { update: deploymentUpdate },
				trashSyncHistory: { updateMany: syncUpdateMany },
			}),
		);
		const prisma = {
			templateDeploymentHistory: {
				findMany: vi
					.fn()
					.mockResolvedValue([
						{ id: "deployment-1", backupId: "backup-1", backup: backup("pending") },
					]),
			},
			trashSyncHistory: {
				findMany: vi
					.fn()
					.mockResolvedValue([{ id: "sync-1", backupId: "backup-1", backup: backup("pending") }]),
			},
			$transaction: transaction,
		};

		await expect(reconcileInterruptedDeploymentHistories(prisma as never)).resolves.toBe(1);
		expect(transaction).toHaveBeenCalledTimes(1);
		expect(deploymentUpdate).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }),
		);
		expect(syncUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "FAILED",
					errorLog: expect.stringContaining("uncertain"),
				}),
			}),
		);
	});

	it("reconciles an orphan sync history even when no template history was created", async () => {
		const syncUpdate = vi.fn().mockResolvedValue({});
		const prisma = {
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
			trashSyncHistory: {
				findMany: vi
					.fn()
					.mockResolvedValue([{ id: "sync-1", backupId: "backup-1", backup: backup("applied") }]),
				update: syncUpdate,
			},
			$transaction: vi.fn(),
		};

		await expect(reconcileInterruptedDeploymentHistories(prisma as never)).resolves.toBe(1);
		expect(syncUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "sync-1" },
				data: expect.objectContaining({
					status: "PARTIAL_SUCCESS",
					configsApplied: 1,
					configsFailed: 1,
					appliedConfigs: JSON.stringify([{ name: "Foo", action: "updated" }]),
				}),
			}),
		);
	});

	it("reconstructs applied counters and details from a durable ledger", async () => {
		const deploymentUpdate = vi.fn().mockResolvedValue({});
		const syncUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
		const transaction = vi.fn(async (callback) =>
			callback({
				templateDeploymentHistory: { update: deploymentUpdate },
				trashSyncHistory: { updateMany: syncUpdateMany },
			}),
		);
		const durableBackup = fullyAppliedBackup();
		const prisma = {
			templateDeploymentHistory: {
				findMany: vi
					.fn()
					.mockResolvedValue([{ id: "deployment-1", backupId: "backup-1", backup: durableBackup }]),
			},
			trashSyncHistory: {
				findMany: vi
					.fn()
					.mockResolvedValue([{ id: "sync-1", backupId: "backup-1", backup: durableBackup }]),
			},
			$transaction: transaction,
		};
		const appliedConfigs = [
			{ name: "Created CF", action: "created" },
			{ name: "Updated CF", action: "updated" },
			{
				name: "HD-1080p",
				action: "updated",
				type: "quality_profile",
				id: 9,
			},
			{ name: "Naming configuration", action: "updated" },
		];

		await expect(reconcileInterruptedDeploymentHistories(prisma as never)).resolves.toBe(1);
		expect(deploymentUpdate).toHaveBeenCalledWith({
			where: { id: "deployment-1" },
			data: expect.objectContaining({
				status: "PARTIAL_SUCCESS",
				appliedCFs: 2,
				appliedConfigs: JSON.stringify(appliedConfigs),
			}),
		});
		expect(syncUpdateMany).toHaveBeenCalledWith({
			where: {
				backupId: "backup-1",
				status: { in: ["IN_PROGRESS", "RUNNING"] },
			},
			data: expect.objectContaining({
				status: "PARTIAL_SUCCESS",
				configsApplied: 4,
				configsFailed: 1,
				appliedConfigs: JSON.stringify(appliedConfigs),
			}),
		});
	});

	it("reconciles a RUNNING sync without a deployment backup", async () => {
		const syncUpdate = vi.fn().mockResolvedValue({});
		const findMany = vi
			.fn()
			.mockResolvedValue([{ id: "sync-running", backupId: null, backup: null }]);
		const prisma = {
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
			trashSyncHistory: { findMany, update: syncUpdate },
			$transaction: vi.fn(),
		};

		await expect(reconcileInterruptedDeploymentHistories(prisma as never)).resolves.toBe(1);
		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					OR: [{ status: { in: ["IN_PROGRESS", "RUNNING"] } }, { rollbackStatus: "IN_PROGRESS" }],
				},
			}),
		);
		expect(syncUpdate).toHaveBeenCalledWith({
			where: { id: "sync-running" },
			data: expect.objectContaining({
				status: "FAILED",
				completedAt: expect.any(Date),
				errorLog: expect.stringContaining("restarted"),
			}),
		});
	});

	it("uses a non-claiming failure when applied profile details are incomplete", async () => {
		const syncUpdate = vi.fn().mockResolvedValue({});
		const incomplete = fullyAppliedBackup();
		const backupData = JSON.parse(incomplete.backupData);
		backupData.customFormatDeployments = [];
		backupData.namingDeployment = null;
		backupData.qualityProfileDeployment.profileId = null;
		incomplete.backupData = JSON.stringify(backupData);
		const prisma = {
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
			trashSyncHistory: {
				findMany: vi
					.fn()
					.mockResolvedValue([{ id: "sync-1", backupId: "backup-1", backup: incomplete }]),
				update: syncUpdate,
			},
			$transaction: vi.fn(),
		};

		await expect(reconcileInterruptedDeploymentHistories(prisma as never)).resolves.toBe(1);
		expect(syncUpdate).toHaveBeenCalledWith({
			where: { id: "sync-1" },
			data: expect.not.objectContaining({
				configsApplied: expect.anything(),
				appliedConfigs: expect.anything(),
			}),
		});
		expect(syncUpdate).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }),
		);
	});
});
