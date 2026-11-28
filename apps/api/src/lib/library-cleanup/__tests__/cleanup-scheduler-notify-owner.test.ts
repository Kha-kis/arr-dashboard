import { describe, expect, it, vi } from "vitest";

const executorMocks = vi.hoisted(() => ({ executeCleanupRun: vi.fn() }));
const recoveryMocks = vi.hoisted(() => ({
	recoverAllPendingTerminalAudits: vi
		.fn()
		.mockResolvedValue({ candidates: 0, recovered: 0, failed: 0 }),
	retryAllPendingMediaServerRescans: vi.fn().mockResolvedValue({
		targets: 0,
		triggered: 0,
		failed: 0,
		warnings: [],
	}),
}));
vi.mock("../cleanup-executor.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../cleanup-executor.js")>()),
	executeCleanupRun: executorMocks.executeCleanupRun,
}));
vi.mock("../media-server-rescan.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../media-server-rescan.js")>()),
	recoverAllPendingTerminalAudits: recoveryMocks.recoverAllPendingTerminalAudits,
	retryAllPendingMediaServerRescans: recoveryMocks.retryAllPendingMediaServerRescans,
}));

import { CleanupScheduler } from "../cleanup-scheduler.js";

describe("library cleanup notification ownership", () => {
	it("passes the scheduled config owner with its notification", async () => {
		executorMocks.executeCleanupRun.mockResolvedValue({
			isDryRun: false,
			status: "completed",
			itemsEvaluated: 1,
			itemsFlagged: 1,
			itemsRemoved: 0,
			itemsUnmonitored: 0,
			itemsFilesDeleted: 0,
			itemsSkipped: 0,
			details: [],
			durationMs: 1,
		});
		const notify = vi.fn().mockResolvedValue(undefined);
		const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
		for (const userId of ["owner-a", "owner-b"]) {
			const config = {
				id: `config-${userId}`,
				userId,
				enabled: true,
				nextRunAt: new Date(Date.now() - 1_000),
				intervalHours: 24,
				dryRunMode: false,
			};
			const prisma = {
				libraryCleanupConfig: {
					findFirst: vi.fn().mockResolvedValue(config),
					update: vi.fn().mockResolvedValue({}),
				},
			};
			const scheduler = new CleanupScheduler(
				prisma as never,
				{} as never,
				{} as never,
				logger as never,
				notify,
			);

			await (scheduler as unknown as { runDueCleanup: () => Promise<void> }).runDueCleanup();
		}

		expect(notify).toHaveBeenCalledTimes(2);
		expect(notify).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ eventType: "CLEANUP_ITEMS_FLAGGED" }),
			"owner-a",
		);
		expect(notify).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ eventType: "CLEANUP_ITEMS_FLAGGED" }),
			"owner-b",
		);
	});

	it("scopes a scheduled cleanup failure to the owner resolved before execution", async () => {
		executorMocks.executeCleanupRun.mockRejectedValue(new Error("Synthetic cleanup failure"));
		const config = {
			id: "config-owner-a",
			userId: "owner-a",
			enabled: true,
			nextRunAt: new Date(Date.now() - 1_000),
			intervalHours: 24,
			dryRunMode: false,
		};
		const notify = vi.fn().mockResolvedValue(undefined);
		const prisma = {
			libraryCleanupApproval: { findFirst: vi.fn().mockResolvedValue(null) },
			libraryCleanupConfig: {
				findFirst: vi.fn().mockResolvedValue(config),
				update: vi.fn().mockResolvedValue({}),
			},
		};
		const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
		const scheduler = new CleanupScheduler(
			prisma as never,
			{} as never,
			{} as never,
			logger as never,
			notify,
		);

		await (scheduler as unknown as { checkAndRun: () => Promise<void> }).checkAndRun();

		expect(notify).toHaveBeenCalledWith(
			expect.objectContaining({ eventType: "SYSTEM_ERROR" }),
			"owner-a",
		);
	});
});
