import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loggers } from "../../logger.js";
import type { PrismaClient } from "../../prisma.js";
import {
	CleanupMaintenanceConflictError,
	withCleanupOperationGuard,
} from "../../library-cleanup/cleanup-maintenance-gate.js";
import { decryptBackupData, type EncryptedBackupEnvelope } from "../backup-crypto.js";
import { BackupService } from "../backup-service.js";

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
] as const;

function makePrismaWithCoordinationEvidence(): PrismaClient {
	const prisma: Record<string, unknown> = {};
	for (const tableName of TABLE_NAMES) {
		prisma[tableName] = {
			findMany: vi.fn().mockResolvedValue([]),
			count: vi.fn().mockResolvedValue(0),
		};
	}

	(prisma.trashSyncHistory as { findMany: ReturnType<typeof vi.fn> }).findMany.mockResolvedValue([
		{
			id: "rollback-active",
			instanceId: "instance-1",
			userId: "user-1",
			backupId: "snapshot-1",
			rollbackStatus: "IN_PROGRESS",
		},
	]);
	(prisma.serviceInstance as { findMany: ReturnType<typeof vi.fn> }).findMany.mockResolvedValue([
		{ id: "instance-1", userId: "user-1" },
	]);
	(prisma.trashBackup as { findMany: ReturnType<typeof vi.fn> }).findMany.mockResolvedValue([
		{
			id: "snapshot-1",
			instanceId: "instance-1",
			userId: "user-1",
			backupData: "required-rollback-evidence",
			createdAt: new Date("2020-01-01T00:00:00.000Z"),
			expiresAt: new Date("2020-01-02T00:00:00.000Z"),
		},
	]);
	prisma.backupSettings = { findUnique: vi.fn().mockResolvedValue(null) };

	return prisma as unknown as PrismaClient;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("BackupService coordination safety", () => {
	it("holds an exclusive maintenance boundary for the database export", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "backup-exclusive-"));
		const secretsPath = path.join(tempDir, "secrets.json");
		await fs.writeFile(
			secretsPath,
			JSON.stringify({
				encryptionKey: "test-encryption-key",
				sessionCookieSecret: "test-session-secret",
				backupPassword: "backup-exclusive-password",
			}),
		);
		const prisma = makePrismaWithCoordinationEvidence() as unknown as Record<string, unknown>;
		let releaseExport!: () => void;
		const exportBlocked = new Promise<void>((resolve) => {
			releaseExport = resolve;
		});
		let markExportStarted!: () => void;
		const exportStarted = new Promise<void>((resolve) => {
			markExportStarted = resolve;
		});
		(prisma.user as { findMany: ReturnType<typeof vi.fn> }).findMany.mockImplementationOnce(
			async () => {
				markExportStarted();
				await exportBlocked;
				return [];
			},
		);
		const service = new BackupService(prisma as unknown as PrismaClient, secretsPath);
		const creatingBackup = service.createBackup("3.0.0-beta", "scheduled");
		await exportStarted;

		try {
			await expect(withCleanupOperationGuard(async () => "mutation")).rejects.toBeInstanceOf(
				CleanupMaintenanceConflictError,
			);
		} finally {
			releaseExport();
			await creatingBackup;
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("emits a new payload version while preserving active coordination evidence", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "backup-safety-"));
		const secretsPath = path.join(tempDir, "secrets.json");
		const password = "backup-safety-password";
		await fs.writeFile(
			secretsPath,
			JSON.stringify({
				encryptionKey: "test-encryption-key",
				sessionCookieSecret: "test-session-secret",
				backupPassword: password,
			}),
		);
		const infoSpy = vi.spyOn(loggers.backup, "info");
		const service = new BackupService(makePrismaWithCoordinationEvidence(), secretsPath);

		try {
			const backup = await service.createBackup("3.0.0-beta", "scheduled");
			const filePath = path.join(tempDir, "backups", "scheduled", backup.filename);
			const envelope = JSON.parse(await fs.readFile(filePath, "utf-8")) as EncryptedBackupEnvelope;
			const payload = JSON.parse(await decryptBackupData(envelope, password)) as {
				version: string;
				data: {
					trashSyncHistory: Array<{ id: string }>;
					trashBackups: Array<{ id: string; backupData: string }>;
				};
			};

			expect(envelope.version).toBe("1.0");
			expect(payload.version).toBe("1.1");
			expect(payload.data.trashSyncHistory).toEqual([
				expect.objectContaining({ id: "rollback-active" }),
			]);
			expect(payload.data.trashBackups).toEqual([
				expect.objectContaining({
					id: "snapshot-1",
					backupData: "required-rollback-evidence",
				}),
			]);
			expect(infoSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					backupType: "scheduled",
					skippedTables: ["huntLog", "huntSearchHistory"],
					preservedTables: ["trashSyncHistory", "templateDeploymentHistory", "trashBackup"],
				}),
				"Backup excluded disposable operational history while preserving nonterminal TRaSH coordination evidence",
			);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
