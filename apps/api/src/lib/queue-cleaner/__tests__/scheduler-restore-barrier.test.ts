import { describe, expect, it, vi } from "vitest";
import { withCleanupMaintenanceGuard } from "../../library-cleanup/cleanup-maintenance-gate.js";
import { MAX_CLEAN_DURATION_MS } from "../constants.js";

const mocks = vi.hoisted(() => ({
	executeQueueCleaner: vi.fn(),
	executeEnhancedPreview: vi.fn(),
}));

vi.mock("../cleaner-executor.js", () => ({
	executeQueueCleaner: mocks.executeQueueCleaner,
	executeEnhancedPreview: mocks.executeEnhancedPreview,
}));

import { getQueueCleanerScheduler } from "../scheduler.js";

describe("queue cleaner background restore barrier", () => {
	it("holds an independent lease while startup log reaping is pending", async () => {
		const scheduler = getQueueCleanerScheduler();
		let releaseFind!: (rows: unknown[]) => void;
		const findMany = vi.fn(
			() =>
				new Promise<unknown[]>((resolve) => {
					releaseFind = resolve;
				}),
		);
		scheduler.initialize({
			prisma: {
				queueCleanerLog: {
					findMany,
					updateMany: vi.fn().mockResolvedValue({ count: 0 }),
				},
			},
		} as never);
		await vi.waitFor(() => expect(findMany).toHaveBeenCalledTimes(1));

		await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toMatchObject({
			statusCode: 409,
		});

		releaseFind([]);
		await vi.waitFor(async () => {
			await expect(withCleanupMaintenanceGuard(async () => "restored")).resolves.toBe("restored");
		});
	});

	it("keeps a dedicated operation lease until a queued manual clean settles", async () => {
		const scheduler = getQueueCleanerScheduler();
		const app = {
			prisma: {
				queueCleanerLog: {
					findMany: vi.fn().mockResolvedValue([]),
					updateMany: vi.fn().mockResolvedValue({ count: 0 }),
				},
			},
		} as never;
		scheduler.initialize(app);
		await Promise.resolve();
		await Promise.resolve();

		let releaseClean!: () => void;
		const runClean = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					releaseClean = resolve;
				}),
		);
		const schedulerInternals = scheduler as unknown as {
			runClean(instanceId: string): Promise<void>;
		};
		const runCleanSpy = vi.spyOn(schedulerInternals, "runClean").mockImplementation(runClean);

		await expect(scheduler.triggerManualClean("restore-barrier-instance")).resolves.toMatchObject({
			triggered: true,
		});
		expect(runClean).toHaveBeenCalledWith("restore-barrier-instance");

		const maintenanceWork = vi.fn();
		await expect(withCleanupMaintenanceGuard(async () => maintenanceWork())).rejects.toMatchObject({
			statusCode: 409,
		});
		expect(maintenanceWork).not.toHaveBeenCalled();

		releaseClean();
		await vi.waitFor(async () => {
			await expect(withCleanupMaintenanceGuard(async () => "restored")).resolves.toBe("restored");
		});
		runCleanSpy.mockRestore();
	});

	it("rejects a retrigger after timeout until the uncancelled executor settles", async () => {
		vi.useFakeTimers();
		try {
			mocks.executeQueueCleaner.mockReset();
			const scheduler = getQueueCleanerScheduler();
			let releaseExecution!: (result: unknown) => void;
			mocks.executeQueueCleaner.mockReturnValue(
				new Promise((resolve) => {
					releaseExecution = resolve;
				}),
			);
			const instance = { id: "timeout-instance", label: "Radarr", service: "RADARR" };
			const app = {
				prisma: {
					queueCleanerConfig: {
						findUnique: vi.fn().mockResolvedValue({
							instanceId: instance.id,
							instance,
							dryRunMode: false,
						}),
					},
					queueCleanerLog: {
						findMany: vi.fn().mockResolvedValue([]),
						updateMany: vi.fn().mockResolvedValue({ count: 0 }),
						create: vi.fn().mockResolvedValue({ id: "log-1" }),
						update: vi.fn().mockResolvedValue({}),
					},
				},
				notificationService: { notify: vi.fn().mockResolvedValue(undefined) },
			} as never;
			scheduler.initialize(app);
			await vi.advanceTimersByTimeAsync(0);

			await expect(scheduler.triggerManualClean(instance.id)).resolves.toMatchObject({
				triggered: true,
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(mocks.executeQueueCleaner).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(MAX_CLEAN_DURATION_MS + 1);

			await expect(scheduler.triggerManualClean(instance.id)).resolves.toMatchObject({
				triggered: false,
				message: expect.stringContaining("in progress"),
			});
			expect(mocks.executeQueueCleaner).toHaveBeenCalledTimes(1);

			releaseExecution({
				itemsCleaned: 0,
				itemsSkipped: 0,
				itemsWarned: 0,
				cleanedItems: [],
				skippedItems: [],
				warnedItems: [],
				isDryRun: false,
				status: "success",
				message: "late completion",
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(
				(
					scheduler as unknown as {
						activeCleanerExecutions: Map<string, Promise<unknown>>;
					}
				).activeCleanerExecutions.has(instance.id),
			).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});
