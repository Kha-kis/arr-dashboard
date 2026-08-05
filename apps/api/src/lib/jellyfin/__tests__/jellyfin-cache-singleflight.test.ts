import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clearJellyfinCacheRefreshSingleFlightsForTests,
	runJellyfinCacheRefreshSingleFlight,
} from "../jellyfin-cache-singleflight.js";
import { jellyfinConnectionFingerprint } from "../service-instance-fingerprint.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

type CacheRefreshResult = {
	upserted: number;
	errors: number;
	errorMessages: string[];
	complete: boolean;
	completedAt?: Date;
	superseded?: boolean;
};

const completeResult: CacheRefreshResult = {
	upserted: 1,
	errors: 0,
	errorMessages: [],
	complete: true,
	completedAt: new Date(),
};

type TestConnection = {
	service: "JELLYFIN" | "EMBY";
	baseUrl: string;
	encryptedApiKey: string;
	encryptionIv: string;
	encryptedHttpAuthCredentials: string | null;
	httpAuthEncryptionIv: string | null;
	enabled: boolean;
};

const connectionOne: TestConnection = {
	service: "JELLYFIN",
	baseUrl: "https://jellyfin-one.example.com",
	encryptedApiKey: "key-one",
	encryptionIv: "iv-one",
	encryptedHttpAuthCredentials: null,
	httpAuthEncryptionIv: null,
	enabled: true,
};
const connectionTwo: TestConnection = {
	...connectionOne,
	baseUrl: "https://jellyfin-two.example.com",
	encryptedApiKey: "key-two",
};
const fingerprintOne = jellyfinConnectionFingerprint(connectionOne as never);
const fingerprintTwo = jellyfinConnectionFingerprint(connectionTwo as never);

function makeObserver(currentConnection = connectionOne) {
	const upsert = vi.fn().mockResolvedValue({});
	const warn = vi.fn();
	const tx = {
		$queryRawUnsafe: vi.fn().mockResolvedValue([]),
		serviceInstance: { findUnique: vi.fn().mockResolvedValue(currentConnection) },
		cacheRefreshStatus: { upsert },
	};
	const transaction = vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
		callback(tx),
	);
	return {
		observer: {
			prisma: { $transaction: transaction } as never,
			log: { warn },
		},
		upsert,
		warn,
		transaction,
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

		const first = runJellyfinCacheRefreshSingleFlight(
			"instance-1",
			fingerprintOne,
			refresh,
			observer,
		);
		const second = runJellyfinCacheRefreshSingleFlight(
			"instance-1",
			fingerprintOne,
			refresh,
			observer,
		);

		expect(first).toBe(second);
		await Promise.resolve();
		expect(refresh).toHaveBeenCalledTimes(1);
		gate.resolve(completeResult);
		await expect(Promise.all([first, second])).resolves.toEqual([completeResult, completeResult]);
	});

	it("allows a new attempt after the previous refresh settles", async () => {
		const refresh = vi.fn().mockResolvedValue(completeResult);
		const { observer } = makeObserver();

		await runJellyfinCacheRefreshSingleFlight("instance-1", fingerprintOne, refresh, observer);
		await Promise.resolve();
		await runJellyfinCacheRefreshSingleFlight("instance-1", fingerprintOne, refresh, observer);

		expect(refresh).toHaveBeenCalledTimes(2);
	});

	it("does not coalesce different service instances", async () => {
		const refreshOne = vi.fn().mockResolvedValue(completeResult);
		const refreshTwo = vi.fn().mockResolvedValue(completeResult);
		const { observer } = makeObserver();

		await Promise.all([
			runJellyfinCacheRefreshSingleFlight("instance-1", fingerprintOne, refreshOne, observer),
			runJellyfinCacheRefreshSingleFlight("instance-2", fingerprintTwo, refreshTwo, observer),
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

		const first = runJellyfinCacheRefreshSingleFlight(
			"instance-1",
			fingerprintOne,
			refresh,
			observer,
		);
		const second = runJellyfinCacheRefreshSingleFlight(
			"instance-1",
			fingerprintOne,
			refresh,
			observer,
		);
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

		await expect(
			runJellyfinCacheRefreshSingleFlight("instance-1", fingerprintOne, refresh, observer),
		).rejects.toBe(failure);

		expect(upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				update: expect.not.objectContaining({ lastRefreshedAt: expect.anything() }),
			}),
		);
	});

	it("does not join an in-flight refresh from an older connection identity", async () => {
		const firstGate = deferred<CacheRefreshResult>();
		const secondGate = deferred<CacheRefreshResult>();
		const firstRefresh = vi.fn(() => firstGate.promise);
		const secondRefresh = vi.fn(() => secondGate.promise);
		const { observer } = makeObserver(connectionTwo);

		const first = runJellyfinCacheRefreshSingleFlight(
			"instance-1",
			fingerprintOne,
			firstRefresh,
			observer,
		);
		const second = runJellyfinCacheRefreshSingleFlight(
			"instance-1",
			fingerprintTwo,
			secondRefresh,
			observer,
		);

		expect(first).not.toBe(second);
		await Promise.resolve();
		expect(firstRefresh).toHaveBeenCalledWith(fingerprintOne);
		expect(secondRefresh).toHaveBeenCalledWith(fingerprintTwo);
		firstGate.resolve(completeResult);
		secondGate.resolve(completeResult);
		await Promise.all([first, second]);
	});

	it("does not mark a superseded connection as a failure on the current instance", async () => {
		const refresh = vi.fn().mockResolvedValue({
			...completeResult,
			complete: false,
			completedAt: undefined,
			superseded: true,
		});
		const { observer, upsert } = makeObserver(connectionTwo);

		await runJellyfinCacheRefreshSingleFlight("instance-1", fingerprintOne, refresh, observer);

		expect(upsert).not.toHaveBeenCalled();
	});

	it.each(["incomplete", "rejected"] as const)(
		"discards an old-connection %s result that settles after the new connection succeeds",
		async (outcome) => {
			const oldGate = deferred<CacheRefreshResult>();
			const oldRefresh = vi.fn(() => oldGate.promise);
			const newRefresh = vi.fn().mockResolvedValue(completeResult);
			const { observer, upsert } = makeObserver(connectionTwo);

			const oldAttempt = runJellyfinCacheRefreshSingleFlight(
				"instance-1",
				fingerprintOne,
				oldRefresh,
				observer,
			);
			await runJellyfinCacheRefreshSingleFlight("instance-1", fingerprintTwo, newRefresh, observer);

			if (outcome === "incomplete") {
				oldGate.resolve({
					...completeResult,
					errors: 1,
					errorMessages: ["old endpoint timed out"],
					complete: false,
					completedAt: undefined,
				});
				await oldAttempt;
			} else {
				oldGate.reject(new Error("old endpoint connection reset"));
				await expect(oldAttempt).rejects.toThrow("old endpoint connection reset");
			}

			expect(upsert).not.toHaveBeenCalled();
		},
	);
});
