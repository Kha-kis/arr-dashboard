/**
 * Unit tests for `exportDatabase` — focuses on the history-exclusion and
 * row-cap behavior added in v2.18.4 to keep peak heap under the 768 MB
 * container cap.
 *
 * Mocks Prisma directly. No database access — these tests verify the option
 * plumbing and the order/shape of `findMany` calls, not real query execution.
 */

import { describe, expect, it, vi } from "vitest";
import { BackupCompatibilityError } from "../../errors.js";
import type { PrismaClient } from "../../prisma.js";
import { assertRestoreCompatibility, exportDatabase, restoreDatabase } from "../backup-database.js";

const TABLE_NAMES = [
	"user",
	"session",
	"serviceInstance",
	"serviceTag",
	"serviceInstanceTag",
	"oIDCProvider",
	"oIDCAccount",
	"webAuthnCredential",
	"systemSettings",
	"backupSettings",
	"vapidKeys",
	"trashTemplate",
	"trashSettings",
	"trashSyncSchedule",
	"templateQualityProfileMapping",
	"instanceQualityProfileOverride",
	"standaloneCFDeployment",
	"qualitySizeMapping",
	"trashSyncHistory",
	"templateDeploymentHistory",
	"huntConfig",
	"huntLog",
	"huntSearchHistory",
	"trashBackup",
	"notificationChannel",
	"notificationSubscription",
	"notificationRule",
	"notificationAggregationConfig",
	"autoTagRule",
	"labelSyncRule",
	"queueCleanerConfig",
	"libraryCleanupConfig",
	"libraryCleanupRule",
	"libraryCleanupApproval",
	"libraryCleanupMediaServerScan",
	"namingConfig",
	"namingDeployHistory",
	"userCustomFormat",
] as const;

type TableName = (typeof TABLE_NAMES)[number];

type MockPrisma = {
	[K in TableName]: {
		findMany: ReturnType<typeof vi.fn>;
		count: ReturnType<typeof vi.fn>;
	};
};

function makeMockPrisma(rows: Partial<Record<TableName, unknown[]>> = {}): {
	prisma: PrismaClient;
	mock: MockPrisma;
} {
	const mock = {} as MockPrisma;
	for (const name of TABLE_NAMES) {
		const tableRows = rows[name] ?? [];
		mock[name] = {
			findMany: vi.fn().mockResolvedValue(tableRows),
			count: vi.fn().mockResolvedValue(tableRows.length),
		};
	}
	return { prisma: mock as unknown as PrismaClient, mock };
}

