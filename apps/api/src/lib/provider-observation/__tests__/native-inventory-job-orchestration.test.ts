import { describe, expect, it, vi } from "vitest";
import {
	runDueNativeInventoryWork,
	selectDueNativeInventoryRuns,
} from "../native-inventory-job-orchestration.js";
import type { NativeInventorySlicePhase } from "../native-inventory-job-runner.js";

function run(id: string, instanceId: string, updatedAt: number) {
	return {
		id,
		instanceId,
		workKey: "library",
		updatedAt: new Date(updatedAt),
		connectionGeneration: 1,
		identityGeneration: 1,
		instance: {
			id: instanceId,
			service: "JELLYFIN",
			enabled: true,
			identityStatus: "VERIFIED",
			connectionGeneration: 1,
			identityGeneration: 1,
		},
	};
}

const budget = {
	maxRuns: 2,
	maxConcurrent: 2,
	maxPagesPerRun: 1,
	pageSize: 1,
	maxDurationMs: 5_000,
	retryDelayMs: 0,
};

describe("durable native inventory due-work scheduler", () => {
	it("an already aborted scheduler does not look up or claim due work", async () => {
		const controller = new AbortController();
		controller.abort();
		const findMany = vi.fn(),
			executeRun = vi.fn();
		const app = { prisma: { providerNativeInventoryRun: { findMany } }, encryptor: {}, log: {} };
		expect(
			await runDueNativeInventoryWork(app as never, budget, {
				signal: controller.signal,
				executeRun,
			}),
		).toEqual({ completed: 0, retryable: 0, superseded: 0, incomplete: 0 });
		expect(findMany).not.toHaveBeenCalled();
		expect(executeRun).not.toHaveBeenCalled();
	});
	it("joins a due lookup and stops before dispatch when shutdown arrives during it", async () => {
		const controller = new AbortController();
		let release!: (runs: unknown[]) => void;
		const findMany = vi.fn(
				() =>
					new Promise<unknown[]>((resolve) => {
						release = resolve;
					}),
			),
			executeRun = vi.fn();
		const app = { prisma: { providerNativeInventoryRun: { findMany } }, encryptor: {}, log: {} };
		let settled = false;
		const pending = runDueNativeInventoryWork(app as never, budget, {
			signal: controller.signal,
			executeRun,
		}).finally(() => {
			settled = true;
		});
		controller.abort();
		await Promise.resolve();
		expect(settled).toBe(false);
		release([run("a", "a", 1)]);
		expect(await pending).toEqual({ completed: 0, retryable: 0, superseded: 0, incomplete: 0 });
		expect(executeRun).not.toHaveBeenCalled();
	});
	it("shutdown between batches admits no next run", async () => {
		const controller = new AbortController();
		const findMany = vi.fn().mockResolvedValue([run("a", "a", 1), run("b", "b", 2)]);
		const executeRun = vi.fn(async () => {
			controller.abort();
			return { status: "yielded" as const, pagesCommitted: 0 };
		});
		const app = { prisma: { providerNativeInventoryRun: { findMany } }, encryptor: {}, log: {} };
		expect(
			await runDueNativeInventoryWork(
				app as never,
				{ ...budget, maxConcurrent: 1 },
				{ signal: controller.signal, executeRun },
			),
		).toMatchObject({ retryable: 1 });
		expect(executeRun).toHaveBeenCalledOnce();
	});
	it("rotates across instances and never lets two domains of one instance occupy a tick", () => {
		const runs = [
			run("a-library", "a", 1),
			run("a-episode", "a", 2),
			run("b-library", "b", 3),
			run("c-library", "c", 4),
		];
		expect(selectDueNativeInventoryRuns(runs, 2, 0).map((item) => item.id)).toEqual([
			"a-library",
			"b-library",
		]);
		expect(selectDueNativeInventoryRuns(runs, 2, 1).map((item) => item.id)).toEqual([
			"b-library",
			"c-library",
		]);
		expect(selectDueNativeInventoryRuns(runs, 2, 2).map((item) => item.id)).toEqual([
			"c-library",
			"a-library",
		]);
	});

	it("runs only due, verified work through the injected read-only provider executor", async () => {
		const stale = { ...run("stale", "old", 0), connectionGeneration: 0 };
		const disabled = {
			...run("disabled", "off", 0),
			instance: { ...run("disabled", "off", 0).instance, enabled: false },
		};
		const findMany = vi
			.fn()
			.mockResolvedValue([run("a", "a", 1), run("b", "b", 2), stale, disabled]);
		const executeRun = vi
			.fn()
			.mockResolvedValueOnce({ status: "published", pagesCommitted: 1 })
			.mockResolvedValueOnce({ status: "yielded", pagesCommitted: 1 });
		const app = {
			prisma: { providerNativeInventoryRun: { findMany } },
			encryptor: { decrypt: vi.fn() },
			log: { info: vi.fn(), error: vi.fn() },
		};
		const result = await runDueNativeInventoryWork(app as never, budget, { executeRun });
		expect(result).toMatchObject({ completed: 1, retryable: 1, superseded: 0 });
		expect(executeRun).toHaveBeenCalledTimes(2);
		expect(new Set(executeRun.mock.calls.map(([candidate]) => candidate.instanceId)).size).toBe(2);
		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ activeSlotKey: { not: null } }),
			}),
		);
	});
	it("reports only a generic category if execution fails before claim recovery can persist", async () => {
		const findMany = vi.fn().mockResolvedValue([run("a", "a", 1)]);
		const warn = vi.fn();
		const app = {
			prisma: { providerNativeInventoryRun: { findMany } },
			encryptor: { decrypt: vi.fn() },
			log: { warn },
		};
		expect(
			await runDueNativeInventoryWork(app as never, budget, {
				executeRun: async () => {
					throw new Error("synthetic private provider detail");
				},
			}),
		).toMatchObject({ retryable: 1 });
		expect(JSON.stringify(warn.mock.calls)).not.toContain("synthetic private provider detail");
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ category: "unexpected-execution-error" }),
			"Native inventory execution could not be persisted",
		);
	});

	it("reports a bounded generic phase when a work slice remains unresolved", async () => {
		vi.useFakeTimers();
		const privateId = "synthetic-private-instance-id";
		const warn = vi.fn();
		let finish: ((value: { status: "yielded"; pagesCommitted: number }) => void) | undefined;
		const executeRun = vi.fn(
			(
				_candidate: unknown,
				options: { reportPhase?: (phase: NativeInventorySlicePhase) => void },
			) => {
				options.reportPhase?.("yield");
				return new Promise<{ status: "yielded"; pagesCommitted: number }>((resolve) => {
					finish = resolve;
				});
			},
		);
		const app = {
			prisma: {
				providerNativeInventoryRun: {
					findMany: vi.fn().mockResolvedValue([run(privateId, privateId, 1)]),
				},
			},
			encryptor: { decrypt: vi.fn() },
			log: { warn },
		};
		const task = runDueNativeInventoryWork(
			app as never,
			{ ...budget, maxDurationMs: 1_000 },
			{ executeRun },
		);
		try {
			await vi.advanceTimersByTimeAsync(0);
			expect(executeRun).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(61_000);
			expect(warn).toHaveBeenCalledOnce();
			expect(warn).toHaveBeenCalledWith(
				expect.objectContaining({
					category: "native-inventory-slice-overdue",
					workKey: "library",
					phase: "yield",
				}),
				"Native inventory slice exceeded its bounded work window",
			);
			expect(JSON.stringify(warn.mock.calls)).not.toContain(privateId);
		} finally {
			finish?.({ status: "yielded", pagesCommitted: 0 });
			await task;
			await vi.advanceTimersByTimeAsync(600_000);
			vi.useRealTimers();
		}
		expect(warn).toHaveBeenCalledOnce();
	});
});
