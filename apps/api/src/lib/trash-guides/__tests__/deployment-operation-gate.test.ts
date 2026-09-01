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

function mixedAppliedAndPendingBackup() {
	const result = backup("pending");
	const state = JSON.parse(result.backupData);
	state.customFormatDeployments.unshift({
		beforeFormat: { id: 8, name: "Applied CF" },
		action: "updated",
		resourceId: 8,
		name: "Applied CF",
		status: "applied",
		postStateToken: "applied-post",
	});
	return { ...result, backupData: JSON.stringify(state) };
}

function mixedPendingAndIncompleteAppliedProfileBackup() {
	const result = mixedAppliedAndPendingBackup();
	const state = JSON.parse(result.backupData);
	state.qualityProfileDeployment = {
		beforeProfile: { id: 9, name: "HD-1080p" },
		status: "applied",
		action: "updated",
		profileId: 9,
		profileName: null,
		postStateToken: "profile-post",
	};
	return { ...result, backupData: JSON.stringify(state) };
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

	it.each([
		{
			label: "sync",
			syncRows: [
				{
					status: "RUNNING",
					rollbackStatus: null,
					backupId: "backup-1",
					backup: fullyAppliedBackup(),
				},
			],
			deploymentRows: [],
		},
		{
			label: "deployment",
			syncRows: [],
			deploymentRows: [
				{
					status: "IN_PROGRESS",
					undeployStatus: null,
					backupId: "backup-1",
					backup: fullyAppliedBackup(),
				},
			],
		},
	])("blocks a transient $label history even when its ledger is terminal", async (rows) => {
		const prisma = {
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue(rows.syncRows) },
			templateDeploymentHistory: {
				findMany: vi.fn().mockResolvedValue(rows.deploymentRows),
			},
		};

		await expect(
			assertNoPendingDeploymentOperation(prisma as never, "user-1", ["instance-1"]),
		).rejects.toThrow("uncertain upstream result");
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

	it("allows a terminal legacy history with no pending marker to start a reviewed deployment", async () => {
		const prisma = {
			trashSyncHistory: {
				findMany: vi
					.fn()
					.mockResolvedValue([
						{ status: "FAILED", rollbackStatus: null, backupId: null, backup: null },
					]),
			},
			templateDeploymentHistory: {
				findMany: vi
					.fn()
					.mockResolvedValue([
						{ status: "SUCCESS", undeployStatus: null, backupId: null, backup: null },
					]),
			},
		};

		await expect(
			assertNoPendingDeploymentOperation(prisma as never, "user-1", ["instance-1"]),
		).resolves.toBeUndefined();
	});

	it("blocks a transient sync whose backup relation is missing", async () => {
		const prisma = {
			trashSyncHistory: {
				findMany: vi
					.fn()
					.mockResolvedValue([
						{ status: "RUNNING", rollbackStatus: null, backupId: null, backup: null },
					]),
			},
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
		};

		await expect(
			assertNoPendingDeploymentOperation(prisma as never, "user-1", ["instance-1"]),
		).rejects.toThrow("uncertain upstream result");
	});

	it("excludes the wrapper sync that initiated the current deployment", async () => {
		const findSyncRows = vi.fn().mockResolvedValue([]);
		const prisma = {
			trashSyncHistory: { findMany: findSyncRows },
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
		};

		await expect(
			assertNoPendingDeploymentOperation(
				prisma as never,
				"user-1",
				["instance-1"],
				undefined,
				"sync-current",
			),
		).resolves.toBeUndefined();
		expect(findSyncRows).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: { not: "sync-current" } }),
			}),
		);
	});

	it("blocks a transient deployment whose backup relation is missing", async () => {
		const prisma = {
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
			templateDeploymentHistory: {
				findMany: vi.fn().mockResolvedValue([
					{
						status: "IN_PROGRESS",
						undeployStatus: null,
						backupId: null,
						backup: null,
					},
				]),
			},
		};

		await expect(
			assertNoPendingDeploymentOperation(prisma as never, "user-1", ["instance-1"]),
		).rejects.toThrow("uncertain upstream result");
	});

	it("blocks a partial history whose backup relation disappeared", async () => {
		const prisma = {
			trashSyncHistory: {
				findMany: vi
					.fn()
					.mockResolvedValue([
						{ status: "PARTIAL_SUCCESS", rollbackStatus: null, backupId: "missing", backup: null },
					]),
			},
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
		};

		await expect(
			assertNoPendingDeploymentOperation(prisma as never, "user-1", ["instance-1"]),
		).rejects.toThrow("uncertain upstream result");
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
						instanceId: "instance-1",
						qualityProfileId: 4,
						customFormatId: 7,
						intentOperation: "RESET_SCORE",
						intendedScore: 100,
						connectionGeneration: 3,
						connectionStateToken: "connection-1",
					},
				]),
			},
		};

		await expect(
			assertNoPendingDeploymentOperation(prisma as never, "user-1", ["instance-1"], {
				qualityProfileId: 4,
				operation: "RESET_SCORE",
				scoreUpdates: [{ customFormatId: 7, score: 100 }],
				connectionBindings: [
					{
						instanceId: "instance-1",
						connectionGeneration: 3,
						connectionStateToken: "connection-1",
					},
				],
			}),
		).resolves.toBeUndefined();
	});

	it("does not let an exact retry for one profile bypass another uncertain profile", async () => {
		const prisma = {
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
			instanceQualityProfileOverride: {
				findMany: vi.fn().mockResolvedValue([
					{
						instanceId: "instance-1",
						qualityProfileId: 4,
						customFormatId: 7,
						intentOperation: "RESET_SCORE",
						intendedScore: 100,
						connectionGeneration: 3,
						connectionStateToken: "connection-1",
					},
					{
						instanceId: "instance-1",
						qualityProfileId: 5,
						customFormatId: 8,
						intentOperation: "SET_SCORE",
						intendedScore: 200,
						connectionGeneration: 3,
						connectionStateToken: "connection-1",
					},
				]),
			},
		};

		await expect(
			assertNoPendingDeploymentOperation(prisma as never, "user-1", ["instance-1"], {
				qualityProfileId: 4,
				operation: "RESET_SCORE",
				scoreUpdates: [{ customFormatId: 7, score: 100 }],
				connectionBindings: [
					{
						instanceId: "instance-1",
						connectionGeneration: 3,
						connectionStateToken: "connection-1",
					},
				],
			}),
		).rejects.toThrow("exact score update");
	});

	it("allows one exact retry across duplicate records for the same physical endpoint", async () => {
		const uncertain = (instanceId: string, token: string) => ({
			instanceId,
			qualityProfileId: 4,
			customFormatId: 7,
			intentOperation: "RESET_SCORE",
			intendedScore: 100,
			connectionGeneration: 3,
			connectionStateToken: token,
		});
		const prisma = {
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
			instanceQualityProfileOverride: {
				findMany: vi
					.fn()
					.mockResolvedValue([
						uncertain("instance-1", "connection-1"),
						uncertain("instance-alias", "connection-alias"),
					]),
			},
		};

		await expect(
			assertNoPendingDeploymentOperation(
				prisma as never,
				"user-1",
				["instance-1", "instance-alias"],
				{
					qualityProfileId: 4,
					operation: "RESET_SCORE",
					scoreUpdates: [{ customFormatId: 7, score: 100 }],
					connectionBindings: [
						{
							instanceId: "instance-1",
							connectionGeneration: 3,
							connectionStateToken: "connection-1",
						},
						{
							instanceId: "instance-alias",
							connectionGeneration: 3,
							connectionStateToken: "connection-alias",
						},
					],
				},
			),
		).resolves.toBeUndefined();
	});

	it("blocks a retry bound to stale connection state", async () => {
		const prisma = {
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
			instanceQualityProfileOverride: {
				findMany: vi.fn().mockResolvedValue([
					{
						instanceId: "instance-1",
						qualityProfileId: 4,
						customFormatId: 7,
						intentOperation: "RESET_SCORE",
						intendedScore: 100,
						connectionGeneration: 2,
						connectionStateToken: "stale-connection",
					},
				]),
			},
		};

		await expect(
			assertNoPendingDeploymentOperation(prisma as never, "user-1", ["instance-1"], {
				qualityProfileId: 4,
				operation: "RESET_SCORE",
				scoreUpdates: [{ customFormatId: 7, score: 100 }],
				connectionBindings: [
					{
						instanceId: "instance-1",
						connectionGeneration: 3,
						connectionStateToken: "current-connection",
					},
				],
			}),
		).rejects.toThrow("exact score update");
	});

	it.each([
		{
			name: "operation",
			retry: {
				qualityProfileId: 4,
				operation: "SET_SCORE" as const,
				scoreUpdates: [{ customFormatId: 7, score: 100 }],
				connectionBindings: [
					{
						instanceId: "instance-1",
						connectionGeneration: 3,
						connectionStateToken: "connection-1",
					},
				],
			},
		},
		{
			name: "intended score",
			retry: {
				qualityProfileId: 4,
				operation: "RESET_SCORE" as const,
				scoreUpdates: [{ customFormatId: 7, score: 200 }],
				connectionBindings: [
					{
						instanceId: "instance-1",
						connectionGeneration: 3,
						connectionStateToken: "connection-1",
					},
				],
			},
		},
		{
			name: "Custom Format set",
			retry: {
				qualityProfileId: 4,
				operation: "RESET_SCORE" as const,
				scoreUpdates: [{ customFormatId: 8, score: 100 }],
				connectionBindings: [
					{
						instanceId: "instance-1",
						connectionGeneration: 3,
						connectionStateToken: "connection-1",
					},
				],
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
						instanceId: "instance-1",
						connectionGeneration: 3,
						connectionStateToken: "connection-1",
					},
				]),
			},
		};

		await expect(
			assertNoPendingDeploymentOperation(prisma as never, "user-1", ["instance-1"], retry),
		).rejects.toThrow("exact score update");
	});
});

