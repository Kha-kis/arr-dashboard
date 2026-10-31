import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	countBackfill: vi.fn(),
	countOutstanding: vi.fn(),
	countDue: vi.fn(),
	historySweep: vi.fn(),
	pathSweep: vi.fn(),
	episodeSweep: vi.fn(),
	episodeSync: vi.fn(),
}));

vi.mock("../../lib/library-sync/infohash-backfill.js", () => ({
	countBackfillCandidates: mocks.countBackfill,
	countOutstandingBackfillCandidates: mocks.countOutstanding,
	countDueDeferredCorrelationCandidates: mocks.countDue,
	runInfoHashBackfillSweep: mocks.historySweep,
}));
vi.mock("../../lib/library-sync/infohash-backfill-by-path.js", () => ({
	runPathBackfillSweep: mocks.pathSweep,
}));
vi.mock("../../lib/library-sync/episode-file-backfill.js", () => ({
	runEpisodeBackfillSweep: mocks.episodeSweep,
	runEpisodeFileSync: mocks.episodeSync,
}));

import infoHashBackfillSchedulerPlugin from "../infohash-backfill-scheduler.js";

afterEach(() => {
	vi.useRealTimers();
	vi.resetAllMocks();
});

describe("infoHash deferred correlation recovery", () => {
	it("reports unresolved deferrals honestly and retries due correlations without a full sync", async () => {
		vi.useFakeTimers();
		mocks.countBackfill.mockResolvedValue(0);
		mocks.countOutstanding.mockResolvedValue(22_610);
		mocks.countDue.mockResolvedValue(1);
		mocks.pathSweep.mockResolvedValue({ rowsScanned: 1, rowsHashed: 1, errors: 0 });
		mocks.episodeSweep.mockResolvedValue({ rowsScanned: 1, rowsHashed: 0, errors: 0 });
		const hooks = new Map<string, () => Promise<void>>();
		const info = vi.fn();
		const app = {
			restoreRuntime: { runIndependentOperation: async (work: () => Promise<unknown>) => work() },
			log: { info, warn: vi.fn(), error: vi.fn() },
			addHook: (name: string, hook: () => Promise<void>) => hooks.set(name, hook),
			schedulerRegistry: { track: async (_id: string, action: () => Promise<void>) => action() },
		};
		await infoHashBackfillSchedulerPlugin(app as never);
		await hooks.get("onReady")?.();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(info).toHaveBeenCalledWith(
			{ outstanding: 22_610 },
			"infoHash backfill: no currently eligible rows; unresolved backlog remains",
		);
		expect(info).not.toHaveBeenCalledWith("infoHash backfill: catch-up complete (backlog drained)");
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(mocks.countDue).toHaveBeenCalledTimes(1);
		expect(mocks.pathSweep).toHaveBeenCalledTimes(1);
		expect(mocks.episodeSweep).toHaveBeenCalledTimes(1);
		expect(mocks.pathSweep).toHaveBeenCalledWith(
			expect.objectContaining({ batchSize: 500, dueOnly: true }),
		);
		expect(mocks.episodeSweep).toHaveBeenCalledWith(
			expect.objectContaining({ batchSize: 1_000, dueOnly: true }),
		);
		expect(mocks.historySweep).not.toHaveBeenCalled();
		expect(mocks.episodeSync).not.toHaveBeenCalled();
		await hooks.get("onClose")?.();
	});

	it("syncs Sonarr file metadata once across multiple successful catch-up batches", async () => {
		vi.useFakeTimers();
		mocks.countBackfill
			.mockResolvedValueOnce(3_000)
			.mockResolvedValueOnce(2_000)
			.mockResolvedValueOnce(0);
		mocks.countOutstanding.mockResolvedValue(0);
		mocks.historySweep.mockResolvedValue({
			rowsScanned: 500,
			rowsHashed: 0,
			rowsMissed: 500,
			errors: 0,
		});
		mocks.pathSweep.mockResolvedValue({
			rowsScanned: 500,
			rowsHashed: 0,
			rowsMissed: 500,
			errors: 0,
		});
		mocks.episodeSync.mockResolvedValue({ filesUpserted: 0, errors: 0 });
		mocks.episodeSweep.mockResolvedValue({ rowsScanned: 2_000, rowsHashed: 0, errors: 0 });
		const hooks = new Map<string, () => Promise<void>>();
		const app = {
			restoreRuntime: { runIndependentOperation: async (work: () => Promise<unknown>) => work() },
			log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			addHook: (name: string, hook: () => Promise<void>) => hooks.set(name, hook),
			schedulerRegistry: { track: async (_id: string, action: () => Promise<void>) => action() },
		};
		await infoHashBackfillSchedulerPlugin(app as never);
		await hooks.get("onReady")?.();
		await vi.advanceTimersByTimeAsync(30_000 + 2 * 60_000);
		expect(mocks.historySweep).toHaveBeenCalledTimes(2);
		expect(mocks.episodeSync).toHaveBeenCalledTimes(1);
		expect(mocks.episodeSweep).toHaveBeenCalledTimes(2);
		expect(mocks.episodeSweep).toHaveBeenCalledWith(expect.objectContaining({ batchSize: 2_000 }));
		await hooks.get("onClose")?.();
	});
});
