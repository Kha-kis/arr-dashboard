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

	it("persists a pending warning at the deadline and retains ownership until the real result settles", async () => {
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
			let currentMessage: string | null = null;
			let terminalData: Record<string, unknown> | undefined;
			const updateMany = vi.fn(
				async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
					if (args.where.id === "log-1" && args.where.status === "running")
						currentMessage = String(args.data.message ?? "");
					return { count: 1 };
				},
			);
			const queueCleanerLogUpdate = vi.fn(async (args: { data: Record<string, unknown> }) => {
				terminalData = args.data;
				return {};
			});
			const app = {
				prisma: {
					queueCleanerConfig: {
						findUnique: vi.fn().mockResolvedValue({
							instanceId: instance.id,
							instance,
							dryRunMode: false,
						}),
						update: vi.fn().mockResolvedValue({}),
					},
					queueCleanerLog: {
						findMany: vi.fn().mockResolvedValue([]),
						updateMany,
						create: vi.fn().mockResolvedValue({ id: "log-1" }),
						update: vi.fn().mockResolvedValue({}),
					},
					$transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
						callback({
							queueCleanerLog: { update: queueCleanerLogUpdate },
							queueCleanerConfig: { update: vi.fn().mockResolvedValue({}) },
						}),
					),
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

			await vi.advanceTimersByTimeAsync(MAX_CLEAN_DURATION_MS - 1);
			expect(currentMessage).toBeNull();
			await vi.advanceTimersByTimeAsync(1);
			await vi.waitFor(() => expect(currentMessage).toContain("has not produced a final result"));
			expect(currentMessage).toContain("do not retry");
			expect(terminalData).toBeUndefined();
			expect(
				(app as never as { notificationService: { notify: ReturnType<typeof vi.fn> } })
					.notificationService.notify,
			).not.toHaveBeenCalled();
			await expect(scheduler.triggerManualClean(instance.id)).resolves.toMatchObject({
				triggered: false,
				message: expect.stringContaining("in progress"),
			});
			await expect(withCleanupMaintenanceGuard(async () => "restored")).rejects.toMatchObject({
				statusCode: 409,
			});

			releaseExecution({
				itemsCleaned: 4,
				itemsSkipped: 2,
				itemsWarned: 0,
				cleanedItems: [{ title: "Synthetic item", rule: "test" }],
				skippedItems: [],
				warnedItems: [],
				isDryRun: false,
				status: "completed",
				message: "settled result",
			});
			await vi.advanceTimersByTimeAsync(0);
			await vi.waitFor(() => expect(terminalData?.status).toBe("completed"));
			expect(terminalData).toMatchObject({ itemsCleaned: 4, itemsSkipped: 2, status: "completed" });
			expect(queueCleanerLogUpdate).toHaveBeenCalledTimes(1);
			expect(mocks.executeQueueCleaner).toHaveBeenCalledTimes(1);
			await vi.waitFor(async () => {
				await expect(withCleanupMaintenanceGuard(async () => "restored")).resolves.toBe("restored");
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("lets a later due instance run after the bounded scheduled wait while retaining the slow instance", async () => {
		vi.useFakeTimers();
		try {
			mocks.executeQueueCleaner.mockReset();
			const scheduler = getQueueCleanerScheduler();
			let releaseSlow!: (result: unknown) => void;
			const first = { id: "scheduled-slow", label: "Slow Radarr", service: "RADARR" };
			const second = { id: "scheduled-fast", label: "Fast Radarr", service: "RADARR" };
			let configs = [first, second].map((instance) => ({
				instanceId: instance.id,
				instance,
				intervalMins: 1,
				dryRunMode: false,
			}));
			mocks.executeQueueCleaner.mockImplementation((_app, instance) => {
				if (instance.id === first.id) {
					return new Promise((resolve) => {
						releaseSlow = resolve;
					});
				}
				return Promise.resolve({
					itemsCleaned: 1,
					itemsSkipped: 0,
					itemsWarned: 0,
					cleanedItems: [],
					skippedItems: [],
					warnedItems: [],
					isDryRun: false,
					status: "completed",
					message: "fast result",
				});
			});
			const logRows: Array<{ id: string; data: Record<string, unknown> }> = [];
			const app = {
				prisma: {
					queueCleanerConfig: {
						findMany: vi.fn(async () => configs),
						findUnique: vi.fn(
							async ({ where }: { where: { instanceId: string } }) =>
								configs.find((config) => config.instanceId === where.instanceId) ?? null,
						),
					},
					queueCleanerLog: {
						findMany: vi.fn().mockResolvedValue([]),
						updateMany: vi.fn().mockResolvedValue({ count: 1 }),
						create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
							const row = { id: String(data.instanceId), data };
							logRows.push(row);
							return { id: row.id };
						}),
					},
					$transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
						callback({
							queueCleanerLog: { update: vi.fn().mockResolvedValue({}) },
							queueCleanerConfig: { update: vi.fn().mockResolvedValue({}) },
						}),
					),
				},
			};
			scheduler.initialize(app as never);
			await vi.advanceTimersByTimeAsync(0);
			const internals = scheduler as unknown as { processScheduledCleans(): Promise<void> };
			const firstTick = internals.processScheduledCleans();
			await vi.advanceTimersByTimeAsync(0);
			expect(mocks.executeQueueCleaner).toHaveBeenCalledTimes(2);
			await vi.advanceTimersByTimeAsync(MAX_CLEAN_DURATION_MS);
			await firstTick;
			expect(logRows.find((row) => row.id === first.id)?.data.status).toBe("running");

			configs = [first, second].map((instance) => ({
				instanceId: instance.id,
				instance,
				intervalMins: 1,
				dryRunMode: false,
			}));
			const nextTick = internals.processScheduledCleans();
			await vi.advanceTimersByTimeAsync(0);
			await nextTick;
			expect(mocks.executeQueueCleaner).toHaveBeenCalledTimes(3);
			expect(mocks.executeQueueCleaner.mock.calls.map((call) => call[1].id)).toEqual([
				first.id,
				second.id,
				second.id,
			]);
			expect(logRows.find((row) => row.id === first.id)?.data.status).toBe("running");

			releaseSlow({
				itemsCleaned: 2,
				itemsSkipped: 0,
				itemsWarned: 0,
				cleanedItems: [],
				skippedItems: [],
				warnedItems: [],
				isDryRun: false,
				status: "completed",
				message: "slow result",
			});
			await vi.advanceTimersByTimeAsync(0);
			await vi.waitFor(async () =>
				expect(
					(
						scheduler as unknown as { activeCleanerExecutions: Map<string, Promise<unknown>> }
					).activeCleanerExecutions.has(first.id),
				).toBe(false),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not create a second start-failure row when terminal reporting itself is unavailable", async () => {
		vi.useFakeTimers();
		try {
			mocks.executeQueueCleaner.mockReset();
			const scheduler = getQueueCleanerScheduler();
			let rejectExecution!: (error: Error) => void;
			mocks.executeQueueCleaner.mockReturnValue(
				new Promise((_, reject) => {
					rejectExecution = reject;
				}),
			);
			const instance = { id: "timeout-reporting-error", label: "Radarr", service: "RADARR" };
			const create = vi.fn().mockResolvedValue({ id: "single-log" });
			const updateMany = vi.fn(
				async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
					if (args.where.id === "single-log" && args.data.status === "error")
						throw new Error("synthetic database reporting failure");
					return { count: 1 };
				},
			);
			const notify = vi.fn().mockResolvedValue(undefined);
			const app = {
				prisma: {
					queueCleanerConfig: {
						findUnique: vi
							.fn()
							.mockResolvedValue({ instanceId: instance.id, instance, dryRunMode: false }),
					},
					queueCleanerLog: {
						findMany: vi.fn().mockResolvedValue([]),
						updateMany,
						create,
						update: vi.fn().mockResolvedValue({}),
					},
				},
				notificationService: { notify },
			} as never;
			scheduler.initialize(app);
			await vi.advanceTimersByTimeAsync(0);
			await scheduler.triggerManualClean(instance.id);
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(MAX_CLEAN_DURATION_MS);
			await vi.waitFor(() => expect(updateMany).toHaveBeenCalledTimes(1));
			rejectExecution(new Error("synthetic provider outcome unavailable"));
			await vi.advanceTimersByTimeAsync(0);
			await vi.waitFor(() => expect(updateMany).toHaveBeenCalledTimes(2));
			expect(create).toHaveBeenCalledTimes(1);
			expect(notify).not.toHaveBeenCalled();
			await vi.waitFor(async () => {
				await expect(withCleanupMaintenanceGuard(async () => "released")).resolves.toBe("released");
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("records uncertainty after post-deadline executor failure without releasing ownership early", async () => {
		vi.useFakeTimers();
		try {
			mocks.executeQueueCleaner.mockReset();
			const scheduler = getQueueCleanerScheduler();
			let rejectExecution!: (error: Error) => void;
			mocks.executeQueueCleaner.mockReturnValue(
				new Promise((_, reject) => {
					rejectExecution = reject;
				}),
			);
			const instance = { id: "timeout-error-instance", label: "Radarr", service: "RADARR" };
			let pendingMessage: string | null = null;
			let terminalMessage: string | null = null;
			let terminalData: Record<string, unknown> | undefined;
			const notify = vi.fn().mockResolvedValue(undefined);
			const failureUpdateMany = vi.fn(
				async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
					if (args.where.id === "log-error" && args.where.status === "running")
						pendingMessage = String(args.data.message ?? "");
					if (args.where.id === "log-error" && args.data.status === "error") {
						terminalMessage = String(args.data.message ?? "");
						terminalData = args.data;
					}
					return { count: 1 };
				},
			);
			const app = {
				prisma: {
					queueCleanerConfig: {
						findUnique: vi
							.fn()
							.mockResolvedValue({ instanceId: instance.id, instance, dryRunMode: false }),
					},
					queueCleanerLog: {
						findMany: vi.fn().mockResolvedValue([]),
						updateMany: failureUpdateMany,
						create: vi.fn().mockResolvedValue({ id: "log-error" }),
						update: vi.fn().mockResolvedValue({}),
					},
				},
				notificationService: { notify },
			} as never;
			scheduler.initialize(app);
			await vi.advanceTimersByTimeAsync(0);
			await scheduler.triggerManualClean(instance.id);
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(MAX_CLEAN_DURATION_MS);
			await vi.waitFor(() => expect(pendingMessage).toContain("has not produced a final result"));
			expect(terminalMessage).toBeNull();
			await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toMatchObject({
				statusCode: 409,
			});

			rejectExecution(new Error("synthetic provider outcome unavailable"));
			await vi.advanceTimersByTimeAsync(0);
			await vi.waitFor(() =>
				expect(terminalMessage).toContain("Some provider actions may have completed"),
			);
			expect(terminalMessage).toContain("review the upstream queue before retrying");
			expect(terminalData).toMatchObject({ status: "error", completedAt: expect.any(Date) });
			expect(notify).toHaveBeenCalledTimes(1);
			expect(notify).toHaveBeenCalledWith(
				expect.objectContaining({ eventType: "QUEUE_CLEANER_FAILED" }),
				expect.any(Object),
			);
			expect(mocks.executeQueueCleaner).toHaveBeenCalledTimes(1);
			await vi.waitFor(async () => {
				await expect(withCleanupMaintenanceGuard(async () => "released")).resolves.toBe("released");
			});
		} finally {
			vi.useRealTimers();
		}
	});
});
