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
			{ quiClientFactory, quiFileHashIndexFactory } as never,
		);

		await (
			scheduler as unknown as {
				checkAndRun: () => Promise<void>;
			}
		).checkAndRun();

		expect(executorMocks.executeCleanupRun).toHaveBeenCalledWith(
			expect.objectContaining({ quiClientFactory, quiFileHashIndexFactory }),
			"user-1",
		);
	});
});