describe("reconcileInterruptedDeploymentHistories identified pending mutations", () => {
	it("preserves checkpointed CF create, CF update, and profile update audit evidence", async () => {
		const createdProfileBackup = {
			id: "backup-created-profile",
			backupData: JSON.stringify({
				schemaVersion: 2,
				endpointKey: "user-1:RADARR:http://radarr:7878/",
				connectionStateToken: "connection",
				customFormats: [],
				customFormatDeployments: [
					{
						beforeFormat: null,
						action: "created",
						resourceId: 7,
						name: "Created CF",
						status: "pending",
						postStateToken: "exact-created-format-token",
						intendedPostStateToken: "different-intended-token",
					},
					{
						beforeFormat: { id: 8, name: "Updated CF" },
						action: "updated",
						resourceId: 8,
						name: "Updated CF",
						status: "pending",
						postStateToken: "exact-updated-format-token",
						intendedPostStateToken: "different-intended-token",
					},
				],
				managedCustomFormats: [],
				managedCustomFormatsCaptured: false,
				qualityProfileDeployment: {
					beforeProfile: { id: 42, name: "HD-1080p", formatItems: [] },
					status: "pending",
					action: "updated",
					profileId: 42,
					profileName: "HD-1080p",
					postStateToken: "exact-created-profile-token",
					intendedPostStateToken: "different-intended-token",
				},
				namingDeployment: null,
			}),
		};
		const deploymentRecord = {
			id: "deployment-created-profile",
			backupId: createdProfileBackup.id,
			status: "IN_PROGRESS",
			undeployStatus: null,
			backup: createdProfileBackup,
		};
		const syncRecord = {
			id: "sync-created-profile",
			backupId: createdProfileBackup.id,
			status: "RUNNING",
			rollbackStatus: null,
			backup: createdProfileBackup,
		};
		const deploymentUpdateMany = vi.fn(
			async (args: { where: { status: string }; data: { status: string } }) => {
				if (args.where.status !== deploymentRecord.status) return { count: 0 };
				deploymentRecord.status = args.data.status;
				return { count: 1 };
			},
		);
		const syncUpdateMany = vi.fn(
			async (args: { where: { status: { in: string[] } | string }; data: { status: string } }) => {
				const expectedStatuses =
					typeof args.where.status === "string" ? [args.where.status] : args.where.status.in;
				if (!expectedStatuses.includes(syncRecord.status)) return { count: 0 };
				syncRecord.status = args.data.status;
				return { count: 1 };
			},
		);
		const prisma = {
			templateDeploymentHistory: {
				findMany: vi.fn().mockImplementation(async () => [deploymentRecord]),
			},
			trashSyncHistory: {
				findMany: vi.fn().mockImplementation(async () => [syncRecord]),
			},
			$transaction: vi.fn(async (callback) =>
				callback({
					templateDeploymentHistory: { updateMany: deploymentUpdateMany },
					trashSyncHistory: { updateMany: syncUpdateMany },
				}),
			),
		};

		await expect(reconcileInterruptedDeploymentHistories(prisma as never)).resolves.toBe(1);
		const appliedFormat = {
			name: "Created CF",
			action: "created",
			type: "custom_format",
		};
		const updatedFormat = {
			name: "Updated CF",
			action: "updated",
			type: "custom_format",
		};
		const appliedProfile = {
			name: "HD-1080p",
			action: "updated",
			type: "quality_profile",
			id: 42,
		};
		expect(deploymentUpdateMany).toHaveBeenCalledWith({
			where: { id: "deployment-created-profile", status: "IN_PROGRESS" },
			data: expect.objectContaining({
				status: "UNCERTAIN",
				appliedCFs: 2,
				appliedConfigs: JSON.stringify([appliedFormat, updatedFormat, appliedProfile]),
			}),
		});
		expect(syncUpdateMany).toHaveBeenCalledWith({
			where: {
				backupId: createdProfileBackup.id,
				status: { in: ["IN_PROGRESS", "RUNNING"] },
			},
			data: expect.objectContaining({
				status: "UNCERTAIN",
				configsApplied: 3,
				configsFailed: 0,
				appliedConfigs: JSON.stringify([appliedFormat, updatedFormat, appliedProfile]),
			}),
		});

		await expect(reconcileInterruptedDeploymentHistories(prisma as never)).resolves.toBe(0);
		expect(deploymentUpdateMany).toHaveBeenCalledTimes(2);
		expect(syncUpdateMany).toHaveBeenCalledOnce();

		await expect(
			assertNoPendingDeploymentOperation(
				{
					trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
					templateDeploymentHistory: {
						findMany: vi.fn().mockResolvedValue([
							{
								status: "UNCERTAIN",
								backup: createdProfileBackup,
							},
						]),
					},
					instanceQualityProfileOverride: { findMany: vi.fn().mockResolvedValue([]) },
				} as never,
				"user-1",
				["instance-1"],
			),
		).rejects.toThrow("uncertain upstream result");
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

	it("blocks connection replacement when an unrolled history lost its backup relation", async () => {
		const prisma = {
			trashSyncHistory: {
				findMany: vi
					.fn()
					.mockResolvedValue([{ status: "SUCCESS", backupId: "missing", backup: null }]),
			},
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
		};

		await expect(
			assertNoActiveDeploymentOwnership(prisma as never, "user-1", ["instance-1"]),
		).rejects.toThrow("active deployment ownership");
	});
});

describe("reconcileInterruptedDeploymentHistories", () => {
	it.each([
		{ label: "missing", backup: null },
		{ label: "invalid", backup: { id: "backup-invalid", backupData: "not-json" } },
		{ label: "terminal", backup: fullyAppliedBackup() },
	])(
		"keeps a restarted $label-ledger operation blocked after reconciliation",
		async ({ backup: interruptedBackup }) => {
			const deploymentRow = {
				id: "deployment-uncertain",
				status: "IN_PROGRESS",
				undeployStatus: null,
				backupId: interruptedBackup?.id ?? null,
				backup: interruptedBackup,
			};
			const syncRow = {
				id: "sync-uncertain",
				status: "RUNNING",
				rollbackStatus: null,
				backupId: interruptedBackup?.id ?? null,
				backup: interruptedBackup,
			};
			const updateDeployment = vi.fn(async ({ where, data }) => {
				if (deploymentRow.id !== where.id || deploymentRow.status !== where.status) {
					return { count: 0 };
				}
				Object.assign(deploymentRow, data);
				return { count: 1 };
			});
			const updateSync = vi.fn(async ({ where, data }) => {
				const statusMatches = Array.isArray(where.status?.in)
					? where.status.in.includes(syncRow.status)
					: syncRow.status === where.status;
				if (
					(where.id !== undefined && syncRow.id !== where.id) ||
					(where.backupId !== undefined && syncRow.backupId !== where.backupId) ||
					!statusMatches
				) {
					return { count: 0 };
				}
				Object.assign(syncRow, data);
				return { count: 1 };
			});
			const prisma = {
				templateDeploymentHistory: {
					findMany: vi.fn().mockResolvedValue([deploymentRow]),
					updateMany: updateDeployment,
				},
				trashSyncHistory: {
					findMany: vi.fn().mockResolvedValue([syncRow]),
					updateMany: updateSync,
				},
				$transaction: vi.fn(async (callback) =>
					callback({
						templateDeploymentHistory: { updateMany: updateDeployment },
						trashSyncHistory: { updateMany: updateSync },
					}),
				),
			};

			await expect(reconcileInterruptedDeploymentHistories(prisma as never)).resolves.toBe(
				interruptedBackup ? 1 : 2,
			);
			expect(deploymentRow.status).toBe("UNCERTAIN");
			expect(syncRow.status).toBe("UNCERTAIN");
			await expect(
				assertNoPendingDeploymentOperation(prisma as never, "user-1", ["instance-1"]),
			).rejects.toThrow("uncertain upstream result");
		},
	);

	it("marks an interrupted undeploy partial without rewriting deployment status", async () => {
		const deploymentUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
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
			templateDeploymentHistory: { findMany, updateMany: deploymentUpdateMany },
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
			$transaction: vi.fn(),
		};

		await expect(reconcileInterruptedDeploymentHistories(prisma as never)).resolves.toBe(1);
		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { OR: [{ status: "IN_PROGRESS" }, { undeployStatus: "IN_PROGRESS" }] },
			}),
		);
		expect(deploymentUpdateMany).toHaveBeenCalledWith({
			where: { id: "deployment-undeploy", undeployStatus: "IN_PROGRESS" },
			data: { undeployStatus: "PARTIAL" },
		});
	});

	it("marks an interrupted rollback partial without rewriting deployment status", async () => {
		const syncUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
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
			trashSyncHistory: { findMany, updateMany: syncUpdateMany },
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
		expect(syncUpdateMany).toHaveBeenCalledWith({
			where: { id: "sync-rollback", rollbackStatus: "IN_PROGRESS" },
			data: { rollbackStatus: "PARTIAL" },
		});
	});

	it("atomically marks paired histories uncertain while preserving applied audit evidence", async () => {
		const deploymentUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
		const syncUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
		const transaction = vi.fn(async (callback) =>
			callback({
				templateDeploymentHistory: { updateMany: deploymentUpdateMany },
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
		expect(deploymentUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "deployment-1", status: "IN_PROGRESS" },
				data: expect.objectContaining({
					status: "UNCERTAIN",
					appliedCFs: 0,
					appliedConfigs: "[]",
				}),
			}),
		);
		expect(syncUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "UNCERTAIN",
					configsApplied: 0,
					configsFailed: 0,
					appliedConfigs: "[]",
					errorLog: expect.stringContaining("uncertain"),
				}),
			}),
		);
	});

	it("keeps mixed applied and pending histories uncertain while preserving proven audit", async () => {
		const interruptedBackup = mixedAppliedAndPendingBackup();
		const deploymentUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
		const syncUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
		const prisma = {
			templateDeploymentHistory: {
				findMany: vi
					.fn()
					.mockResolvedValue([
						{ id: "deployment-1", backupId: "backup-1", backup: interruptedBackup },
					]),
			},
			trashSyncHistory: {
				findMany: vi
					.fn()
					.mockResolvedValue([{ id: "sync-1", backupId: "backup-1", backup: interruptedBackup }]),
			},
			$transaction: vi.fn(async (callback) =>
				callback({
					templateDeploymentHistory: { updateMany: deploymentUpdateMany },
					trashSyncHistory: { updateMany: syncUpdateMany },
				}),
			),
		};
		const appliedConfigs = [{ name: "Applied CF", action: "updated", type: "custom_format" }];

		await expect(reconcileInterruptedDeploymentHistories(prisma as never)).resolves.toBe(1);
		expect(deploymentUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "UNCERTAIN",
					appliedCFs: 1,
					appliedConfigs: JSON.stringify(appliedConfigs),
				}),
			}),
		);
		expect(syncUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "UNCERTAIN",
					configsApplied: 1,
					configsFailed: 0,
					appliedConfigs: JSON.stringify(appliedConfigs),
				}),
			}),
		);
	});

	it("lets pending state dominate incomplete applied-profile audit metadata", async () => {
		const interruptedBackup = mixedPendingAndIncompleteAppliedProfileBackup();
		const deploymentUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
		const syncUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
		const prisma = {
			templateDeploymentHistory: {
				findMany: vi
					.fn()
					.mockResolvedValue([
						{ id: "deployment-1", backupId: "backup-1", backup: interruptedBackup },
					]),
			},
			trashSyncHistory: {
				findMany: vi
					.fn()
					.mockResolvedValue([{ id: "sync-1", backupId: "backup-1", backup: interruptedBackup }]),
			},
			$transaction: vi.fn(async (callback) =>
				callback({
					templateDeploymentHistory: { updateMany: deploymentUpdateMany },
					trashSyncHistory: { updateMany: syncUpdateMany },
				}),
			),
		};
		const appliedConfigs = [{ name: "Applied CF", action: "updated", type: "custom_format" }];

		await expect(reconcileInterruptedDeploymentHistories(prisma as never)).resolves.toBe(1);
		expect(deploymentUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "UNCERTAIN",
					appliedCFs: 1,
					appliedConfigs: JSON.stringify(appliedConfigs),
				}),
			}),
		);
		expect(syncUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "UNCERTAIN",
					configsApplied: 1,
					appliedConfigs: JSON.stringify(appliedConfigs),
				}),
			}),
		);
	});

	it("reconciles an orphan sync history even when no template history was created", async () => {
		const syncUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
		const prisma = {
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
			trashSyncHistory: {
				findMany: vi
					.fn()
					.mockResolvedValue([{ id: "sync-1", backupId: "backup-1", backup: backup("applied") }]),
				updateMany: syncUpdateMany,
			},
			$transaction: vi.fn(),
		};

		await expect(reconcileInterruptedDeploymentHistories(prisma as never)).resolves.toBe(1);
		expect(syncUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "sync-1", status: { in: ["IN_PROGRESS", "RUNNING"] } },
				data: expect.objectContaining({
					status: "UNCERTAIN",
					configsApplied: 1,
					configsFailed: 0,
					appliedConfigs: JSON.stringify([
						{ name: "Foo", action: "updated", type: "custom_format" },
					]),
				}),
			}),
		);
	});

	it("keeps orphan pending-ledger counters uncertain instead of failed", async () => {
		const syncUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
		const prisma = {
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
			trashSyncHistory: {
				findMany: vi
					.fn()
					.mockResolvedValue([{ id: "sync-1", backupId: "backup-1", backup: backup("pending") }]),
				updateMany: syncUpdateMany,
			},
			$transaction: vi.fn(),
		};

		await expect(reconcileInterruptedDeploymentHistories(prisma as never)).resolves.toBe(1);
		expect(syncUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "UNCERTAIN",
					configsApplied: 0,
					configsFailed: 0,
					appliedConfigs: "[]",
				}),
			}),
		);
	});

	it("reconstructs applied counters and details from a durable ledger", async () => {
		const deploymentUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
		const syncUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
		const transaction = vi.fn(async (callback) =>
			callback({
				templateDeploymentHistory: { updateMany: deploymentUpdateMany },
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
			{ name: "Created CF", action: "created", type: "custom_format" },
			{ name: "Updated CF", action: "updated", type: "custom_format" },
			{
				name: "HD-1080p",
				action: "updated",
				type: "quality_profile",
				id: 9,
			},
			{ name: "Naming configuration", action: "updated", type: "naming" },
		];

		await expect(reconcileInterruptedDeploymentHistories(prisma as never)).resolves.toBe(1);
		expect(deploymentUpdateMany).toHaveBeenCalledWith({
			where: { id: "deployment-1", status: "IN_PROGRESS" },
			data: expect.objectContaining({
				status: "UNCERTAIN",
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
				status: "UNCERTAIN",
				configsApplied: 4,
				configsFailed: 0,
				appliedConfigs: JSON.stringify(appliedConfigs),
			}),
		});
	});

	it("keeps a legacy RUNNING sync without a linked ledger uncertain", async () => {
		const syncUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
		const findMany = vi
			.fn()
			.mockResolvedValue([{ id: "sync-running", status: "RUNNING", backupId: null, backup: null }]);
		const prisma = {
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
			trashSyncHistory: { findMany, updateMany: syncUpdateMany },
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
		expect(syncUpdateMany).toHaveBeenCalledWith({
			where: { id: "sync-running", status: { in: ["IN_PROGRESS", "RUNNING"] } },
			data: expect.objectContaining({
				status: "UNCERTAIN",
				completedAt: expect.any(Date),
				errorLog: expect.stringContaining("upstream result is uncertain"),
			}),
		});
	});

	it("marks recovery uncertain when applied profile details are incomplete", async () => {
		const syncUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
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
				updateMany: syncUpdateMany,
			},
			$transaction: vi.fn(),
		};

		await expect(reconcileInterruptedDeploymentHistories(prisma as never)).resolves.toBe(1);
		expect(syncUpdateMany).toHaveBeenCalledWith({
			where: { id: "sync-1", status: { in: ["IN_PROGRESS", "RUNNING"] } },
			data: expect.not.objectContaining({
				configsApplied: expect.anything(),
				appliedConfigs: expect.anything(),
			}),
		});
		expect(syncUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "UNCERTAIN",
					errorLog: expect.stringContaining("upstream result is uncertain"),
				}),
			}),
		);
	});

	it("does not overwrite a deployment that became terminal before reconciliation", async () => {
		const deploymentUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
		const pairedSyncUpdateMany = vi.fn();
		const transaction = vi.fn(async (callback) =>
			callback({
				templateDeploymentHistory: { updateMany: deploymentUpdateMany },
				trashSyncHistory: { updateMany: pairedSyncUpdateMany },
			}),
		);
		const prisma = {
			templateDeploymentHistory: {
				findMany: vi
					.fn()
					.mockResolvedValue([
						{ id: "deployment-race", backupId: "backup-1", backup: backup("pending") },
					]),
			},
			trashSyncHistory: {
				findMany: vi
					.fn()
					.mockResolvedValue([
						{ id: "sync-pair", backupId: "backup-1", backup: backup("pending") },
					]),
				updateMany: pairedSyncUpdateMany,
			},
			$transaction: transaction,
		};

		await expect(reconcileInterruptedDeploymentHistories(prisma as never)).resolves.toBe(0);
		expect(deploymentUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "deployment-race", status: "IN_PROGRESS" },
			}),
		);
		expect(pairedSyncUpdateMany).not.toHaveBeenCalled();
	});

	it("does not overwrite an undeploy that became terminal before reconciliation", async () => {
		const deploymentUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
		const prisma = {
			templateDeploymentHistory: {
				findMany: vi.fn().mockResolvedValue([
					{
						id: "undeploy-race",
						backupId: "backup-1",
						status: "SUCCESS",
						undeployStatus: "IN_PROGRESS",
						backup: fullyAppliedBackup(),
					},
				]),
				updateMany: deploymentUpdateMany,
			},
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
			$transaction: vi.fn(),
		};

		await expect(reconcileInterruptedDeploymentHistories(prisma as never)).resolves.toBe(0);
		expect(deploymentUpdateMany).toHaveBeenCalledWith({
			where: { id: "undeploy-race", undeployStatus: "IN_PROGRESS" },
			data: { undeployStatus: "PARTIAL" },
		});
	});

	it("does not overwrite a rollback that became terminal before reconciliation", async () => {
		const syncUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
		const prisma = {
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
			trashSyncHistory: {
				findMany: vi.fn().mockResolvedValue([
					{
						id: "rollback-race",
						backupId: "backup-1",
						rollbackStatus: "IN_PROGRESS",
						backup: fullyAppliedBackup(),
					},
				]),
				updateMany: syncUpdateMany,
			},
			$transaction: vi.fn(),
		};

		await expect(reconcileInterruptedDeploymentHistories(prisma as never)).resolves.toBe(0);
		expect(syncUpdateMany).toHaveBeenCalledWith({
			where: { id: "rollback-race", rollbackStatus: "IN_PROGRESS" },
			data: { rollbackStatus: "PARTIAL" },
		});
	});

	it("does not overwrite an orphan sync that became terminal before reconciliation", async () => {
		const syncUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
		const prisma = {
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
			trashSyncHistory: {
				findMany: vi
					.fn()
					.mockResolvedValue([
						{ id: "sync-race", backupId: "backup-1", backup: backup("applied") },
					]),
				updateMany: syncUpdateMany,
			},
			$transaction: vi.fn(),
		};

		await expect(reconcileInterruptedDeploymentHistories(prisma as never)).resolves.toBe(0);
		expect(syncUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "sync-race", status: { in: ["IN_PROGRESS", "RUNNING"] } },
			}),
		);
	});
});
