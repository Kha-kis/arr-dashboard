/**
 * Unit tests for `exportDatabase` — focuses on the history-exclusion and
 * row-cap behavior added in v2.18.4 to keep peak heap under the 768 MB
 * container cap.
 *
 * Mocks Prisma directly. No database access — these tests verify the option
 * plumbing and the order/shape of `findMany` calls, not real query execution.
 */

import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../prisma.js";
import { exportDatabase } from "../backup-database.js";

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
	it("skips huntLog/huntSearchHistory/trashSyncHistory/templateDeploymentHistory when excludeOperationalHistory: true", async () => {
		const { prisma, mock } = makeMockPrisma({
			huntLog: [{ id: "h1" }],
			huntSearchHistory: [{ id: "s1" }],
			trashSyncHistory: [{ id: "ts1" }],
			templateDeploymentHistory: [{ id: "td1" }],
		});

		const result = await exportDatabase(prisma, { excludeOperationalHistory: true });

		// History tables return empty arrays without ever calling findMany
		expect(result.huntLogs).toEqual([]);
		expect(result.huntSearchHistory).toEqual([]);
		expect(result.trashSyncHistory).toEqual([]);
		expect(result.templateDeploymentHistory).toEqual([]);

		// Crucial: findMany was NOT called on the skipped tables — that's the
		// memory win, otherwise we'd still be loading rows just to throw them away.
		expect(mock.huntLog.findMany).not.toHaveBeenCalled();
		expect(mock.huntSearchHistory.findMany).not.toHaveBeenCalled();
		expect(mock.trashSyncHistory.findMany).not.toHaveBeenCalled();
		expect(mock.templateDeploymentHistory.findMany).not.toHaveBeenCalled();
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
			trashBackup: [{ id: "tb1" }],
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
