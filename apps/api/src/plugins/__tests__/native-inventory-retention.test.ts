import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	schedule: vi.fn(),
	work: vi.fn(),
	prune: vi.fn(),
	worker: vi.fn(),
}));
vi.mock("../../lib/provider-observation/native-inventory-job-orchestration.js", () => ({
	NATIVE_INVENTORY_REFRESH_INTERVAL_MS: 30 * 60_000,
	schedulePeriodicNativeInventoryWork: mocks.schedule,
	runDueNativeInventoryWork: mocks.work,
}));
vi.mock("../../lib/provider-observation/native-inventory-retention.js", () => ({
	pruneNativeInventoryRetentionSlice: mocks.prune,
}));
vi.mock("../../lib/provider-observation/native-inventory-retention-worker-transport.js", () => ({
	runNativeInventoryRetentionWorker: mocks.worker,
}));

import {
	runNativeInventoryRetentionTick,
	runNativeInventorySchedulerTick,
} from "../native-inventory-scheduler.js";

const cursor = { id: "synthetic-cursor" };
function app() {
	return {
		prisma: {},
		config: { DATABASE_URL: "postgresql://fixture.invalid/synthetic" },
		encryptor: {},
		log: { info: vi.fn(), error: vi.fn() },
	};
}
beforeEach(() => {
	vi.restoreAllMocks();
	mocks.schedule.mockReset().mockResolvedValue(undefined);
	mocks.work.mockReset().mockResolvedValue({ completed: 0 });
	mocks.prune.mockReset().mockResolvedValue({
		deletedRows: 0,
		deletedRuns: 0,
		scannedRuns: 0,
		nextCursor: null,
		hasMore: false,
	});
	mocks.worker.mockReset();
});

