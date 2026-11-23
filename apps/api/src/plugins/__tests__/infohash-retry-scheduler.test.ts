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
	vi.restoreAllMocks();
});

async function startMetadataFailure(ids = ["failed-series"]) {
	vi.useFakeTimers();
	mocks.countBackfill.mockResolvedValueOnce(1).mockResolvedValue(0);
	mocks.countOutstanding.mockResolvedValue(0);
	mocks.countDue.mockResolvedValue(0);
	mocks.historySweep.mockResolvedValue({ rowsScanned: 1, rowsHashed: 0, rowsMissed: 1, errors: 0 });
	mocks.pathSweep.mockResolvedValue({ rowsScanned: 0, rowsHashed: 0, rowsMissed: 0, errors: 0 });
	mocks.episodeSweep.mockResolvedValue({ rowsScanned: 0, rowsHashed: 0, errors: 0 });
	mocks.episodeSync.mockResolvedValue({
		filesUpserted: 0,
		errors: 1,
		attemptedSeriesIds: ids,
		failedSeriesIds: ids,
	});
	const hooks = new Map<string, () => Promise<void>>();
	const intervals = vi.spyOn(globalThis, "setInterval");
	const app = {
		restoreRuntime: { runIndependentOperation: async (work: () => Promise<unknown>) => work() },
		log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		addHook: (name: string, hook: () => Promise<void>) => hooks.set(name, hook),
		schedulerRegistry: { track: async (_id: string, action: () => Promise<void>) => action() },
	};
	await infoHashBackfillSchedulerPlugin(app as never);
	await hooks.get("onReady")?.();
	await vi.advanceTimersByTimeAsync(90_000);
	return {
		app,
		close: () => hooks.get("onClose")?.(),
		tick(ms: number) {
			const callback = intervals.mock.calls.find(([, delay]) => delay === ms)?.[0];
			if (typeof callback !== "function") throw new Error("Missing interval");
			callback();
		},
	};
}

