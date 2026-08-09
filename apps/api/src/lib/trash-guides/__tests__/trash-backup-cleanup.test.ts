import { describe, expect, it, vi } from "vitest";
import { TrashBackupCleanupService } from "../trash-backup-cleanup.js";

function ledger(status: "pending" | "applied") {
	return JSON.stringify({
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
			action: "created",
			profileId: null,
			profileName: "Any",
			postStateToken: null,
		},
		namingDeployment: null,
	});
}

describe("TrashBackupCleanupService", () => {
	it("never deletes an expired pending or malformed current deployment ledger", async () => {
		const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
		const prisma = {
			trashBackup: {
				findMany: vi
					.fn()
					.mockResolvedValueOnce([
						{
							id: "pending",
							backupData: ledger("pending"),
							_count: { syncHistory: 1, deploymentHistory: 0 },
						},
						{
							id: "malformed",
							backupData: JSON.stringify({ schemaVersion: 2 }),
							_count: { syncHistory: 1, deploymentHistory: 0 },
						},
						{
							id: "terminal",
							backupData: ledger("applied"),
							_count: { syncHistory: 1, deploymentHistory: 0 },
						},
					])
					.mockResolvedValueOnce([]),
				deleteMany,
			},
		};
		const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
		const service = new TrashBackupCleanupService(prisma as never, logger as never);

		await expect(service.runCleanup()).resolves.toEqual({
			expiredCount: 1,
			orphanedCount: 0,
			totalCleaned: 1,
		});
		expect(prisma.trashBackup.findMany).toHaveBeenNthCalledWith(1, {
			where: {
				expiresAt: { not: null, lte: expect.any(Date) },
				syncHistory: { none: { rolledBack: false } },
				deploymentHistory: { none: { rolledBack: false } },
			},
			select: { id: true, backupData: true },
		});
		expect(deleteMany).toHaveBeenCalledTimes(1);
		expect(deleteMany).toHaveBeenCalledWith({
			where: {
				expiresAt: { not: null, lte: expect.any(Date) },
				syncHistory: { none: { rolledBack: false } },
				deploymentHistory: { none: { rolledBack: false } },
				OR: [{ id: "terminal", backupData: ledger("applied") }],
			},
		});
	});

	it("does not delete a backup when an unrolled history claims it after selection", async () => {
		const deleteMany = vi.fn().mockImplementation(async ({ where }) => ({
			count:
				where.syncHistory?.none?.rolledBack === false &&
				where.deploymentHistory?.none?.rolledBack === false
					? 0
					: 1,
		}));
		const prisma = {
			trashBackup: {
				findMany: vi
					.fn()
					.mockResolvedValueOnce([{ id: "race", backupData: ledger("applied") }])
					.mockResolvedValueOnce([]),
				deleteMany,
			},
		};
		const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
		const service = new TrashBackupCleanupService(prisma as never, logger as never);

		await expect(service.runCleanup()).resolves.toEqual({
			expiredCount: 0,
			orphanedCount: 0,
			totalCleaned: 0,
		});
		expect(deleteMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					syncHistory: { none: { rolledBack: false } },
					deploymentHistory: { none: { rolledBack: false } },
				}),
			}),
		);
	});
});
