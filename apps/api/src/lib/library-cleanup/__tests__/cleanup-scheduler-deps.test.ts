import { beforeEach, describe, expect, it, vi } from "vitest";

const executorMocks = vi.hoisted(() => ({
	executeCleanupRun: vi.fn(),
}));

vi.mock("../cleanup-executor.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../cleanup-executor.js")>()),
	executeCleanupRun: executorMocks.executeCleanupRun,
}));

import { CleanupScheduler } from "../cleanup-scheduler.js";

describe("library cleanup scheduler dependencies", () => {
	beforeEach(() => {
		executorMocks.executeCleanupRun.mockReset().mockResolvedValue({
			isDryRun: false,
			status: "completed",
			itemsEvaluated: 0,
			itemsFlagged: 0,
			itemsRemoved: 0,
			itemsUnmonitored: 0,
			itemsFilesDeleted: 0,
			itemsSkipped: 0,
			details: [],
			durationMs: 1,
			prefetchHealth: { seerr: "skipped", plex: "skipped", jellyfin: "skipped" },
		});
	});

	it("passes complete qUI mutation-boundary factories to scheduled execution", async () => {
		const quiClientFactory = vi.fn();
		const quiFileHashIndexFactory = vi.fn();
		const externalRuleCacheRefresher = vi.fn();
		const prisma = {
			libraryCleanupApproval: {
				updateMany: vi.fn().mockResolvedValue({ count: 0 }),
			},
			libraryCleanupConfig: {
				findFirst: vi.fn().mockResolvedValue({
					id: "config-1",
					userId: "user-1",
					enabled: true,
					nextRunAt: new Date(0),
					intervalHours: 24,
					dryRunMode: false,
				}),
				update: vi.fn().mockResolvedValue({}),
			},
		};
		const scheduler = new CleanupScheduler(
			prisma as never,
			{} as never,
			{} as never,
			{ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
			undefined,
			{ quiClientFactory, quiFileHashIndexFactory, externalRuleCacheRefresher } as never,
		);

		await (
			scheduler as unknown as {
				checkAndRun: () => Promise<void>;
			}
		).checkAndRun();

		expect(executorMocks.executeCleanupRun).toHaveBeenCalledWith(
			expect.objectContaining({
				quiClientFactory,
				quiFileHashIndexFactory,
				externalRuleCacheRefresher,
			}),
			"user-1",
		);
	});

	it("keeps scheduled dry-run cadence read-only and in process", async () => {
		executorMocks.executeCleanupRun.mockResolvedValueOnce({
			isDryRun: true,
			status: "completed",
			itemsEvaluated: 1,
			itemsFlagged: 1,
			itemsRemoved: 0,
			itemsUnmonitored: 0,
			itemsFilesDeleted: 0,
			itemsSkipped: 0,
			details: [{ action: "delete" }],
			durationMs: 1,
		});
		const config = {
			id: "config-dry-run",
			userId: "user-1",
			enabled: true,
			nextRunAt: new Date(0),
			updatedAt: new Date("2026-08-15T00:00:00.000Z"),
			intervalHours: 24,
			dryRunMode: true,
		};
		const update = vi.fn().mockResolvedValue({});
		const notify = vi.fn().mockResolvedValue(undefined);
		const prisma = {
			libraryCleanupApproval: {
				findMany: vi.fn().mockResolvedValue([]),
				updateMany: vi.fn().mockResolvedValue({ count: 0 }),
			},
			libraryCleanupConfig: {
				findFirst: vi.fn().mockResolvedValue(config),
				update,
			},
		};
		const scheduler = new CleanupScheduler(
			prisma as never,
			{} as never,
			{} as never,
			{ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
			notify,
		);
		const checkAndRun = () =>
			(scheduler as unknown as { checkAndRun: () => Promise<void> }).checkAndRun();

		await checkAndRun();
		await checkAndRun();

		expect(executorMocks.executeCleanupRun).toHaveBeenCalledOnce();
		expect(update).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
	});
});