describe("infoHash deferred correlation recovery", () => {
	for (const remaining of [0, 1]) {
		it(`repairs failed metadata after the correlation backlog ${remaining === 0 ? "drains" : "stalls"}`, async () => {
			vi.useFakeTimers();
			mocks.countBackfill.mockResolvedValueOnce(1).mockResolvedValue(remaining);
			mocks.countOutstanding.mockResolvedValue(remaining);
			mocks.countDue.mockResolvedValue(0);
			mocks.historySweep.mockResolvedValue({
				rowsScanned: 1,
				rowsHashed: 0,
				rowsMissed: 1,
				errors: 0,
			});
			mocks.pathSweep.mockResolvedValue({
				rowsScanned: 0,
				rowsHashed: 0,
				rowsMissed: 0,
				errors: 0,
			});
			mocks.episodeSweep.mockResolvedValue({ rowsScanned: 0, rowsHashed: 0, errors: 0 });
			mocks.episodeSync
				.mockResolvedValueOnce({
					filesUpserted: 0,
					errors: 1,
					attemptedSeriesIds: ["failed-series"],
					failedSeriesIds: ["failed-series"],
				})
				.mockResolvedValue({
					filesUpserted: 1,
					errors: 0,
					attemptedSeriesIds: ["failed-series"],
					failedSeriesIds: [],
				});
			const hooks = new Map<string, () => Promise<void>>();
			const app = {
				restoreRuntime: { runIndependentOperation: async (work: () => Promise<unknown>) => work() },
				log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
				addHook: (name: string, hook: () => Promise<void>) => hooks.set(name, hook),
				schedulerRegistry: { track: async (_id: string, action: () => Promise<void>) => action() },
			};
			await infoHashBackfillSchedulerPlugin(app as never);
			await hooks.get("onReady")?.();
			try {
				await vi.advanceTimersByTimeAsync(30_000 + 60_000);
				expect(mocks.episodeSync).toHaveBeenCalledTimes(1);
				await vi.advanceTimersByTimeAsync(5 * 60_000);
				expect(mocks.episodeSync).toHaveBeenCalledTimes(2);
				expect(mocks.episodeSync).toHaveBeenLastCalledWith(
					expect.objectContaining({ seriesCap: 100, retrySeriesIds: ["failed-series"] }),
				);
				await vi.advanceTimersByTimeAsync(10 * 60_000);
				expect(mocks.episodeSync).toHaveBeenCalledTimes(2);
				expect(mocks.historySweep).toHaveBeenCalledTimes(1);
				expect(mocks.pathSweep).toHaveBeenCalledTimes(1);
			} finally {
				await hooks.get("onClose")?.();
			}
		});
	}

	for (const failure of ["errors", "throw"] as const) {
		it(`backs off known metadata ${failure} and exhausts three additional attempts`, async () => {
			const h = await startMetadataFailure();
			if (failure === "throw")
				mocks.episodeSync.mockRejectedValue(new Error("Synthetic retry failure"));
			try {
				await vi.advanceTimersByTimeAsync(5 * 60_000);
				expect(mocks.episodeSync).toHaveBeenCalledTimes(2);
				await vi.advanceTimersByTimeAsync(5 * 60_000);
				expect(mocks.episodeSync).toHaveBeenCalledTimes(2);
				await vi.advanceTimersByTimeAsync(5 * 60_000);
				expect(mocks.episodeSync).toHaveBeenCalledTimes(3);
				await vi.advanceTimersByTimeAsync(15 * 60_000);
				expect(mocks.episodeSync).toHaveBeenCalledTimes(3);
				await vi.advanceTimersByTimeAsync(5 * 60_000);
				expect(mocks.episodeSync).toHaveBeenCalledTimes(4);
				await vi.advanceTimersByTimeAsync(30 * 60_000);
				expect(mocks.episodeSync).toHaveBeenCalledTimes(4);
				expect(h.app.log.warn).toHaveBeenCalledWith(
					{ exhausted: 1 },
					expect.stringContaining("budget exhausted"),
				);
			} finally {
				await h.close();
			}
		});
	}

	it("admits known metadata repair even when the unrelated correlation probe throws", async () => {
		const h = await startMetadataFailure();
		mocks.countDue.mockRejectedValue(new Error("Synthetic count failure"));
		mocks.episodeSync.mockResolvedValue({
			filesUpserted: 1,
			errors: 0,
			attemptedSeriesIds: ["failed-series"],
			failedSeriesIds: [],
		});
		try {
			await vi.advanceTimersByTimeAsync(5 * 60_000);
			expect(mocks.episodeSync).toHaveBeenCalledTimes(2);
			expect(mocks.pathSweep).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(10 * 60_000);
			expect(mocks.episodeSync).toHaveBeenCalledTimes(2);
		} finally {
			await h.close();
		}
	});

	it("does not clear known repair hints from an unknown per-series retry outcome", async () => {
		const h = await startMetadataFailure();
		mocks.episodeSync.mockResolvedValue({ filesUpserted: 0, errors: 0 });
		try {
			await vi.advanceTimersByTimeAsync(35 * 60_000);
			expect(mocks.episodeSync).toHaveBeenCalledTimes(4);
			expect(h.app.log.warn).toHaveBeenCalledWith(
				{ exhausted: 1 },
				expect.stringContaining("budget exhausted"),
			);
		} finally {
			await h.close();
		}
	});

	it("bounds the failed-series queue and each repair batch without retrying dropped hints", async () => {
		const ids = Array.from({ length: 1001 }, (_, i) => `failed-${i}`);
		const h = await startMetadataFailure(ids);
		mocks.episodeSync.mockImplementation(async ({ retrySeriesIds }) => ({
			filesUpserted: 0,
			errors: 0,
			attemptedSeriesIds: retrySeriesIds,
			failedSeriesIds: [],
		}));
		try {
			await vi.advanceTimersByTimeAsync(55 * 60_000);
			const batches = mocks.episodeSync.mock.calls
				.slice(1)
				.map(([args]) => args.retrySeriesIds as string[]);
			expect(batches).toHaveLength(10);
			for (const batch of batches) expect(batch).toHaveLength(100);
			expect(batches.flat()).toEqual(ids.slice(0, 1000));
			expect(h.app.log.warn).toHaveBeenCalledWith(
				expect.objectContaining({ pendingSeries: 1000, overflow: 1 }),
				expect.any(String),
			);
		} finally {
			await h.close();
		}
	});

	it("clears repair hints when a normal sweep succeeds before their next probe", async () => {
		const h = await startMetadataFailure();
		mocks.episodeSync.mockResolvedValue({
			filesUpserted: 1,
			errors: 0,
			attemptedSeriesIds: ["failed-series"],
			failedSeriesIds: [],
		});
		try {
			h.tick(6 * 60 * 60_000);
			await vi.advanceTimersByTimeAsync(0);
			expect(mocks.episodeSync).toHaveBeenCalledTimes(2);
			await vi.advanceTimersByTimeAsync(10 * 60_000);
			expect(mocks.episodeSync).toHaveBeenCalledTimes(2);
		} finally {
			await h.close();
		}
	});

	it("does not guess retry targets after a whole-sweep exception or missing outcome fields", async () => {
		for (const throws of [false, true]) {
			const h = await startMetadataFailure([]);
			if (throws) mocks.episodeSync.mockRejectedValue(new Error("Unknown sweep failure"));
			else mocks.episodeSync.mockResolvedValue({ filesUpserted: 0, errors: 1 });
			try {
				h.tick(6 * 60 * 60_000);
				await vi.advanceTimersByTimeAsync(0);
				const before = mocks.episodeSync.mock.calls.length;
				await vi.advanceTimersByTimeAsync(60 * 60_000);
				expect(mocks.episodeSync).toHaveBeenCalledTimes(before);
				expect(
					h.app.log.warn.mock.calls.some(([, message]) =>
						String(message).includes("next catch-up"),
					),
				).toBe(false);
			} finally {
				await h.close();
			}
			vi.resetAllMocks();
			vi.restoreAllMocks();
			vi.useRealTimers();
		}
	});

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
