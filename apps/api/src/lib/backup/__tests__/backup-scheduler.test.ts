import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../../lib/prisma.js";
import type { Encryptor } from "../../auth/encryption.js";
import {
	CleanupMaintenanceConflictError,
	withCleanupMaintenanceGuard,
	withCleanupOperationGuard,
} from "../../library-cleanup/cleanup-maintenance-gate.js";
import { BackupScheduler } from "../backup-scheduler.js";
import { BackupPasswordConfigurationError } from "../backup-service.js";

afterEach(() => {
	vi.unstubAllEnvs();
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function schedulerPasswordService(
	settings: { encryptedPassword: string | null; passwordIv: string | null },
	encryptor: Encryptor,
) {
	const prisma = {
		backupSettings: {
			findUnique: vi.fn().mockResolvedValue(settings),
		},
	} as unknown as PrismaClient;
	const logger = {
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
	} as unknown as FastifyBaseLogger;
	const scheduler = new BackupScheduler(prisma, logger, "/unused/secrets.json", undefined, {
		encryptor,
	});
	return (
		scheduler as unknown as {
			backupService: {
				getPasswordStatus(): Promise<unknown>;
				getBackupPassword(): Promise<string>;
			};
		}
	).backupService;
}

describe("BackupScheduler secret synchronization", () => {
	it("does not start the minute loop when active secrets are unsynchronized", () => {
		const logger = {
			error: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			debug: vi.fn(),
		} as unknown as FastifyBaseLogger;
		const scheduler = new BackupScheduler(
			{} as PrismaClient,
			logger,
			"/unused/secrets.json",
			undefined,
			{ secretsSynchronized: false },
		);

		scheduler.start();

		expect(logger.warn).toHaveBeenCalledOnce();
		expect(logger.warn).toHaveBeenCalledWith(
			"Backup scheduler disabled because active environment secrets could not be synchronized",
		);
	});

	it("rejects the scheduled backup path when active secrets are unsynchronized", async () => {
		const logger = {
			error: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			debug: vi.fn(),
		} as unknown as FastifyBaseLogger;
		const scheduler = new BackupScheduler(
			{} as PrismaClient,
			logger,
			"/unused/secrets.json",
			undefined,
			{ secretsSynchronized: false },
		);
		const runScheduledBackup = (
			scheduler as unknown as {
				runScheduledBackup(retentionCount: number): Promise<void>;
			}
		).runScheduledBackup.bind(scheduler);

		await expect(runScheduledBackup(3)).rejects.toThrow(
			"active environment secrets could not be synchronized",
		);
	});
});

describe("BackupScheduler database password wiring", () => {
	it.each([
		["ciphertext only", { encryptedPassword: "stored", passwordIv: null }],
		["IV only", { encryptedPassword: null, passwordIv: "stored-iv" }],
	] as const)(
		"fails closed for an incomplete scheduled password (%s)",
		async (_label, settings) => {
			vi.stubEnv("NODE_ENV", "production");
			vi.stubEnv("BACKUP_PASSWORD", "");
			const encryptor = { decrypt: vi.fn() } as unknown as Encryptor;
			const backupService = schedulerPasswordService(settings, encryptor);

			await expect(backupService.getPasswordStatus()).resolves.toEqual({
				configured: false,
				source: "database",
				reason: "invalid_database_password",
			});
			await expect(backupService.getBackupPassword()).rejects.toBeInstanceOf(
				BackupPasswordConfigurationError,
			);
			expect(encryptor.decrypt).not.toHaveBeenCalled();
		},
	);

	it("uses the environment fallback for a corrupt scheduled database password", async () => {
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("BACKUP_PASSWORD", "scheduled-environment-password");
		const encryptor = {
			decrypt: vi.fn(() => {
				throw new Error("synthetic decrypt failure");
			}),
		} as unknown as Encryptor;
		const backupService = schedulerPasswordService(
			{ encryptedPassword: "corrupt", passwordIv: "corrupt-iv" },
			encryptor,
		);

		await expect(backupService.getPasswordStatus()).resolves.toEqual({
			configured: true,
			source: "environment",
		});
		await expect(backupService.getBackupPassword()).resolves.toBe("scheduled-environment-password");
	});

	it("rejects a corrupt scheduled password instead of generating a development password", async () => {
		vi.stubEnv("NODE_ENV", "development");
		vi.stubEnv("BACKUP_PASSWORD", "");
		const encryptor = {
			decrypt: vi.fn(() => {
				throw new Error("synthetic decrypt failure");
			}),
		} as unknown as Encryptor;
		const backupService = schedulerPasswordService(
			{ encryptedPassword: "corrupt", passwordIv: "corrupt-iv" },
			encryptor,
		);

		await expect(backupService.getBackupPassword()).rejects.toBeInstanceOf(
			BackupPasswordConfigurationError,
		);
	});
});

describe("BackupScheduler restore coordination", () => {
	it("holds mutation ownership through bookkeeping and the completion notification", async () => {
		const updateStarted = deferred<void>();
		const finishUpdate = deferred<void>();
		const notificationStarted = deferred<void>();
		const finishNotification = deferred<void>();
		const prisma = {
			backupSettings: {
				findUnique: vi.fn().mockResolvedValue({
					enabled: true,
					intervalType: "HOURLY",
					intervalValue: 1,
					retentionCount: 3,
					nextRunAt: new Date(0),
				}),
				update: vi.fn().mockImplementation(async () => {
					updateStarted.resolve();
					await finishUpdate.promise;
				}),
			},
		} as unknown as PrismaClient;
		const logger = {
			error: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			debug: vi.fn(),
		} as unknown as FastifyBaseLogger;
		const scheduler = new BackupScheduler(prisma, logger, "/unused/secrets.json", async () =>
			withCleanupOperationGuard(async () => {
				notificationStarted.resolve();
				await finishNotification.promise;
			}),
		);
		vi.spyOn(
			scheduler as unknown as { runScheduledBackup(retentionCount: number): Promise<void> },
			"runScheduledBackup",
		).mockResolvedValue(undefined);
		const checkAndRunBackup = (
			scheduler as unknown as { checkAndRunBackup(): Promise<void> }
		).checkAndRunBackup.bind(scheduler);

		const scheduledTick = checkAndRunBackup();
		await updateStarted.promise;
		await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toBeInstanceOf(
			CleanupMaintenanceConflictError,
		);

		finishUpdate.resolve();
		await notificationStarted.promise;
		await Promise.resolve();
		await Promise.resolve();
		const maintenanceAttempt = withCleanupMaintenanceGuard(async () => undefined);
		finishNotification.resolve();
		await scheduledTick;
		await expect(maintenanceAttempt).rejects.toBeInstanceOf(CleanupMaintenanceConflictError);
	});

	it("holds mutation ownership through the failure notification", async () => {
		const notificationStarted = deferred<void>();
		const finishNotification = deferred<void>();
		const prisma = {
			backupSettings: {
				findUnique: vi.fn().mockResolvedValue({
					enabled: true,
					intervalType: "HOURLY",
					intervalValue: 1,
					retentionCount: 3,
					nextRunAt: new Date(0),
				}),
			},
		} as unknown as PrismaClient;
		const logger = {
			error: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			debug: vi.fn(),
		} as unknown as FastifyBaseLogger;
		const scheduler = new BackupScheduler(prisma, logger, "/unused/secrets.json", async () =>
			withCleanupOperationGuard(async () => {
				notificationStarted.resolve();
				await finishNotification.promise;
			}),
		);
		vi.spyOn(
			scheduler as unknown as { runScheduledBackup(retentionCount: number): Promise<void> },
			"runScheduledBackup",
		).mockRejectedValue(new Error("synthetic backup failure"));
		const checkAndRunBackup = (
			scheduler as unknown as { checkAndRunBackup(): Promise<void> }
		).checkAndRunBackup.bind(scheduler);

		const scheduledTick = checkAndRunBackup();
		await notificationStarted.promise;
		await Promise.resolve();
		await Promise.resolve();
		const maintenanceAttempt = withCleanupMaintenanceGuard(async () => undefined);
		finishNotification.resolve();
		await scheduledTick;
		await expect(maintenanceAttempt).rejects.toBeInstanceOf(CleanupMaintenanceConflictError);
	});
});
