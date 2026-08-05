import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clearJellyfinCacheRefreshSingleFlightsForTests,
	runJellyfinCacheRefreshSingleFlight,
} from "../jellyfin-cache-singleflight.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

type CacheRefreshResult = {
	upserted: number;
	errors: number;
	errorMessages: string[];
	complete: boolean;
	completedAt?: Date;
};

const completeResult: CacheRefreshResult = {
	upserted: 1,
	errors: 0,
	errorMessages: [],
	complete: true,
	completedAt: new Date(),
};

function makeObserver() {
	const upsert = vi.fn().mockResolvedValue({});
	const warn = vi.fn();
	return {
		observer: {
			prisma: { cacheRefreshStatus: { upsert } } as never,
			log: { warn },
		},
		upsert,
		warn,
	};
}

afterEach(() => {
	clearJellyfinCacheRefreshSingleFlightsForTests();
});

describe("runJellyfinCacheRefreshSingleFlight", () => {
	it("coalesces concurrent callers for the same instance", async () => {
		const gate = deferred<CacheRefreshResult>();
		const refresh = vi.fn(() => gate.promise);
		const { observer } = makeObserver();

		const first = runJellyfinCacheRefreshSingleFlight("instance-1", refresh, observer);
		const second = runJellyfinCacheRefreshSingleFlight("instance-1", refresh, observer);

		expect(first).toBe(second);
		await Promise.resolve();
		expect(refresh).toHaveBeenCalledTimes(1);
		gate.resolve(completeResult);
		await expect(Promise.all([first, second])).resolves.toEqual([completeResult, completeResult]);
	});

	it("allows a new attempt after the previous refresh settles", async () => {
		const refresh = vi.fn().mockResolvedValue(completeResult);
		const { observer } = makeObserver();

		await runJellyfinCacheRefreshSingleFlight("instance-1", refresh, observer);
		await Promise.resolve();
		await runJellyfinCacheRefreshSingleFlight("instance-1", refresh, observer);

		expect(refresh).toHaveBeenCalledTimes(2);
	});

	it("does not coalesce different service instances", async () => {
		const refreshOne = vi.fn().mockResolvedValue(completeResult);
		const refreshTwo = vi.fn().mockResolvedValue(completeResult);
		const { observer } = makeObserver();

		await Promise.all([
			runJellyfinCacheRefreshSingleFlight("instance-1", refreshOne, observer),
			runJellyfinCacheRefreshSingleFlight("instance-2", refreshTwo, observer),
		]);

		expect(refreshOne).toHaveBeenCalledOnce();
		expect(refreshTwo).toHaveBeenCalledOnce();
	});

	it("records an incomplete refresh once for all coalesced callers", async () => {
		const gate = deferred<CacheRefreshResult>();
		const refresh = vi.fn(() => gate.promise);
		const { observer, upsert } = makeObserver();
		const incomplete = {
			...completeResult,
			errors: 1,
			errorMessages: ["Jellyfin request timed out"],
			complete: false,
			completedAt: undefined,
		};

		const first = runJellyfinCacheRefreshSingleFlight("instance-1", refresh, observer);
		const second = runJellyfinCacheRefreshSingleFlight("instance-1", refresh, observer);
		gate.resolve(incomplete);
		await Promise.all([first, second]);

		expect(upsert).toHaveBeenCalledOnce();
		expect(upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				update: expect.objectContaining({
					lastAttemptResult: "error",
					lastAttemptErrorMessage: "Jellyfin request timed out",
				}),
			}),
		);
	});

	it("records a thrown refresh failure and preserves the original rejection", async () => {
		const failure = new Error("upstream connection reset");
		const refresh = vi.fn().mockRejectedValue(failure);
		const { observer, upsert } = makeObserver();

		await expect(runJellyfinCacheRefreshSingleFlight("instance-1", refresh, observer)).rejects.toBe(
			failure,
		);

		expect(upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				update: expect.not.objectContaining({ lastRefreshedAt: expect.anything() }),
			}),
		);
	});
});