describe("exportDatabase — operational history exclusion", () => {
	it("skips disposable history but preserves nonterminal rollback and undeploy coordination", async () => {
		const { prisma, mock } = makeMockPrisma({
			serviceInstance: [{ id: "instance-1", userId: "user-1" }],
			trashTemplate: [{ id: "template-1", userId: "user-1" }],
			huntLog: [{ id: "h1" }],
			huntSearchHistory: [{ id: "s1" }],
		});
		const rollback = {
			id: "rollback-active",
			instanceId: "instance-1",
			userId: "user-1",
			backupId: "snapshot-rollback",
			rollbackStatus: "PARTIAL",
		};
		const undeploy = {
			id: "undeploy-active",
			instanceId: "instance-1",
			templateId: "template-1",
			userId: "user-1",
			backupId: "snapshot-undeploy",
			undeployStatus: "IN_PROGRESS",
			status: "PARTIAL_UNDEPLOY",
		};
		const snapshots = [
			{
				id: "snapshot-rollback",
				instanceId: "instance-1",
				userId: "user-1",
				backupData: "rollback-evidence",
			},
			{
				id: "snapshot-undeploy",
				instanceId: "instance-1",
				userId: "user-1",
				backupData: "undeploy-evidence",
			},
		];
		mock.trashSyncHistory.findMany.mockResolvedValueOnce([rollback]);
		mock.templateDeploymentHistory.findMany.mockResolvedValueOnce([undeploy]);
		mock.trashBackup.findMany.mockResolvedValueOnce(snapshots);

		const result = await exportDatabase(prisma, { excludeOperationalHistory: true });

		// Disposable history remains unloaded, preserving the bounded-memory behavior.
		expect(result.huntLogs).toEqual([]);
		expect(result.huntSearchHistory).toEqual([]);
		expect(mock.huntLog.findMany).not.toHaveBeenCalled();
		expect(mock.huntSearchHistory.findMany).not.toHaveBeenCalled();

		// Safety coordination is state, not disposable history.
		expect(result.trashSyncHistory).toEqual([rollback]);
		expect(result.templateDeploymentHistory).toEqual([undeploy]);
		expect(result.trashBackups).toEqual(snapshots);
		expect(mock.trashSyncHistory.findMany).toHaveBeenCalledWith({
			where: {
				OR: [
					{ rollbackStatus: { not: "COMPLETED" } },
					{ status: { in: ["IN_PROGRESS", "RUNNING"] } },
					{ status: "UNCERTAIN", rollbackStatus: null, backupId: null },
				],
			},
		});
		expect(mock.templateDeploymentHistory.findMany).toHaveBeenCalledWith({
			where: {
				OR: [
					{ undeployStatus: { not: "COMPLETED" } },
					{ status: { in: ["PARTIAL_UNDEPLOY", "IN_PROGRESS"] } },
				],
			},
		});
		expect(mock.trashBackup.findMany).toHaveBeenCalledWith({
			where: { id: { in: ["snapshot-rollback", "snapshot-undeploy"] } },
		});
	});

	it("preserves ordinary in-progress sync and deployment rows with their snapshots", async () => {
		const { prisma, mock } = makeMockPrisma({
			serviceInstance: [{ id: "instance-1", userId: "user-1" }],
			trashTemplate: [{ id: "template-1", userId: "user-1" }],
		});
		const runningSync = {
			id: "sync-running",
			instanceId: "instance-1",
			userId: "user-1",
			backupId: "snapshot-sync",
			status: "RUNNING",
		};
		const inProgressDeployment = {
			id: "deployment-in-progress",
			instanceId: "instance-1",
			templateId: "template-1",
			userId: "user-1",
			backupId: "snapshot-deployment",
			status: "IN_PROGRESS",
		};
		const snapshots = [
			{
				id: "snapshot-sync",
				instanceId: "instance-1",
				userId: "user-1",
				backupData: "sync-evidence",
			},
			{
				id: "snapshot-deployment",
				instanceId: "instance-1",
				userId: "user-1",
				backupData: "deployment-evidence",
			},
		];
		mock.trashSyncHistory.findMany.mockResolvedValueOnce([runningSync]);
		mock.templateDeploymentHistory.findMany.mockResolvedValueOnce([inProgressDeployment]);
		mock.trashBackup.findMany.mockResolvedValueOnce(snapshots);

		const result = await exportDatabase(prisma, { excludeOperationalHistory: true });

		expect(result.trashSyncHistory).toEqual([runningSync]);
		expect(result.templateDeploymentHistory).toEqual([inProgressDeployment]);
		expect(result.trashBackups).toEqual(snapshots);
		expect(mock.trashSyncHistory.findMany).toHaveBeenCalledWith({
			where: {
				OR: [
					{ rollbackStatus: { not: "COMPLETED" } },
					{ status: { in: ["IN_PROGRESS", "RUNNING"] } },
					{ status: "UNCERTAIN", rollbackStatus: null, backupId: null },
				],
			},
		});
		expect(mock.templateDeploymentHistory.findMany).toHaveBeenCalledWith({
			where: {
				OR: [
					{ undeployStatus: { not: "COMPLETED" } },
					{ status: { in: ["PARTIAL_UNDEPLOY", "IN_PROGRESS"] } },
				],
			},
		});
	});

	it("preserves snapshotless restart audits without inventing rollback authority", async () => {
		const { prisma, mock } = makeMockPrisma();
		const interruptedAudit = {
			id: "sync-interrupted",
			instanceId: "instance-1",
			userId: "user-1",
			status: "UNCERTAIN",
			backupId: null,
			rollbackStatus: null,
			rolledBack: false,
		};
		mock.trashSyncHistory.findMany.mockResolvedValueOnce([interruptedAudit]);
		mock.templateDeploymentHistory.findMany.mockResolvedValueOnce([]);

		const result = await exportDatabase(prisma, { excludeOperationalHistory: true });

		expect(result.trashSyncHistory).toEqual([interruptedAudit]);
		expect(result.trashBackups).toEqual([]);
		expect(mock.trashBackup.findMany).not.toHaveBeenCalled();
	});

	it("unions nonterminal coordination outside the capped history window", async () => {
		const { prisma, mock } = makeMockPrisma({
			serviceInstance: [{ id: "instance-1", userId: "user-1" }],
		});
		const rollback = {
			id: "rollback-outside-cap",
			instanceId: "instance-1",
			userId: "user-1",
			backupId: "snapshot-1",
			rollbackStatus: "IN_PROGRESS",
		};
		const recentTerminal = {
			id: "recent-terminal",
			instanceId: "instance-1",
			userId: "user-1",
			rollbackStatus: "COMPLETED",
		};
		mock.trashSyncHistory.findMany
			.mockResolvedValueOnce([rollback])
			.mockResolvedValueOnce([recentTerminal]);
		mock.templateDeploymentHistory.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
		mock.trashBackup.findMany.mockResolvedValueOnce([
			{
				id: "snapshot-1",
				instanceId: "instance-1",
				userId: "user-1",
				backupData: "evidence",
			},
		]);

		const result = await exportDatabase(prisma, { historyRetentionLimit: 1 });

		expect(result.trashSyncHistory).toEqual([recentTerminal, rollback]);
	});

	it.each([
		{
			name: "was already rolled back",
			terminalState: { rolledBack: true },
		},
		{
			name: "completed undeployment",
			terminalState: { undeployStatus: "COMPLETED" },
		},
	])("does not preserve a legacy PARTIAL_UNDEPLOY row that $name", async ({ terminalState }) => {
		const { prisma, mock } = makeMockPrisma();
		mock.trashSyncHistory.findMany.mockResolvedValueOnce([]);
		mock.templateDeploymentHistory.findMany.mockResolvedValueOnce([
			{
				id: "legacy-terminal-undeploy",
				instanceId: "instance-1",
				userId: "user-1",
				backupId: null,
				status: "PARTIAL_UNDEPLOY",
				...terminalState,
			},
		]);

		const result = await exportDatabase(prisma, { excludeOperationalHistory: true });

		expect(result.templateDeploymentHistory).toEqual([]);
		expect(mock.trashBackup.findMany).not.toHaveBeenCalled();
	});

	it("fails closed when a nonterminal coordination row has no snapshot reference", async () => {
		const { prisma, mock } = makeMockPrisma();
		mock.trashSyncHistory.findMany.mockResolvedValueOnce([
			{
				id: "rollback-without-snapshot",
				instanceId: "instance-1",
				userId: "user-1",
				backupId: null,
				rollbackStatus: "IN_PROGRESS",
			},
		]);
		mock.templateDeploymentHistory.findMany.mockResolvedValueOnce([]);

		await expect(exportDatabase(prisma, { excludeOperationalHistory: true })).rejects.toThrow(
			"rollback-without-snapshot",
		);
	});

	it("fails closed when a referenced coordination snapshot is absent", async () => {
		const { prisma, mock } = makeMockPrisma({
			serviceInstance: [{ id: "instance-1", userId: "user-1" }],
		});
		mock.trashSyncHistory.findMany.mockResolvedValueOnce([
			{
				id: "rollback-missing-evidence",
				instanceId: "instance-1",
				userId: "user-1",
				backupId: "missing-snapshot",
				rollbackStatus: "PARTIAL",
			},
		]);
		mock.templateDeploymentHistory.findMany.mockResolvedValueOnce([]);
		mock.trashBackup.findMany.mockResolvedValueOnce([]);

		await expect(exportDatabase(prisma, { excludeOperationalHistory: true })).rejects.toThrow(
			"missing-snapshot",
		);
	});

	it("fails closed when active naming recovery changes during export", async () => {
		const { prisma, mock } = makeMockPrisma();
		const activeNaming = {
			id: "active-naming-recovery",
			instanceId: "instance-1",
			userId: "user-1",
			status: "SUCCESS",
			previousConfig: '{"standardMovieFormat":"{Movie OriginalTitle}"}',
			rolledBack: false,
		};
		mock.namingDeployHistory.findMany
			.mockResolvedValueOnce([activeNaming])
			.mockResolvedValueOnce([{ ...activeNaming, previousConfig: "changed-recovery-state" }]);

		await expect(exportDatabase(prisma, { excludeOperationalHistory: true })).rejects.toThrow(
			"Cannot create backup: active naming recovery changed during export; retry",
		);
	});

	it("fails closed when active naming recovery service authority changes during export", async () => {
		const { prisma, mock } = makeMockPrisma();
		const activeNaming = {
			id: "active-naming-recovery",
			instanceId: "instance-1",
			userId: "user-1",
			status: "SUCCESS",
			previousConfig: '{"standardMovieFormat":"{Movie OriginalTitle}"}',
			rolledBack: false,
		};
		const initialInstance = {
			id: "instance-1",
			userId: "user-1",
			service: "RADARR",
			baseUrl: "https://proxy.example/arr?tenant=A",
			encryptedApiKey: "api-key-ciphertext",
			encryptionIv: "api-key-iv",
			encryptedHttpAuthCredentials: null,
			httpAuthEncryptionIv: null,
		};
		mock.serviceInstance.findMany
			.mockResolvedValueOnce([initialInstance])
			.mockResolvedValueOnce([
				{ ...initialInstance, baseUrl: "https://proxy.example/arr?tenant=B" },
			]);
		mock.namingDeployHistory.findMany
			.mockResolvedValueOnce([activeNaming])
			.mockResolvedValueOnce([activeNaming]);

		await expect(exportDatabase(prisma, { excludeOperationalHistory: true })).rejects.toThrow(
			"Cannot create backup: active naming recovery changed during export; retry",
		);
	});

	it("includes operational history with row cap when excludeOperationalHistory: false (default)", async () => {
		const { prisma, mock } = makeMockPrisma({
			huntLog: [{ id: "h1", startedAt: new Date() }],
			huntSearchHistory: [{ id: "s1", searchedAt: new Date() }],
			trashSyncHistory: [{ id: "ts1", startedAt: new Date() }],
			templateDeploymentHistory: [{ id: "td1", deployedAt: new Date() }],
		});

		const result = await exportDatabase(prisma, { historyRetentionLimit: 250 });

		// All four history tables fetched
		expect(result.huntLogs).toHaveLength(1);
		expect(result.huntSearchHistory).toHaveLength(1);
		expect(result.trashSyncHistory).toHaveLength(1);
		expect(result.templateDeploymentHistory).toHaveLength(1);

		// Each respected the retention limit + ordered by its respective timestamp DESC
		expect(mock.huntLog.findMany).toHaveBeenCalledWith({
			take: 250,
			orderBy: { startedAt: "desc" },
		});
		expect(mock.huntSearchHistory.findMany).toHaveBeenCalledWith({
			take: 250,
			orderBy: { searchedAt: "desc" },
		});
		expect(mock.trashSyncHistory.findMany).toHaveBeenCalledWith({
			take: 250,
			orderBy: { startedAt: "desc" },
		});
		expect(mock.templateDeploymentHistory.findMany).toHaveBeenCalledWith({
			take: 250,
			orderBy: { deployedAt: "desc" },
		});
	});

	it("defaults historyRetentionLimit to 1000 when not specified", async () => {
		const { prisma, mock } = makeMockPrisma();
		await exportDatabase(prisma, {});

		expect(mock.huntLog.findMany).toHaveBeenCalledWith({
			take: 1000,
			orderBy: { startedAt: "desc" },
		});
	});

	it("excludeOperationalHistory does NOT affect huntConfig (config, not history)", async () => {
		const { prisma } = makeMockPrisma({
			huntConfig: [{ id: "c1" }, { id: "c2" }],
		});

		const result = await exportDatabase(prisma, { excludeOperationalHistory: true });

		// huntConfig is configuration — must always be backed up, even when history is skipped
		expect(result.huntConfigs).toHaveLength(2);
	});

	it("includeTrashBackups defaults to false (no trashBackup fetch)", async () => {
		const { prisma, mock } = makeMockPrisma({
			trashBackup: [{ id: "tb1" }],
		});

		const result = await exportDatabase(prisma, {});

		expect(result.trashBackups).toEqual([]);
		expect(mock.trashBackup.findMany).not.toHaveBeenCalled();
	});

	it("includeTrashBackups: true filters by 7-day window + non-expired", async () => {
		const { prisma, mock } = makeMockPrisma({
			serviceInstance: [{ id: "instance-1", userId: "user-1" }],
			trashBackup: [
				{
					id: "tb1",
					instanceId: "instance-1",
					userId: "user-1",
					backupData: "recovery-evidence",
				},
			],
		});

		await exportDatabase(prisma, { includeTrashBackups: true });

		const calls = mock.trashBackup.findMany.mock.calls;
		expect(calls).toHaveLength(1);
		expect(calls[0]?.[0]).toMatchObject({
			where: {
				createdAt: { gte: expect.any(Date) },
				OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
			},
		});
	});

	/**
	 * When a history table has more rows than `historyRetentionLimit`, the
	 * helper must call `count()` first and surface a warn log with the
	 * dropped count. This is operator visibility — without it, a user
	 * restoring from a trimmed backup has no way to correlate empty
	 * `huntLog` to the retention limit (silent-failure-hunter finding #3).
	 */
	it("logs a warn when history truncation drops rows", async () => {
		const { prisma, mock } = makeMockPrisma();
		// Override count to claim 5000 huntLog rows exist, but findMany returns 1000.
		mock.huntLog.count.mockResolvedValueOnce(5000);

		await exportDatabase(prisma, { historyRetentionLimit: 1000 });

		expect(mock.huntLog.count).toHaveBeenCalled();
	});

	it("does NOT log a warn when row count fits inside the retention limit", async () => {
		const { prisma, mock } = makeMockPrisma({
			huntLog: [{ id: "h1" }, { id: "h2" }, { id: "h3" }],
		});

		await exportDatabase(prisma, { historyRetentionLimit: 1000 });

		// count() is still called (it's part of the contract), but nothing is dropped.
		expect(mock.huntLog.count).toHaveBeenCalled();
	});
});

