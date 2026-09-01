import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { withCleanupMaintenanceGuard } from "../../library-cleanup/cleanup-maintenance-gate.js";
import { MAX_HUNT_DURATION_MS } from "../constants.js";

const mocks = vi.hoisted(() => ({ executeHuntWithSdk: vi.fn() }));

vi.mock("../hunt-executor.js", () => ({
	executeHuntWithSdk: mocks.executeHuntWithSdk,
}));

import { getHuntingScheduler } from "../scheduler.js";

describe("hunting background restore barrier", () => {
	it("holds its lease until the uncancelled hunt executor settles", async () => {
		mocks.executeHuntWithSdk.mockReset();
		let releaseHunt!: (result: unknown) => void;
		mocks.executeHuntWithSdk.mockReturnValue(
			new Promise((resolve) => {
				releaseHunt = resolve;
			}),
		);
		const instance = { id: "hunt-instance", label: "Radarr", service: "RADARR" };
		const app = {
			prisma: {
				huntConfig: {
					findUnique: vi.fn().mockResolvedValue({ id: "config-1", instance }),
					update: vi.fn().mockResolvedValue({}),
				},
				huntLog: {
					findMany: vi.fn().mockResolvedValue([]),
					updateMany: vi.fn().mockResolvedValue({ count: 0 }),
					create: vi.fn().mockResolvedValue({ id: "log-1" }),
					update: vi.fn().mockResolvedValue({}),
				},
			},
			notificationService: { notify: vi.fn().mockResolvedValue(undefined) },
		} as unknown as FastifyInstance;
		const scheduler = getHuntingScheduler();
		scheduler.initialize(app);
		await Promise.resolve();
		await Promise.resolve();
		const run = (
			scheduler as unknown as {
				runHunt(instanceId: string, type: "missing" | "upgrade", manual: boolean): Promise<void>;
			}
		).runHunt(instance.id, "missing", true);
		await vi.waitFor(() => expect(mocks.executeHuntWithSdk).toHaveBeenCalledTimes(1));

		await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toMatchObject({
			statusCode: 409,
		});

		releaseHunt({
			itemsSearched: 0,
			itemsGrabbed: 0,
			searchedItems: [],
			grabbedItems: [],
			message: "No work",
			status: "skipped",
			apiCallsMade: 0,
		});
		await run;
		await expect(withCleanupMaintenanceGuard(async () => "restored")).resolves.toBe("restored");
	});

	it("rejects a retrigger after timeout until the uncancelled executor settles", async () => {
		vi.useFakeTimers();
		try {
			mocks.executeHuntWithSdk.mockReset();
			let releaseHunt!: (result: unknown) => void;
			mocks.executeHuntWithSdk.mockReturnValue(
				new Promise((resolve) => {
					releaseHunt = resolve;
				}),
			);
			const instance = { id: "timed-hunt", label: "Radarr", service: "RADARR" };
			const app = {
				prisma: {
					huntConfig: {
						findUnique: vi.fn().mockResolvedValue({ id: "config-2", instance }),
						update: vi.fn().mockResolvedValue({}),
					},
					huntLog: {
						findMany: vi.fn().mockResolvedValue([]),
						updateMany: vi.fn().mockResolvedValue({ count: 0 }),
						create: vi.fn().mockResolvedValue({ id: "log-2" }),
						update: vi.fn().mockResolvedValue({}),
					},
				},
				notificationService: { notify: vi.fn().mockResolvedValue(undefined) },
			} as unknown as FastifyInstance;
			const scheduler = getHuntingScheduler();
			scheduler.initialize(app);
			await vi.advanceTimersByTimeAsync(0);
			const run = (
				scheduler as unknown as {
					runHunt(instanceId: string, type: "missing" | "upgrade", manual: boolean): Promise<void>;
				}
			).runHunt(instance.id, "missing", true);
			await vi.advanceTimersByTimeAsync(0);
			expect(mocks.executeHuntWithSdk).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(MAX_HUNT_DURATION_MS + 1);
			await run;

			expect(scheduler.triggerManualHunt(instance.id, "missing")).toMatchObject({
				queued: false,
				message: expect.stringContaining("in progress"),
			});
			expect(mocks.executeHuntWithSdk).toHaveBeenCalledTimes(1);

			releaseHunt({
				itemsSearched: 0,
				itemsGrabbed: 0,
				searchedItems: [],
				grabbedItems: [],
				message: "late completion",
				status: "skipped",
				apiCallsMade: 0,
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(
				(
					scheduler as unknown as {
						activeHuntExecutions: Map<string, Promise<unknown>>;
					}
				).activeHuntExecutions.has(instance.id),
			).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reserves the instance before an asynchronous config lookup", async () => {
		mocks.executeHuntWithSdk.mockReset();
		mocks.executeHuntWithSdk.mockResolvedValue({
			itemsSearched: 0,
			itemsGrabbed: 0,
			searchedItems: [],
			grabbedItems: [],
			message: "No work",
			status: "skipped",
			apiCallsMade: 0,
		});
		let releaseConfig!: (config: unknown) => void;
		const findUnique = vi.fn(
			() =>
				new Promise((resolve) => {
					releaseConfig = resolve;
				}),
		);
		const instance = { id: "lookup-race", label: "Radarr", service: "RADARR" };
		const app = {
			prisma: {
				huntConfig: { findUnique, update: vi.fn().mockResolvedValue({}) },
				huntLog: {
					findMany: vi.fn().mockResolvedValue([]),
					updateMany: vi.fn().mockResolvedValue({ count: 0 }),
					create: vi.fn().mockResolvedValue({ id: "log-race" }),
					update: vi.fn().mockResolvedValue({}),
				},
			},
			notificationService: { notify: vi.fn().mockResolvedValue(undefined) },
		} as unknown as FastifyInstance;
		const scheduler = getHuntingScheduler();
		scheduler.initialize(app);
		await Promise.resolve();
		await Promise.resolve();
		const scheduled = (
			scheduler as unknown as {
				runHunt(instanceId: string, type: "missing" | "upgrade", manual: boolean): Promise<void>;
			}
		).runHunt(instance.id, "missing", false);
		await vi.waitFor(() => expect(findUnique).toHaveBeenCalledTimes(1));

		expect(scheduler.triggerManualHunt(instance.id, "missing")).toMatchObject({
			queued: false,
			message: expect.stringContaining("in progress"),
		});
		expect(mocks.executeHuntWithSdk).not.toHaveBeenCalled();

		releaseConfig({ id: "config-race", instance });
		await scheduled;
		expect(mocks.executeHuntWithSdk).toHaveBeenCalledTimes(1);
		expect(
			(
				scheduler as unknown as {
					activeHuntExecutions: Set<string>;
				}
			).activeHuntExecutions.has(instance.id),
		).toBe(false);
	});
});