describe("native retention scheduler admission", () => {
	it("logs only finite own diagnostic fields and preserves the generic registry error", async () => {
		const target = app();
		target.config.DATABASE_URL = "file:/synthetic/fixture.db";
		const getter = vi.fn(() => {
			throw new Error("private-getter");
		});
		const error = Object.defineProperty(
			{
				failurePhase: "retention",
				failureCode: "P2028",
				transportFailure: "worker-error",
				message: "private-error",
				cause: "private-cause",
			},
			"url",
			{ get: getter },
		);
		mocks.worker.mockRejectedValueOnce(error);
		await expect(runNativeInventoryRetentionTick(target as never)).rejects.toThrow(
			"Native inventory retention failed",
		);
		expect(target.log.error).toHaveBeenCalledWith(
			{
				category: "native-inventory-retention-failed",
				failurePhase: "retention",
				failureCode: "P2028",
				transportFailure: "worker-error",
			},
			"Native inventory retention failed",
		);
		expect(getter).not.toHaveBeenCalled();
		expect(JSON.stringify(target.log.error.mock.calls)).not.toContain("private");
	});
	it("collapses unknown, inherited and accessor diagnostics without invoking getters", async () => {
		const target = app();
		const getter = vi.fn(() => "P2028");
		mocks.prune.mockRejectedValueOnce(
			Object.defineProperty(Object.create({ transportFailure: "worker-error" }), "failureCode", {
				get: getter,
			}),
		);
		await expect(runNativeInventoryRetentionTick(target as never)).rejects.toThrow(
			"Native inventory retention failed",
		);
		expect(target.log.error).toHaveBeenCalledWith(
			{
				category: "native-inventory-retention-failed",
				failurePhase: "unknown",
				failureCode: "unknown",
			},
			"Native inventory retention failed",
		);
		expect(getter).not.toHaveBeenCalled();
	});
	it("keeps PostgreSQL direct while routing SQLite through joined workers", async () => {
		await runNativeInventoryRetentionTick(app() as never);
		expect(mocks.prune).toHaveBeenCalledOnce();
		expect(mocks.worker).not.toHaveBeenCalled();
		mocks.prune.mockClear();
		const target = app();
		target.config.DATABASE_URL = "file:/synthetic/fixture.db";
		const state = { cursor: null as typeof cursor | null };
		mocks.worker
			.mockResolvedValueOnce({
				status: "completed",
				deletedRows: 500,
				deletedRuns: 0,
				scannedRuns: 1,
				nextCursor: cursor,
				hasMore: true,
			})
			.mockResolvedValueOnce({
				status: "completed",
				deletedRows: 2,
				deletedRuns: 1,
				scannedRuns: 1,
				nextCursor: null,
				hasMore: false,
			});
		await runNativeInventoryRetentionTick(target as never, { retentionState: state });
		expect(mocks.prune).not.toHaveBeenCalled();
		expect(mocks.worker.mock.calls[0]?.[0]).toMatchObject({
			databaseUrl: "file:/synthetic/fixture.db",
			cutoff: expect.any(Date),
			rowLimit: 500,
			scanLimit: 10,
			cursor: null,
		});
		expect(mocks.worker.mock.calls[1]?.[0].cursor).toEqual(cursor);
		expect(state.cursor).toBeNull();
		expect(target.log.info).toHaveBeenCalledWith(
			{ category: "native-inventory-retention", deletedRows: 502, deletedRuns: 1, scannedRuns: 2 },
			"Native inventory retention completed",
		);
	});
	it("retains the prior committed SQLite cursor on later failure without fallback or phantom success", async () => {
		const target = app();
		target.config.DATABASE_URL = "file:/synthetic/fixture.db";
		const state = { cursor: null as typeof cursor | null };
		mocks.worker
			.mockResolvedValueOnce({
				status: "completed",
				deletedRows: 500,
				deletedRuns: 0,
				scannedRuns: 1,
				nextCursor: cursor,
				hasMore: true,
			})
			.mockRejectedValueOnce(new Error("synthetic-private-worker-error"));
		await expect(
			runNativeInventoryRetentionTick(target as never, { retentionState: state }),
		).rejects.toThrow("Native inventory retention failed");
		expect(state.cursor).toEqual(cursor);
		expect(mocks.worker).toHaveBeenCalledTimes(2);
		expect(mocks.prune).not.toHaveBeenCalled();
		expect(target.log.info).not.toHaveBeenCalled();
		expect(JSON.stringify(target.log.error.mock.calls)).not.toContain(
			"synthetic-private-worker-error",
		);
		mocks.worker.mockResolvedValueOnce({
			status: "completed",
			deletedRows: 2,
			deletedRuns: 1,
			scannedRuns: 1,
			nextCursor: null,
			hasMore: false,
		});
		await runNativeInventoryRetentionTick(target as never, { retentionState: state });
		expect(mocks.worker.mock.calls[2]?.[0].cursor).toEqual(cursor);
		expect(target.log.info).toHaveBeenCalledWith(
			{ category: "native-inventory-retention", deletedRows: 2, deletedRuns: 1, scannedRuns: 1 },
			"Native inventory retention completed",
		);
	});
	it("preserves the SQLite cursor when worker admission is cancelled", async () => {
		const target = app();
		target.config.DATABASE_URL = "file:/synthetic/fixture.db";
		const state = { cursor };
		mocks.worker.mockResolvedValueOnce({ status: "cancelled" });
		await runNativeInventoryRetentionTick(target as never, { retentionState: state });
		expect(state.cursor).toEqual(cursor);
		expect(mocks.prune).not.toHaveBeenCalled();
		expect(target.log.info).toHaveBeenCalledWith(
			{ category: "native-inventory-retention", deletedRows: 0, deletedRuns: 0, scannedRuns: 0 },
			"Native inventory retention completed",
		);
	});
	it("bounds fast maintenance admission and preserves a per-plugin cursor", async () => {
		const target = app();
		const state = { cursor: null as typeof cursor | null };
		mocks.prune.mockResolvedValue({
			deletedRows: 500,
			deletedRuns: 0,
			scannedRuns: 1,
			nextCursor: cursor,
			hasMore: true,
		});
		await runNativeInventoryRetentionTick(target as never, { retentionState: state });
		expect(mocks.prune).toHaveBeenCalledTimes(200);
		expect(target.log.info).toHaveBeenCalledWith(
			{
				category: "native-inventory-retention",
				deletedRows: 100_000,
				deletedRuns: 0,
				scannedRuns: 200,
			},
			"Native inventory retention completed",
		);
		expect(state.cursor).toEqual(cursor);
		expect(mocks.prune.mock.calls[0]?.[2]).toMatchObject({
			rowLimit: 500,
			scanLimit: 10,
			cursor: null,
		});
		mocks.prune.mockClear().mockResolvedValue({
			deletedRows: 2,
			deletedRuns: 1,
			scannedRuns: 1,
			nextCursor: null,
			hasMore: false,
		});
		await runNativeInventoryRetentionTick(target as never, { retentionState: state });
		expect(mocks.prune.mock.calls[0]?.[2].cursor).toEqual(cursor);
		expect(state.cursor).toBeNull();
		expect(JSON.stringify(target.log.info.mock.calls)).not.toContain("synthetic-cursor");
	});

	it("stops admitting slices once the two-second maintenance budget is spent", async () => {
		let elapsed = 0;
		vi.spyOn(performance, "now").mockImplementation(() => elapsed);
		mocks.prune.mockImplementation(async () => {
			elapsed += 2_001;
			return {
				deletedRows: 500,
				deletedRuns: 0,
				scannedRuns: 1,
				nextCursor: cursor,
				hasMore: true,
			};
		});
		await runNativeInventoryRetentionTick(app() as never);
		expect(mocks.prune).toHaveBeenCalledOnce();
	});

	it("does not admit maintenance after shutdown and stops between slices", async () => {
		const controller = new AbortController();
		mocks.prune.mockImplementation(async () => {
			controller.abort();
			return { deletedRows: 1, deletedRuns: 0, scannedRuns: 1, nextCursor: cursor, hasMore: true };
		});
		await runNativeInventoryRetentionTick(app() as never, { signal: controller.signal });
		expect(mocks.prune).toHaveBeenCalledOnce();
		mocks.prune.mockClear();
		await runNativeInventoryRetentionTick(app() as never, { signal: controller.signal });
		expect(mocks.prune).not.toHaveBeenCalled();
	});

	it("keeps the last committed cursor after a failure and logs no private detail", async () => {
		const target = app();
		const state = { cursor: null as typeof cursor | null };
		mocks.prune
			.mockResolvedValueOnce({
				deletedRows: 500,
				deletedRuns: 0,
				scannedRuns: 1,
				nextCursor: cursor,
				hasMore: true,
			})
			.mockRejectedValueOnce(new Error("synthetic-private-error"));
		await expect(
			runNativeInventoryRetentionTick(target as never, { retentionState: state }),
		).rejects.toThrow("Native inventory retention failed");
		expect(state.cursor).toEqual(cursor);
		expect(target.log.error).toHaveBeenCalledWith(
			{
				category: "native-inventory-retention-failed",
				failurePhase: "unknown",
				failureCode: "unknown",
			},
			"Native inventory retention failed",
		);
		expect(JSON.stringify(target.log.error.mock.calls)).not.toContain("synthetic-private-error");
	});

	it("runs maintenance independently after ordinary provider work failure", async () => {
		mocks.work.mockRejectedValue(new Error("synthetic-private-error"));
		await runNativeInventorySchedulerTick(app() as never);
		expect(mocks.prune).not.toHaveBeenCalled();
		await runNativeInventoryRetentionTick(app() as never);
		expect(mocks.prune).toHaveBeenCalledOnce();
		expect(mocks.prune.mock.calls[0]?.[1].getTime()).toBeLessThanOrEqual(
			Date.now() - 24 * 60 * 60_000,
		);
	});
});