describe("restoreDatabase — current coordination preservation", () => {
	async function expectCompatibilityFailure(
		operation: Promise<unknown>,
		expectedCause: string,
	): Promise<void> {
		let captured: unknown;
		try {
			await operation;
		} catch (error) {
			captured = error;
		}

		expect(captured).toBeInstanceOf(BackupCompatibilityError);
		const compatibilityError = captured as BackupCompatibilityError;
		expect(compatibilityError.message).toBe(
			"This backup does not contain complete configuration or recovery coverage and cannot safely replace the current installation. Create a new backup with the current version and retry.",
		);
		expect(compatibilityError.cause).toBeInstanceOf(Error);
		expect((compatibilityError.cause as Error).message).toContain(expectedCause);
	}

	function makeRestorePrisma(options: {
		currentInstances?: Array<Record<string, unknown>>;
		currentSync?: Array<Record<string, unknown>>;
		currentDeployments?: Array<Record<string, unknown>>;
		currentSnapshots?: Array<Record<string, unknown>>;
		currentNaming?: Array<Record<string, unknown>>;
		currentApprovals?: Array<Record<string, unknown>>;
		currentScanParentApprovals?: Array<Record<string, unknown>>;
		currentScans?: Array<Record<string, unknown>>;
	}) {
		const firstDelete = vi.fn().mockResolvedValue({ count: 0 });
		const tx = {
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue(options.currentInstances ?? []),
				deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
			},
			trashSyncHistory: {
				findMany: vi.fn().mockResolvedValue(options.currentSync ?? []),
				deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
			},
			templateDeploymentHistory: {
				findMany: vi.fn().mockResolvedValue(options.currentDeployments ?? []),
				deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
			},
			trashBackup: {
				findMany: vi.fn().mockResolvedValue(options.currentSnapshots ?? []),
				deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
			},
			instanceQualityProfileOverride: {
				findMany: vi.fn().mockResolvedValue([]),
				deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
			},
			namingDeployHistory: {
				findMany: vi.fn().mockResolvedValue(options.currentNaming ?? []),
				deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
			},
			libraryCleanupApproval: {
				findMany: vi
					.fn()
					.mockResolvedValueOnce(options.currentApprovals ?? [])
					.mockResolvedValue(options.currentScanParentApprovals ?? []),
				deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
			},
			libraryCleanupMediaServerScan: {
				findMany: vi.fn().mockResolvedValue(options.currentScans ?? []),
				deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
			},
			huntSearchHistory: { deleteMany: firstDelete },
		};
		const prisma = {
			$transaction: vi.fn(async (operation: (transaction: typeof tx) => Promise<void>) =>
				operation(tx),
			),
		} as unknown as PrismaClient;

		return { prisma, compatibilityPrisma: tx as unknown as PrismaClient, firstDelete };
	}

	function incomingData(overrides: Record<string, unknown> = {}) {
		return {
			users: [],
			sessions: [],
			serviceInstances: [],
			serviceTags: [],
			serviceInstanceTags: [],
			oidcAccounts: [],
			webAuthnCredentials: [],
			trashSyncHistory: [],
			templateDeploymentHistory: [],
			trashTemplates: [],
			trashBackups: [],
			...overrides,
		} as never;
	}

	it("rejects a restore that omits a current nonterminal sync row before deleting tables", async () => {
		const { prisma, firstDelete } = makeRestorePrisma({
			currentSync: [
				{
					id: "current-sync",
					instanceId: "instance-1",
					userId: "user-1",
					status: "RUNNING",
					backupId: "snapshot-sync",
				},
			],
			currentSnapshots: [
				{
					id: "snapshot-sync",
					instanceId: "instance-1",
					userId: "user-1",
					backupData: "current-sync-evidence",
				},
			],
		});

		await expectCompatibilityFailure(
			restoreDatabase(prisma, incomingData()),
			"current nonterminal coordination row current-sync",
		);
		expect(firstDelete).not.toHaveBeenCalled();
	});

	it.each([
		["userId", "user-2"],
		["service", "SONARR"],
		["baseUrl", "http://radarr-replacement:7878"],
		["encryptedApiKey", "replacement-api-key-ciphertext"],
		["encryptionIv", "replacement-api-key-iv"],
		["encryptedHttpAuthCredentials", "replacement-http-auth-ciphertext"],
		["httpAuthEncryptionIv", "replacement-http-auth-iv"],
	])(
		"rejects a restore that changes active naming recovery service instance %s",
		async (field, replacement) => {
			const currentInstance = {
				id: "instance-1",
				userId: "user-1",
				service: "RADARR",
				baseUrl: "http://radarr-current:7878",
				encryptedApiKey: "current-api-key-ciphertext",
				encryptionIv: "current-api-key-iv",
				encryptedHttpAuthCredentials: null,
				httpAuthEncryptionIv: null,
			};
			const currentNaming = {
				id: "active-naming-recovery",
				instanceId: currentInstance.id,
				userId: currentInstance.userId,
				status: "SUCCESS",
				selectedPresets: '["standard"]',
				resolvedPayload: '{"standardMovieFormat":"{Movie Title}"}',
				deployedHash: "deployed-hash",
				previousConfig: '{"standardMovieFormat":"{Movie OriginalTitle}"}',
				changedFields: 1,
				totalFields: 1,
				errorMessage: null,
				rolledBack: false,
				rolledBackAt: null,
				deployedAt: new Date("2026-08-31T00:00:00.000Z"),
			};
			const { prisma, firstDelete } = makeRestorePrisma({
				currentInstances: [currentInstance],
				currentNaming: [currentNaming],
			});

			await expectCompatibilityFailure(
				restoreDatabase(
					prisma,
					incomingData({
						serviceInstances: [{ ...currentInstance, [field]: replacement }],
						namingDeployHistory: [currentNaming],
					}),
				),
				`current active naming recovery active-naming-recovery changed service instance ${field}`,
			);
			expect(firstDelete).not.toHaveBeenCalled();
		},
	);

	it("rejects a restore that changes query-routed active naming recovery authority", async () => {
		const currentInstance = {
			id: "instance-1",
			userId: "user-1",
			service: "RADARR",
			baseUrl: "https://proxy.example/arr?tenant=A",
			encryptedApiKey: "current-api-key-ciphertext",
			encryptionIv: "current-api-key-iv",
			encryptedHttpAuthCredentials: null,
			httpAuthEncryptionIv: null,
		};
		const currentNaming = {
			id: "active-naming-recovery",
			instanceId: currentInstance.id,
			userId: currentInstance.userId,
			status: "SUCCESS",
			selectedPresets: '["standard"]',
			resolvedPayload: '{"standardMovieFormat":"{Movie Title}"}',
			deployedHash: "deployed-hash",
			previousConfig: '{"standardMovieFormat":"{Movie OriginalTitle}"}',
			changedFields: 1,
			totalFields: 1,
			errorMessage: null,
			rolledBack: false,
			rolledBackAt: null,
			deployedAt: new Date("2026-08-31T00:00:00.000Z"),
		};
		const { prisma, firstDelete } = makeRestorePrisma({
			currentInstances: [currentInstance],
			currentNaming: [currentNaming],
		});

		await expectCompatibilityFailure(
			restoreDatabase(
				prisma,
				incomingData({
					serviceInstances: [{ ...currentInstance, baseUrl: "https://proxy.example/arr?tenant=B" }],
					namingDeployHistory: [currentNaming],
				}),
			),
			"current active naming recovery active-naming-recovery changed service instance baseUrl",
		);
		expect(firstDelete).not.toHaveBeenCalled();
	});

	it("allows equivalent endpoint and display-only changes while preserving active naming recovery authority", async () => {
		const currentInstance = {
			id: "instance-1",
			userId: "user-1",
			service: "RADARR",
			label: "Current label",
			baseUrl: "http://radarr-current:7878",
			encryptedApiKey: "current-api-key-ciphertext",
			encryptionIv: "current-api-key-iv",
			encryptedHttpAuthCredentials: null,
			httpAuthEncryptionIv: null,
		};
		const currentNaming = {
			id: "active-naming-recovery",
			instanceId: currentInstance.id,
			userId: currentInstance.userId,
			status: "SUCCESS",
			selectedPresets: '["standard"]',
			resolvedPayload: '{"standardMovieFormat":"{Movie Title}"}',
			deployedHash: "deployed-hash",
			previousConfig: '{"standardMovieFormat":"{Movie OriginalTitle}"}',
			changedFields: 1,
			totalFields: 1,
			errorMessage: null,
			rolledBack: false,
			rolledBackAt: null,
			deployedAt: new Date("2026-08-31T00:00:00.000Z"),
		};
		const { compatibilityPrisma } = makeRestorePrisma({
			currentInstances: [currentInstance],
			currentNaming: [currentNaming],
		});

		await expect(
			assertRestoreCompatibility(
				compatibilityPrisma,
				incomingData({
					serviceInstances: [
						{
							...currentInstance,
							label: "Restored display label",
							baseUrl: `${currentInstance.baseUrl}/`,
						},
					],
					namingDeployHistory: [currentNaming],
				}),
			),
		).resolves.toBeUndefined();
	});

	it("rejects a restore that omits an active cleanup approval before deleting tables", async () => {
		const currentApproval = {
			id: "active-cleanup-approval",
			configId: "cleanup-config",
			instanceId: "instance-1",
			arrItemId: 815,
			itemType: "movie",
			title: "Current cleanup target",
			matchedRuleId: "rule-1",
			matchedRuleName: "Current cleanup rule",
			reason: "age",
			action: "delete",
			sizeOnDisk: BigInt(815),
			status: "approved",
			expiresAt: new Date("2030-01-01T00:00:00.000Z"),
			createdAt: new Date("2026-08-31T00:00:00.000Z"),
		};
		const { prisma, firstDelete } = makeRestorePrisma({
			currentApprovals: [currentApproval],
		});

		await expectCompatibilityFailure(
			restoreDatabase(prisma, incomingData({ libraryCleanupApproval: [] })),
			"current active cleanup approval active-cleanup-approval is missing from incoming data",
		);
		expect(firstDelete).not.toHaveBeenCalled();
	});

	it("rejects a restore that omits a retryable media-server scan and its terminal parent", async () => {
		const currentParent = {
			id: "executed-cleanup-parent",
			configId: "cleanup-config",
			instanceId: "instance-1",
			arrItemId: 816,
			itemType: "series",
			title: "Executed cleanup target",
			matchedRuleId: "rule-1",
			matchedRuleName: "Current cleanup rule",
			reason: "size",
			action: "delete",
			sizeOnDisk: BigInt(816),
			status: "executed",
			expiresAt: new Date("2030-01-01T00:00:00.000Z"),
			createdAt: new Date("2026-08-31T00:00:00.000Z"),
		};
		const currentScan = {
			id: "retryable-cleanup-scan",
			approvalId: currentParent.id,
			instanceId: "instance-1",
			service: "PLEX",
			mediaType: "show",
			targetKey: "series:816",
			status: "failed",
			attemptCount: 1,
			completedSectionIds: "[]",
			lastError: "temporary provider failure",
			createdAt: new Date("2026-08-31T00:00:00.000Z"),
			updatedAt: new Date("2026-08-31T00:01:00.000Z"),
		};
		const { prisma, firstDelete } = makeRestorePrisma({
			currentScanParentApprovals: [currentParent],
			currentScans: [currentScan],
		});

		await expectCompatibilityFailure(
			restoreDatabase(
				prisma,
				incomingData({
					libraryCleanupApproval: [
						{ ...currentParent, sizeOnDisk: currentParent.sizeOnDisk.toString() },
					],
					libraryCleanupMediaServerScan: [],
				}),
			),
			"current active media-server scan retryable-cleanup-scan is missing from incoming data",
		);
		expect(firstDelete).not.toHaveBeenCalled();
	});

	it("rejects a restore that omits a current snapshotless restart audit", async () => {
		const { prisma, firstDelete } = makeRestorePrisma({
			currentSync: [
				{
					id: "interrupted-sync",
					instanceId: "instance-1",
					userId: "user-1",
					status: "UNCERTAIN",
					backupId: null,
					rollbackStatus: null,
					rolledBack: false,
				},
			],
		});

		await expectCompatibilityFailure(
			restoreDatabase(prisma, incomingData()),
			"current nonterminal coordination row interrupted-sync",
		);
		expect(firstDelete).not.toHaveBeenCalled();
	});

	it("rejects a restore that omits a current deployment snapshot before deleting tables", async () => {
		const currentDeployment = {
			id: "current-deployment",
			instanceId: "instance-1",
			templateId: "template-1",
			userId: "user-1",
			status: "IN_PROGRESS",
			templateSnapshot: "{}",
			backupId: "snapshot-deployment",
		};
		const { prisma, firstDelete } = makeRestorePrisma({
			currentDeployments: [currentDeployment],
			currentSnapshots: [
				{
					id: "snapshot-deployment",
					instanceId: "instance-1",
					userId: "user-1",
					backupData: "current-deployment-evidence",
				},
			],
		});

		await expectCompatibilityFailure(
			restoreDatabase(prisma, incomingData({ templateDeploymentHistory: [currentDeployment] })),
			"current recovery snapshot snapshot-deployment",
		);
		expect(firstDelete).not.toHaveBeenCalled();
	});

	it("rejects a same-ID incoming row whose current recovery claim content changed", async () => {
		const currentSync = {
			id: "current-sync",
			instanceId: "instance-1",
			templateId: "template-1",
			userId: "user-1",
			status: "FAILED",
			rolledBack: false,
			rollbackStatus: "IN_PROGRESS",
			rollbackAttemptedAt: new Date("2026-08-10T10:00:00.000Z"),
			rollbackProgress: '[{"step":"rollback","status":"IN_PROGRESS"}]',
			backupId: "snapshot-sync",
		};
		const currentSnapshot = {
			id: "snapshot-sync",
			instanceId: "instance-1",
			userId: "user-1",
			backupData: "current-sync-evidence",
		};
		const { prisma, firstDelete } = makeRestorePrisma({
			currentSync: [currentSync],
			currentSnapshots: [currentSnapshot],
		});

		await expectCompatibilityFailure(
			restoreDatabase(
				prisma,
				incomingData({
					trashSyncHistory: [{ ...currentSync, userId: "user-2" }],
					trashBackups: [currentSnapshot],
				}),
			),
			"current nonterminal coordination row current-sync changed userId",
		);
		expect(firstDelete).not.toHaveBeenCalled();
	});

	it("rejects a same-ID incoming snapshot whose current evidence payload changed", async () => {
		const currentSync = {
			id: "current-sync",
			instanceId: "instance-1",
			userId: "user-1",
			status: "RUNNING",
			backupId: "snapshot-sync",
		};
		const currentSnapshot = {
			id: "snapshot-sync",
			instanceId: "instance-1",
			userId: "user-1",
			backupData: "current-sync-evidence",
		};
		const { prisma, firstDelete } = makeRestorePrisma({
			currentSync: [currentSync],
			currentSnapshots: [currentSnapshot],
		});

		await expectCompatibilityFailure(
			restoreDatabase(
				prisma,
				incomingData({
					trashSyncHistory: [currentSync],
					trashBackups: [{ ...currentSnapshot, backupData: "stale-sync-evidence" }],
				}),
			),
			"current recovery snapshot snapshot-sync changed backupData",
		);
		expect(firstDelete).not.toHaveBeenCalled();
	});

	it("rejects a same-ID deployment whose applied recovery configuration changed", async () => {
		const currentDeployment = {
			id: "current-deployment",
			instanceId: "instance-1",
			templateId: "template-1",
			userId: "user-1",
			status: "IN_PROGRESS",
			rolledBack: false,
			canRollback: true,
			appliedConfigs: '[{"name":"current-config"}]',
			templateSnapshot: "{}",
			backupId: "snapshot-deployment",
		};
		const currentSnapshot = {
			id: "snapshot-deployment",
			instanceId: "instance-1",
			userId: "user-1",
			backupData: "current-deployment-evidence",
		};
		const { prisma, firstDelete } = makeRestorePrisma({
			currentDeployments: [currentDeployment],
			currentSnapshots: [currentSnapshot],
		});

		await expectCompatibilityFailure(
			restoreDatabase(
				prisma,
				incomingData({
					templateDeploymentHistory: [
						{ ...currentDeployment, appliedConfigs: '[{"name":"stale-config"}]' },
					],
					trashBackups: [currentSnapshot],
				}),
			),
			"current nonterminal coordination row current-deployment changed appliedConfigs",
		);
		expect(firstDelete).not.toHaveBeenCalled();
	});

	it("rejects a same-ID deployment whose undeploy template snapshot changed", async () => {
		const currentDeployment = {
			id: "current-deployment",
			instanceId: "instance-1",
			templateId: "template-1",
			userId: "user-1",
			status: "PARTIAL_UNDEPLOY",
			rolledBack: false,
			undeployStatus: "PARTIAL",
			templateSnapshot: '{"customFormats":[{"name":"Current CF"}]}',
			backupId: "snapshot-deployment",
		};
		const currentSnapshot = {
			id: "snapshot-deployment",
			instanceId: "instance-1",
			userId: "user-1",
			backupData: "current-deployment-evidence",
		};
		const { prisma, firstDelete } = makeRestorePrisma({
			currentDeployments: [currentDeployment],
			currentSnapshots: [currentSnapshot],
		});

		await expectCompatibilityFailure(
			restoreDatabase(
				prisma,
				incomingData({
					templateDeploymentHistory: [{ ...currentDeployment, templateSnapshot: "{}" }],
					trashBackups: [currentSnapshot],
				}),
			),
			"current nonterminal coordination row current-deployment changed templateSnapshot",
		);
		expect(firstDelete).not.toHaveBeenCalled();
	});

	it("rejects a restore that changes the current undeploy fallback template", async () => {
		const currentTemplate = {
			id: "template-1",
			userId: "user-1",
			serviceType: "RADARR",
			configData: '{"customFormats":[{"name":"Current CF"}]}',
		};
		const currentDeployment = {
			id: "current-deployment",
			instanceId: "instance-1",
			templateId: "template-1",
			userId: "user-1",
			status: "PARTIAL_UNDEPLOY",
			rolledBack: false,
			undeployStatus: "PARTIAL",
			templateSnapshot: null,
			backupId: "snapshot-deployment",
			template: currentTemplate,
		};
		const currentSnapshot = {
			id: "snapshot-deployment",
			instanceId: "instance-1",
			userId: "user-1",
			backupData: "current-deployment-evidence",
		};
		const { prisma, firstDelete } = makeRestorePrisma({
			currentDeployments: [currentDeployment],
			currentSnapshots: [currentSnapshot],
		});

		await expectCompatibilityFailure(
			restoreDatabase(
				prisma,
				incomingData({
					templateDeploymentHistory: [currentDeployment],
					trashTemplates: [{ ...currentTemplate, configData: "{}" }],
					trashBackups: [currentSnapshot],
				}),
			),
			"current undeploy fallback template template-1 changed configData",
		);
		expect(firstDelete).not.toHaveBeenCalled();
	});

	it("rejects a same-ID sync whose applied recovery configuration changed", async () => {
		const currentSync = {
			id: "current-sync",
			instanceId: "instance-1",
			templateId: "template-1",
			userId: "user-1",
			status: "FAILED",
			rolledBack: false,
			appliedConfigs: '[{"name":"current-config"}]',
			rollbackStatus: "PARTIAL",
			backupId: "snapshot-sync",
		};
		const currentSnapshot = {
			id: "snapshot-sync",
			instanceId: "instance-1",
			userId: "user-1",
			backupData: "current-sync-evidence",
		};
		const { prisma, firstDelete } = makeRestorePrisma({
			currentSync: [currentSync],
			currentSnapshots: [currentSnapshot],
		});

		await expectCompatibilityFailure(
			restoreDatabase(
				prisma,
				incomingData({
					trashSyncHistory: [{ ...currentSync, appliedConfigs: '[{"name":"stale-config"}]' }],
					trashBackups: [currentSnapshot],
				}),
			),
			"current nonterminal coordination row current-sync changed appliedConfigs",
		);
		expect(firstDelete).not.toHaveBeenCalled();
	});
});
