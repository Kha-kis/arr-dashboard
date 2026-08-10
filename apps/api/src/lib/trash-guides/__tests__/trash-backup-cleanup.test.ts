import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
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

function legacyUnknownQualityBackup() {
	return JSON.stringify({
		customFormats: [],
		qualityProfile: {
			id: 4,
			name: "Legacy",
			upgradeAllowed: true,
			cutoff: 0,
			items: [
				{
					id: 0,
					name: "Unknown",
					allowed: false,
					quality: { id: 0, name: "Unknown" },
					items: [],
				},
			],
			minFormatScore: 0,
			cutoffFormatScore: 0,
			minUpgradeFormatScore: 0,
			formatItems: [],
		},
	});
}

describe("TrashBackupCleanupService", () => {
	it.each(["expired", "orphaned"] as const)(
		"retains uncertain and current ledgers during %s cleanup while deleting known legacy backups",
		async (phase) => {
			const candidates = [
				{ id: "applied-v2", backupData: ledger("applied") },
				{ id: "pending-v2", backupData: ledger("pending") },
				{ id: "malformed-v2", backupData: JSON.stringify({ schemaVersion: 2 }) },
				{ id: "future", backupData: JSON.stringify({ schemaVersion: 3 }) },
				{ id: "missing-version", backupData: JSON.stringify({ endpointKey: "current-like" }) },
				{ id: "string-version", backupData: JSON.stringify({ schemaVersion: "2" }) },
				{
					id: "malformed-legacy-profile",
					backupData: JSON.stringify({ customFormats: [], qualityProfile: {} }),
				},
				{
					id: "malformed-legacy-cf",
					backupData: JSON.stringify([{ id: 7, name: "Incomplete" }]),
				},
				{ id: "legacy-array", backupData: JSON.stringify([]) },
				{
					id: "legacy-object",
					backupData: JSON.stringify({ customFormats: [], qualityProfile: null }),
				},
				{ id: "legacy-unknown-quality", backupData: legacyUnknownQualityBackup() },
			].map((candidate) => ({
				...candidate,
				_count: { syncHistory: 0, deploymentHistory: 0 },
			}));
			const deleteMany = vi.fn().mockResolvedValue({ count: 3 });
			const prisma = {
				trashBackup: {
					findMany: vi
						.fn()
						.mockResolvedValueOnce(phase === "expired" ? candidates : [])
						.mockResolvedValueOnce(phase === "orphaned" ? candidates : []),
					deleteMany,
				},
			};
			const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
			const service = new TrashBackupCleanupService(prisma as never, logger as never);

			await expect(service.runCleanup()).resolves.toEqual({
				expiredCount: phase === "expired" ? 3 : 0,
				orphanedCount: phase === "orphaned" ? 3 : 0,
				totalCleaned: 3,
			});
			expect(deleteMany).toHaveBeenCalledTimes(1);
			expect(deleteMany).toHaveBeenCalledWith({
				where: expect.objectContaining({
					syncHistory: { none: { rolledBack: false } },
					deploymentHistory: { none: { rolledBack: false } },
					OR: [
						{ id: "legacy-array", backupData: JSON.stringify([]) },
						{
							id: "legacy-object",
							backupData: JSON.stringify({ customFormats: [], qualityProfile: null }),
						},
						{
							id: "legacy-unknown-quality",
							backupData: legacyUnknownQualityBackup(),
						},
					],
				}),
			});
		},
	);

	it.each(["expired", "orphaned"] as const)(
		"uses bounded keyset pages and advances past retained %s ledgers",
		async (phase) => {
			type CandidateQuery = {
				where: {
					expiresAt?: unknown;
					createdAt?: unknown;
					id?: { gt: string };
				};
				orderBy?: { id: string };
				take?: number;
			};

			const retainedPrefix = `${phase}-retained`;
			let retainedPageLastId = "";
			let initialPageReads = 0;
			const findMany = vi.fn(async (query: CandidateQuery) => {
				const isTargetQuery =
					phase === "expired"
						? query.where.expiresAt !== undefined
						: query.where.createdAt !== undefined;
				if (!isTargetQuery) return [];

				if (!query.where.id) {
					initialPageReads++;
					if (initialPageReads > 1) {
						throw new Error(`${phase} cleanup did not advance past the retained page`);
					}
					const pageSize = query.take ?? 2;
					const page = Array.from({ length: pageSize }, (_, index) => ({
						id: `${retainedPrefix}-${String(index).padStart(4, "0")}`,
						backupData: ledger("pending"),
						_count: { syncHistory: 0, deploymentHistory: 0 },
					}));
					retainedPageLastId = page.at(-1)!.id;
					return page;
				}

				if (query.where.id.gt === retainedPageLastId) {
					return [
						{
							id: `${phase}-zz-legacy`,
							backupData: JSON.stringify([]),
							_count: { syncHistory: 0, deploymentHistory: 0 },
						},
					];
				}

				throw new Error(`Unexpected ${phase} cleanup cursor: ${query.where.id.gt}`);
			});
			const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
			const prisma = { trashBackup: { findMany, deleteMany } };
			const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
			const service = new TrashBackupCleanupService(prisma as never, logger as never);

			await expect(service.runCleanup()).resolves.toEqual({
				expiredCount: phase === "expired" ? 1 : 0,
				orphanedCount: phase === "orphaned" ? 1 : 0,
				totalCleaned: 1,
			});

			const targetQueries = findMany.mock.calls
				.map(([query]) => query)
				.filter((query) =>
					phase === "expired"
						? query.where.expiresAt !== undefined
						: query.where.createdAt !== undefined,
				);
			expect(targetQueries).toHaveLength(2);
			expect(targetQueries[0]).toEqual(
				expect.objectContaining({
					orderBy: { id: "asc" },
					take: expect.any(Number),
				}),
			);
			expect(targetQueries[0]!.take).toBeGreaterThan(0);
			expect(targetQueries[0]!.take).toBeLessThanOrEqual(400);
			expect(targetQueries[1]).toEqual(
				expect.objectContaining({
					where: expect.objectContaining({ id: { gt: retainedPageLastId } }),
					orderBy: { id: "asc" },
					take: targetQueries[0]!.take,
				}),
			);
			expect(deleteMany).toHaveBeenCalledTimes(1);
		},
	);

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
							id: "legacy",
							backupData: JSON.stringify([]),
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
			orderBy: { id: "asc" },
			take: 400,
		});
		expect(deleteMany).toHaveBeenCalledTimes(1);
		expect(deleteMany).toHaveBeenCalledWith({
			where: {
				expiresAt: { not: null, lte: expect.any(Date) },
				syncHistory: { none: { rolledBack: false } },
				deploymentHistory: { none: { rolledBack: false } },
				OR: [{ id: "legacy", backupData: JSON.stringify([]) }],
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
					.mockResolvedValueOnce([{ id: "race", backupData: JSON.stringify([]) }])
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

	it.each([499, 500])(
		"deletes %i legacy candidates through bounded real SQLite batches",
		async (candidateCount) => {
			const directory = await mkdtemp(join(tmpdir(), "trash-backup-cleanup-"));
			const databasePath = join(directory, "cleanup.db");
			const prisma = createTestPrismaClient(databasePath);
			try {
				await prisma.$executeRawUnsafe(`
					CREATE TABLE "trash_backups" (
						"id" TEXT NOT NULL PRIMARY KEY,
						"instanceId" TEXT NOT NULL,
						"userId" TEXT NOT NULL,
						"backupData" TEXT NOT NULL,
						"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
						"expiresAt" DATETIME
					)
				`);
				await prisma.$executeRawUnsafe(`
					CREATE TABLE "trash_sync_history" (
						"id" TEXT NOT NULL PRIMARY KEY,
						"backupId" TEXT,
						"rolledBack" BOOLEAN NOT NULL DEFAULT false
					)
				`);
				await prisma.$executeRawUnsafe(`
					CREATE TABLE "template_deployment_history" (
						"id" TEXT NOT NULL PRIMARY KEY,
						"backupId" TEXT,
						"rolledBack" BOOLEAN NOT NULL DEFAULT false
					)
				`);

				const records = Array.from({ length: candidateCount }, (_, index) => ({
					id: `backup-${index}`,
					instanceId: "instance",
					userId: "user",
					backupData: JSON.stringify([]),
					createdAt: new Date("2026-01-01T00:00:00.000Z"),
					expiresAt: new Date("2026-01-02T00:00:00.000Z"),
				}));
				for (let index = 0; index < records.length; index += 100) {
					await prisma.trashBackup.createMany({ data: records.slice(index, index + 100) });
				}

				const deleteMany = vi.spyOn(prisma.trashBackup, "deleteMany");
				const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
				const service = new TrashBackupCleanupService(prisma, logger as never);

				await expect(service.runCleanup()).resolves.toEqual({
					expiredCount: candidateCount,
					orphanedCount: 0,
					totalCleaned: candidateCount,
				});
				expect(deleteMany).toHaveBeenCalledTimes(2);
				await expect(prisma.trashBackup.count()).resolves.toBe(0);
			} finally {
				await prisma.$disconnect();
				await rm(directory, { recursive: true, force: true });
			}
		},
	);
});
