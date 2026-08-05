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

const completeResult = {
	upserted: 1,
	errors: 0,
	errorMessages: [],
	complete: true,
	completedAt: new Date(),
};

afterEach(() => {
	clearJellyfinCacheRefreshSingleFlightsForTests();
});

describe("runJellyfinCacheRefreshSingleFlight", () => {
	it("coalesces concurrent callers for the same instance", async () => {
		const gate = deferred<typeof completeResult>();
		const refresh = vi.fn(() => gate.promise);

		const first = runJellyfinCacheRefreshSingleFlight("instance-1", refresh);
		const second = runJellyfinCacheRefreshSingleFlight("instance-1", refresh);

		expect(first).toBe(second);
		await Promise.resolve();
		expect(refresh).toHaveBeenCalledTimes(1);
		gate.resolve(completeResult);
		await expect(Promise.all([first, second])).resolves.toEqual([completeResult, completeResult]);
	});

	it("allows a new attempt after the previous refresh settles", async () => {
		const refresh = vi.fn().mockResolvedValue(completeResult);

		await runJellyfinCacheRefreshSingleFlight("instance-1", refresh);
		await Promise.resolve();
		await runJellyfinCacheRefreshSingleFlight("instance-1", refresh);

		expect(refresh).toHaveBeenCalledTimes(2);
	});

	it("does not coalesce different service instances", async () => {
		const refreshOne = vi.fn().mockResolvedValue(completeResult);
		const refreshTwo = vi.fn().mockResolvedValue(completeResult);

		await Promise.all([
			runJellyfinCacheRefreshSingleFlight("instance-1", refreshOne),
			runJellyfinCacheRefreshSingleFlight("instance-2", refreshTwo),
		]);

		expect(refreshOne).toHaveBeenCalledOnce();
		expect(refreshTwo).toHaveBeenCalledOnce();
	});
});
