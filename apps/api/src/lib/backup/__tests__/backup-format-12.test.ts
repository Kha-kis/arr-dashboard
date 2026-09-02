import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../prisma.js";
import { assertRestoreCompatibility, exportDatabase, restoreDatabase } from "../backup-database.js";
import { validateBackup } from "../backup-validation.js";

const DURABLE_CONFIG_KEYS = [
	"backupSettings",
	"vapidKeys",
	"notificationChannel",
	"notificationSubscription",
	"notificationRule",
	"notificationAggregationConfig",
	"autoTagRule",
	"labelSyncRule",
	"queueCleanerConfig",
	"libraryCleanupConfig",
	"libraryCleanupRule",
	"librarySyncSettings",
	"namingConfig",
	"userCustomFormat",
	"namingDeployHistory",
	"libraryCleanupApproval",
	"libraryCleanupMediaServerScan",
] as const;

const COMPLETE_V1_2_PAYLOAD_KEYS = [
	"oidcProviders",
	"systemSettings",
	"trashTemplates",
	"trashSettings",
	"trashSyncSchedules",
	"templateQualityProfileMappings",
	"instanceQualityProfileOverrides",
	"standaloneCFDeployments",
	"qualitySizeMappings",
	"trashSyncHistory",
	"templateDeploymentHistory",
	"trashBackups",
	"huntConfigs",
	"huntLogs",
	"huntSearchHistory",
	...DURABLE_CONFIG_KEYS,
] as const;

function baseBackup(data: Record<string, unknown> = {}) {
	return {
		version: "1.2",
		appVersion: "2.24.2",
		timestamp: new Date().toISOString(),
		data: {
			users: [],
			sessions: [],
			serviceInstances: [],
			serviceTags: [],
			serviceInstanceTags: [],
			oidcAccounts: [],
			webAuthnCredentials: [],
			...Object.fromEntries(COMPLETE_V1_2_PAYLOAD_KEYS.map((key) => [key, []])),
			...data,
		},
		secrets: {
			encryptionKey: "encryption-key",
			sessionCookieSecret: "session-cookie-secret",
		},
	};
}

