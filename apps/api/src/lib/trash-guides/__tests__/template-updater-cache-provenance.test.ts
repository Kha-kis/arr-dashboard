import { describe, expect, it, vi } from "vitest";
import { loggers } from "../../logger.js";
import { TemplateUpdater } from "../template-updater.js";
import { UpdateScheduler } from "../update-scheduler.js";

describe("TemplateUpdater cache provenance", () => {
	it("publishes cache entries only from the commit recorded with them", async () => {
		const commitHash = "0123456789abcdef0123456789abcdef01234567";
		const fetchConfigsAtCommit = vi.fn().mockResolvedValue([]);
		const fetchConfigs = vi.fn();
		const setVerified = vi.fn();
		const expectedProvenance = {
			version: 1 as const,
			repository: "trash-guides/guides",
			commitHash,
		};
		const updater = new TemplateUpdater(
			{} as never,
			{
				getLatestCommit: vi.fn().mockResolvedValue({ commitHash }),
			} as never,
			{
				getSnapshot: vi.fn().mockResolvedValue(null),
				getProvenance: vi.fn().mockResolvedValue({
					...expectedProvenance,
					commitHash: "old",
				}),
				setVerified,
			} as never,
			{
				getCommitProvenance: vi.fn().mockReturnValue(expectedProvenance),
				fetchConfigsAtCommit,
				fetchConfigs,
			} as never,
		);

		const result = await updater.refreshAllCaches("RADARR");

		expect(result).toMatchObject({ refreshed: 6, failed: 0, errors: [] });
		expect(fetchConfigsAtCommit).toHaveBeenCalledTimes(6);
		expect(fetchConfigsAtCommit).toHaveBeenCalledWith(
			"RADARR",
			"CUSTOM_FORMATS",
			commitHash,
			undefined,
		);
		expect(fetchConfigs).not.toHaveBeenCalled();
		expect(setVerified).toHaveBeenCalledTimes(6);
		for (const call of setVerified.mock.calls) {
			expect(call[3]).toEqual(expectedProvenance);
		}
	});
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((release) => {
		resolve = release;
	});
	return { promise, resolve };
}

describe("TemplateUpdater cache read cancellation", () => {
	const commitHash = "0123456789abcdef0123456789abcdef01234567";
	const provenance = { version: 1, repository: "trash-guides/guides", commitHash };

	function fixture() {
		const versionTracker = { getLatestCommit: vi.fn().mockResolvedValue({ commitHash }) };
		const cache = {
			getSnapshot: vi.fn().mockResolvedValue(null),
			getProvenance: vi.fn().mockResolvedValue(null),
			touchCache: vi.fn(),
			setVerified: vi.fn(),
		};
		const fetcher = {
			getCommitProvenance: vi.fn().mockReturnValue(provenance),
			fetchConfigsAtCommit: vi.fn().mockResolvedValue([]),
		};
		const updater = new TemplateUpdater(
			{} as never,
			versionTracker as never,
			cache as never,
			fetcher as never,
		);
		const controller = new AbortController();
		const reason = new Error("Synthetic shutdown");
		return { versionTracker, cache, fetcher, updater, controller, reason };
	}

	it("fences publication when an admitted GitHub read returns after cancellation", async () => {
		const { versionTracker, cache, fetcher, updater, controller, reason } = fixture();
		fetcher.fetchConfigsAtCommit.mockImplementationOnce(async () => {
			controller.abort(reason);
			return [];
		});

		await expect(updater.refreshAllCaches("RADARR", { signal: controller.signal })).rejects.toBe(
			reason,
		);
		expect(versionTracker.getLatestCommit).toHaveBeenCalledWith({ signal: controller.signal });
		expect(fetcher.fetchConfigsAtCommit).toHaveBeenCalledExactlyOnceWith(
			"RADARR",
			"CUSTOM_FORMATS",
			commitHash,
			{ signal: controller.signal },
		);
		expect(cache.setVerified).not.toHaveBeenCalled();
		expect(cache.touchCache).not.toHaveBeenCalled();
	});

	it("drains an entered cache write before stopping the next category", async () => {
		const { cache, fetcher, updater, controller, reason } = fixture();
		const entered = deferred();
		const release = deferred();
		cache.setVerified.mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
		});
		const completed = vi.fn();
		const refresh = updater
			.refreshAllCaches("RADARR", { signal: controller.signal })
			.then(completed, completed);
		try {
			await entered.promise;
			controller.abort(reason);
			await Promise.resolve();
			expect(completed).not.toHaveBeenCalled();
		} finally {
			release.resolve();
			await refresh;
		}
		expect(completed).toHaveBeenCalledExactlyOnceWith(reason);
		expect(cache.setVerified).toHaveBeenCalledExactlyOnceWith(
			"RADARR",
			"CUSTOM_FORMATS",
			[],
			provenance,
		);
		expect(fetcher.fetchConfigsAtCommit).toHaveBeenCalledTimes(1);
	});

	it.each(["touchCache", "setVerified"] as const)(
		"logs an entered %s failure after shutdown and preserves the cancellation reason",
		async (operation) => {
			const { cache, updater, controller, reason } = fixture();
			const entered = deferred();
			const release = deferred();
			const warn = vi.spyOn(loggers.trashGuides, "warn").mockImplementation(() => {});
			if (operation === "touchCache") cache.getProvenance.mockResolvedValueOnce(provenance);
			cache[operation].mockImplementationOnce(async () => {
				entered.resolve();
				await release.promise;
				throw new Error("Synthetic private database error text");
			});
			const refresh = updater.refreshAllCaches("RADARR", { signal: controller.signal });
			try {
				await entered.promise;
				controller.abort(reason);
				release.resolve();
				await expect(refresh).rejects.toBe(reason);
				expect(cache.getProvenance).toHaveBeenCalledTimes(1);
				expect(warn).toHaveBeenCalledExactlyOnceWith(
					{ serviceType: "RADARR", configType: "CUSTOM_FORMATS", operation },
					"TRaSH cache write failed during shutdown",
				);
			} finally {
				warn.mockRestore();
			}
		},
	);

	it("joins cache siblings on scheduler shutdown and preserves the prior completed check", async () => {
		const { versionTracker, cache, fetcher, updater } = fixture();
		const notifyFn = vi.fn();
		const scheduler = new UpdateScheduler(
			{ enabled: false, intervalHours: 12 },
			updater,
			versionTracker as never,
			{
				trashTemplate: {
					count: vi.fn().mockResolvedValue(0),
					findMany: vi.fn().mockResolvedValue([]),
				},
				qualitySizeMapping: { count: vi.fn().mockResolvedValue(0) },
				namingConfig: { count: vi.fn().mockResolvedValue(0) },
			} as never,
			{ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			undefined,
			{ notifyFn },
		);
		await scheduler.triggerCheck();
		const previous = scheduler.getStats();
		expect(previous.lastCheckResult?.cachesRefreshed).toBe(12);
		cache.setVerified.mockClear();
		fetcher.fetchConfigsAtCommit.mockClear();

		const reading = deferred();
		const releaseRead = deferred();
		const writing = deferred();
		const releaseWrite = deferred();
		const aborted = vi.fn();
		fetcher.fetchConfigsAtCommit.mockImplementation(
			async (service, _configType, _commit, options?: { signal?: AbortSignal }) => {
				if (service === "SONARR") return [];
				reading.resolve();
				const signal = options?.signal;
				signal?.addEventListener(
					"abort",
					() => {
						aborted(signal.reason);
						releaseRead.resolve();
					},
					{ once: true },
				);
				await releaseRead.promise;
				return [];
			},
		);
		cache.setVerified.mockImplementationOnce(async () => {
			writing.resolve();
			await releaseWrite.promise;
		});

		const check = scheduler.triggerCheck().catch((error) => error);
		await Promise.all([reading.promise, writing.promise]);
		const drained = vi.fn();
		const closing = scheduler.shutdown().then(drained);
		try {
			expect(aborted).toHaveBeenCalledOnce();
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(drained).not.toHaveBeenCalled();
		} finally {
			releaseRead.resolve();
			releaseWrite.resolve();
			await closing;
		}
		expect(await check).toBe(aborted.mock.calls[0]?.[0]);
		expect(cache.setVerified).toHaveBeenCalledTimes(1);
		expect(fetcher.fetchConfigsAtCommit).toHaveBeenCalledTimes(2);
		expect(scheduler.getStats().lastCheckAt).toBe(previous.lastCheckAt);
		expect(scheduler.getStats().lastCheckResult).toBe(previous.lastCheckResult);
		expect(notifyFn).not.toHaveBeenCalled();
	});
});