describe("backup format 1.2", () => {
	it("accepts explicit durable configuration arrays, including empty arrays", () => {
		expect(() => validateBackup(baseBackup())).not.toThrow();
	});

	it.each(["oidcProviders", "systemSettings", "backupSettings", "vapidKeys"])(
		"rejects ambiguous duplicate %s singleton records",
		(collection) => {
			expect(() =>
				validateBackup(
					baseBackup({
						[collection]: [{ id: 1 }, { id: 2 }],
					}),
				),
			).toThrow(new RegExp(`${collection}.*at most one`, "i"));
		},
	);

	it("rejects a 1.2 payload when a durable configuration array is missing", () => {
		const backup = baseBackup() as { data: Record<string, unknown> };
		delete backup.data.notificationChannel;

		expect(() => validateBackup(backup)).toThrow(/notificationChannel/);
	});

	it("rejects a 1.2 payload when an older exported configuration array is missing", () => {
		const backup = baseBackup() as { data: Record<string, unknown> };
		delete backup.data.qualitySizeMappings;

		expect(() => validateBackup(backup)).toThrow(/qualitySizeMappings/);
	});

	it("rejects a 1.2 payload when cleanup coordination coverage is missing", () => {
		const backup = baseBackup() as { data: Record<string, unknown> };
		delete backup.data.libraryCleanupApproval;

		expect(() => validateBackup(backup)).toThrow(/libraryCleanupApproval/);
	});

	it("rejects a 1.2 payload when library polling settings are missing", () => {
		const backup = baseBackup() as { data: Record<string, unknown> };
		delete backup.data.librarySyncSettings;

		expect(() => validateBackup(backup)).toThrow(/librarySyncSettings/);
	});

	it("exports every durable configuration collection as an explicit array", async () => {
		const models = [
			"user",
			"session",
			"serviceInstance",
			"serviceTag",
			"serviceInstanceTag",
			"oIDCProvider",
			"oIDCAccount",
			"webAuthnCredential",
			"systemSettings",
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
			"libraryCleanupApproval",
			"libraryCleanupMediaServerScan",
			"librarySyncStatus",
			...DURABLE_CONFIG_KEYS.filter(
				(key) => key !== "backupSettings" && key !== "vapidKeys" && key !== "librarySyncSettings",
			),
			"backupSettings",
			"vapidKeys",
		];
		const transactionClient = Object.fromEntries(
			models.map((model) => [
				model,
				{
					findMany: vi.fn().mockResolvedValue([]),
					count: vi.fn().mockResolvedValue(0),
				},
			]),
		);
		const prisma = {
			...transactionClient,
			$transaction: vi.fn(async (operation: (tx: unknown) => Promise<unknown>) =>
				operation(transactionClient),
			),
		} as unknown as PrismaClient;

		const data = await exportDatabase(prisma);

		for (const key of DURABLE_CONFIG_KEYS) {
			expect(data[key]).toEqual([]);
		}
		expect(data.libraryCleanupApproval).toEqual([]);
		expect(data.libraryCleanupMediaServerScan).toEqual([]);
	});

	it("exports only durable library polling settings", async () => {
		const status = {
			id: "status-1",
			instanceId: "instance-1",
			pollingEnabled: false,
			pollingIntervalMins: 90,
			lastFullSync: new Date("2026-08-31T00:00:00.000Z"),
			lastIncrementalSync: new Date("2026-08-31T00:01:00.000Z"),
			syncInProgress: true,
			lastSyncDurationMs: 123,
			lastError: "stale failure",
			itemCount: 42,
			createdAt: new Date("2026-08-31T00:00:00.000Z"),
			updatedAt: new Date("2026-08-31T00:01:00.000Z"),
		};
		const emptyDelegate = {
			findMany: vi.fn().mockResolvedValue([]),
			count: vi.fn().mockResolvedValue(0),
		};
		const librarySyncFindMany = vi.fn().mockResolvedValue([
			{
				instanceId: status.instanceId,
				pollingEnabled: status.pollingEnabled,
				pollingIntervalMins: status.pollingIntervalMins,
			},
		]);
		let prisma!: PrismaClient;
		prisma = new Proxy(
			{},
			{
				get: (_target, property) => {
					if (property === "$transaction") {
						return async (operation: (tx: PrismaClient) => Promise<unknown>) => operation(prisma);
					}
					if (property === "librarySyncStatus") {
						return { findMany: librarySyncFindMany };
					}
					return emptyDelegate;
				},
			},
		) as unknown as PrismaClient;

		const data = await exportDatabase(prisma);

		expect(librarySyncFindMany).toHaveBeenCalledWith({
			select: {
				instanceId: true,
				pollingEnabled: true,
				pollingIntervalMins: true,
			},
		});
		expect(data.librarySyncSettings).toEqual([
			{
				instanceId: "instance-1",
				pollingEnabled: false,
				pollingIntervalMins: 90,
			},
		]);
	});

	it("exports no-scan approvals awaiting terminal audit and resets nonportable audit markers", async () => {
		const awaitingAudit = {
			id: "approval-awaiting-audit",
			status: "executed",
			sizeOnDisk: 10n,
			terminalAuditRecordedAt: null,
			terminalAuditRecoveryAttemptedAt: new Date("2026-08-30T00:00:00.000Z"),
		};
		const auditedScanParent = {
			id: "approval-with-scan",
			status: "executed",
			sizeOnDisk: 20n,
			terminalAuditRecordedAt: new Date("2026-08-30T01:00:00.000Z"),
			terminalAuditRecoveryAttemptedAt: new Date("2026-08-30T00:30:00.000Z"),
		};
		const emptyDelegate = {
			findMany: vi.fn().mockResolvedValue([]),
			count: vi.fn().mockResolvedValue(0),
		};
		const approvalFindMany = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
			if ("OR" in where) return [awaitingAudit];
			if ("id" in where) return [auditedScanParent];
			return [];
		});
		const scanFindMany = vi.fn().mockResolvedValue([
			{
				id: "scan-1",
				approvalId: auditedScanParent.id,
				status: "failed",
			},
		]);
		let prisma!: PrismaClient;
		prisma = new Proxy(
			{},
			{
				get: (_target, property) => {
					if (property === "$transaction") {
						return async (operation: (tx: PrismaClient) => Promise<unknown>) => operation(prisma);
					}
					if (property === "libraryCleanupApproval") {
						return { findMany: approvalFindMany };
					}
					if (property === "libraryCleanupMediaServerScan") {
						return { findMany: scanFindMany };
					}
					return emptyDelegate;
				},
			},
		) as unknown as PrismaClient;

		const data = await exportDatabase(prisma);

		expect(data.libraryCleanupApproval).toEqual([
			expect.objectContaining({
				id: awaitingAudit.id,
				sizeOnDisk: "10",
				terminalAuditRecordedAt: null,
				terminalAuditRecoveryAttemptedAt: null,
			}),
			expect.objectContaining({
				id: auditedScanParent.id,
				sizeOnDisk: "20",
				terminalAuditRecordedAt: null,
				terminalAuditRecoveryAttemptedAt: null,
			}),
		]);
	});

	it("rejects legacy omission of an older relational config collection", async () => {
		const prisma = {
			trashTemplate: { count: vi.fn().mockResolvedValue(1) },
		} as unknown as PrismaClient;
		const legacyData = { ...baseBackup().data } as Record<string, unknown>;
		delete legacyData.trashTemplates;

		await expect(assertRestoreCompatibility(prisma, legacyData as never)).rejects.toThrow(
			"does not contain complete configuration or recovery coverage",
		);
	});

	it("rejects an incomplete legacy payload over a populated durable-config target", async () => {
		const prisma = {
			notificationChannel: { count: vi.fn().mockResolvedValue(1) },
		} as unknown as PrismaClient;
		const legacyData = { ...baseBackup().data } as Record<string, unknown>;
		delete legacyData.notificationChannel;

		await expect(assertRestoreCompatibility(prisma, legacyData as never)).rejects.toThrow(
			"does not contain complete configuration or recovery coverage",
		);
	});

	it("rejects legacy omission over non-default library polling settings", async () => {
		const findMany = vi.fn().mockResolvedValue([{ instanceId: "instance-1" }]);
		const prisma = {
			librarySyncStatus: { findMany },
		} as unknown as PrismaClient;
		const legacyData = { ...baseBackup().data } as Record<string, unknown>;
		delete legacyData.librarySyncSettings;

		await expect(assertRestoreCompatibility(prisma, legacyData as never)).rejects.toThrow(
			"does not contain complete configuration or recovery coverage",
		);
		expect(findMany).toHaveBeenCalledWith({
			where: {
				OR: [{ pollingEnabled: false }, { pollingIntervalMins: { not: 15 } }],
			},
			select: { instanceId: true },
		});
	});

	it("allows legacy omission when library polling settings are defaults", async () => {
		const prisma = {
			librarySyncStatus: { findMany: vi.fn().mockResolvedValue([]) },
		} as unknown as PrismaClient;
		const legacyData = { ...baseBackup().data } as Record<string, unknown>;
		delete legacyData.librarySyncSettings;

		await expect(assertRestoreCompatibility(prisma, legacyData as never)).resolves.toBeUndefined();
	});

	it.each([
		["non-boolean enabled state", { pollingEnabled: "false", pollingIntervalMins: 15 }],
		["non-integer interval", { pollingEnabled: true, pollingIntervalMins: 15.5 }],
		["too-short interval", { pollingEnabled: true, pollingIntervalMins: 4 }],
		["too-long interval", { pollingEnabled: true, pollingIntervalMins: 1441 }],
	])("rejects %s before opening the restore transaction", async (_label, settings) => {
		const transaction = vi.fn();
		const prisma = { $transaction: transaction } as unknown as PrismaClient;

		await expect(
			restoreDatabase(
				prisma,
				baseBackup({
					librarySyncSettings: [{ instanceId: "instance-1", ...settings }],
				}).data as never,
			),
		).rejects.toThrow(/librarySyncSettings/);
		expect(transaction).not.toHaveBeenCalled();
	});

	it("rejects duplicate library polling settings before opening the restore transaction", async () => {
		const transaction = vi.fn();
		const prisma = { $transaction: transaction } as unknown as PrismaClient;
		const settings = {
			instanceId: "instance-1",
			pollingEnabled: true,
			pollingIntervalMins: 15,
		};

		await expect(
			restoreDatabase(
				prisma,
				baseBackup({ librarySyncSettings: [settings, settings] }).data as never,
			),
		).rejects.toThrow(/duplicate.*librarySyncSettings/i);
		expect(transaction).not.toHaveBeenCalled();
	});

	it("rejects incomplete legacy coverage over partial stored backup-password state", async () => {
		const prisma = {
			backupSettings: {
				findFirst: vi.fn().mockResolvedValue({
					encryptedPassword: "ciphertext-without-iv",
					passwordIv: null,
				}),
			},
			vapidKeys: { findFirst: vi.fn().mockResolvedValue(null) },
		} as unknown as PrismaClient;
		const legacyData = { ...baseBackup().data } as Record<string, unknown>;
		delete legacyData.backupSettings;

		await expect(assertRestoreCompatibility(prisma, legacyData as never)).rejects.toThrow(
			"does not contain complete configuration or recovery coverage",
		);
	});

	it("rejects incomplete legacy coverage over stored VAPID private-key state", async () => {
		const prisma = {
			backupSettings: {
				findFirst: vi.fn().mockResolvedValue({ encryptedPassword: null, passwordIv: null }),
			},
			vapidKeys: {
				findFirst: vi.fn().mockResolvedValue({
					encryptedPrivateKey: null,
					privateKeyIv: "iv-without-ciphertext",
				}),
			},
		} as unknown as PrismaClient;
		const legacyData = { ...baseBackup().data } as Record<string, unknown>;
		delete legacyData.vapidKeys;

		await expect(assertRestoreCompatibility(prisma, legacyData as never)).rejects.toThrow(
			"does not contain complete configuration or recovery coverage",
		);
	});

	it("allows incomplete legacy coverage over default non-secret backup settings", async () => {
		const prisma = {
			notificationChannel: { count: vi.fn().mockResolvedValue(0) },
			backupSettings: {
				findFirst: vi.fn().mockResolvedValue({ encryptedPassword: null, passwordIv: null }),
			},
			vapidKeys: { findFirst: vi.fn().mockResolvedValue(null) },
		} as unknown as PrismaClient;
		const legacyData = { ...baseBackup().data } as Record<string, unknown>;
		delete legacyData.backupSettings;

		await expect(assertRestoreCompatibility(prisma, legacyData as never)).resolves.toBeUndefined();
	});

	it("allows unrelated legacy omissions when singleton replacement arrays are present", async () => {
		const backupSettingsFindFirst = vi.fn().mockResolvedValue({
			encryptedPassword: "target-ciphertext",
			passwordIv: "target-iv",
		});
		const vapidKeysFindFirst = vi.fn().mockResolvedValue({
			encryptedPrivateKey: "target-vapid-ciphertext",
			privateKeyIv: "target-vapid-iv",
		});
		const prisma = {
			notificationChannel: { count: vi.fn().mockResolvedValue(0) },
			backupSettings: { findFirst: backupSettingsFindFirst },
			vapidKeys: { findFirst: vapidKeysFindFirst },
		} as unknown as PrismaClient;
		const legacyData = { ...baseBackup().data } as Record<string, unknown>;
		delete legacyData.notificationChannel;

		await expect(assertRestoreCompatibility(prisma, legacyData as never)).resolves.toBeUndefined();
		expect(backupSettingsFindFirst).not.toHaveBeenCalled();
		expect(vapidKeysFindFirst).not.toHaveBeenCalled();
	});

	it("rejects legacy omission of current OIDC provider state", async () => {
		const prisma = {
			oIDCProvider: { count: vi.fn().mockResolvedValue(1) },
		} as unknown as PrismaClient;
		const legacyData = { ...baseBackup().data } as Record<string, unknown>;
		delete legacyData.oidcProviders;

		await expect(assertRestoreCompatibility(prisma, legacyData as never)).rejects.toThrow(
			"does not contain complete configuration or recovery coverage",
		);
	});

	it("allows legacy omission when the only naming history is terminal audit", async () => {
		const prisma = {
			namingDeployHistory: {
				count: vi.fn().mockResolvedValue(1),
				findMany: vi.fn().mockResolvedValue([]),
			},
		} as unknown as PrismaClient;
		const legacyData = { ...baseBackup().data } as Record<string, unknown>;
		delete legacyData.namingDeployHistory;

		await expect(assertRestoreCompatibility(prisma, legacyData as never)).resolves.toBeUndefined();
	});

	it("allows legacy omission when the only naming history is rolled back", async () => {
		const prisma = {
			namingDeployHistory: {
				count: vi.fn().mockResolvedValue(1),
				findMany: vi.fn().mockResolvedValue([]),
			},
		} as unknown as PrismaClient;
		const legacyData = { ...baseBackup().data } as Record<string, unknown>;
		delete legacyData.namingDeployHistory;

		await expect(assertRestoreCompatibility(prisma, legacyData as never)).resolves.toBeUndefined();
	});

	it("rejects legacy omission when active naming recovery is populated", async () => {
		const prisma = {
			namingDeployHistory: {
				count: vi.fn().mockResolvedValue(1),
				findMany: vi
					.fn()
					.mockResolvedValue([{ id: "active", status: "SUCCESS", rolledBack: false }]),
			},
		} as unknown as PrismaClient;
		const legacyData = { ...baseBackup().data } as Record<string, unknown>;
		delete legacyData.namingDeployHistory;

		await expect(assertRestoreCompatibility(prisma, legacyData as never)).rejects.toThrow(
			"does not contain complete configuration or recovery coverage",
		);
	});

	it("rechecks compatibility inside the transaction before the first delete", async () => {
		const firstDelete = vi.fn();
		const tx = {
			notificationChannel: { count: vi.fn().mockResolvedValue(1) },
			huntSearchHistory: { deleteMany: firstDelete },
		};
		const prisma = {
			$transaction: vi.fn(async (operation: (value: unknown) => Promise<void>) => operation(tx)),
		} as unknown as PrismaClient;
		const legacyData = { ...baseBackup().data } as Record<string, unknown>;
		delete legacyData.notificationChannel;

		await expect(restoreDatabase(prisma, legacyData as never)).rejects.toThrow(
			"does not contain complete configuration or recovery coverage",
		);
		expect(firstDelete).not.toHaveBeenCalled();
	});

	it.each(["oidcProviders", "systemSettings", "backupSettings", "vapidKeys"])(
		"rejects duplicate %s records before opening the restore transaction",
		async (collection) => {
			const transaction = vi.fn();
			const prisma = { $transaction: transaction } as unknown as PrismaClient;

			await expect(
				restoreDatabase(prisma, baseBackup({ [collection]: [{ id: 1 }, { id: 2 }] }).data as never),
			).rejects.toThrow(new RegExp(`${collection}.*at most one`, "i"));
			expect(transaction).not.toHaveBeenCalled();
		},
	);
});
