import { afterEach, describe, expect, it, vi } from "vitest";
import type { OwnedProviderPublicationSnapshot } from "../../services/provider-identity-guard.js";
import {
	clearJellyfinCacheRefreshSingleFlightsForTests,
	runJellyfinCacheRefreshSingleFlight,
} from "../jellyfin-cache-singleflight.js";

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

function publicationSnapshot(
	overrides: Partial<OwnedProviderPublicationSnapshot> = {},
): OwnedProviderPublicationSnapshot {
	return {
		id: "instance-1",
		userId: "user-1",
		service: "JELLYFIN",
		label: "Jellyfin",
		baseUrl: "https://jellyfin.example.com",
		apiKey: "decrypted-key",
		httpAuthHeaders: {},
		enabled: true,
		encryptedApiKey: "encrypted-key",
		encryptionIv: "key-iv",
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
		expectedIdentity: "server-a",
		identityStatus: "VERIFIED",
		connectionGeneration: 7,
		identityGeneration: 3,
		...overrides,
	};
}

function makeObserver(current = publicationSnapshot()) {
	const upsert = vi.fn().mockResolvedValue({});
	const warn = vi.fn();
	const tx = {
		libraryCleanupConfig: {
			upsert: vi.fn().mockResolvedValue({ id: "cleanup-config-1" }),
			findUnique: vi.fn().mockResolvedValue({ runClaimToken: null }),
		},
		serviceInstance: {
			findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
				Object.entries(where).every(
					([key, value]) => current[key as keyof OwnedProviderPublicationSnapshot] === value,
				)
					? { id: current.id }
					: null,
			),
		},
		cacheRefreshStatus: { findUnique: vi.fn().mockResolvedValue(null), upsert },
	};
	return {
		observer: {
			prisma: {
				$transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
					callback(tx),
				),
			} as never,
			log: { warn },
		},
		upsert,
	};
}

afterEach(() => clearJellyfinCacheRefreshSingleFlightsForTests());

describe("runJellyfinCacheRefreshSingleFlight", () => {
	it("does not coalesce an identity-only replacement with an older attempt", async () => {
		const gate = deferred<CacheRefreshResult>();
		const refresh = vi.fn(() => gate.promise);
		const { observer } = makeObserver();

		const first = runJellyfinCacheRefreshSingleFlight(publicationSnapshot(), refresh, observer);
		const second = runJellyfinCacheRefreshSingleFlight(
			publicationSnapshot({ identityGeneration: 4 }),
			refresh,
			observer,
		);

		expect(first).not.toBe(second);
		await Promise.resolve();
		expect(refresh).toHaveBeenCalledTimes(2);
		gate.resolve(completeResult);
		await Promise.all([first, second]);
	});

	it("coalesces concurrent callers with the exact same authority", async () => {
		const gate = deferred<CacheRefreshResult>();
		const refresh = vi.fn(() => gate.promise);
		const { observer } = makeObserver();
		const instance = publicationSnapshot();

		const first = runJellyfinCacheRefreshSingleFlight(instance, refresh, observer);
		const second = runJellyfinCacheRefreshSingleFlight(instance, refresh, observer);

		expect(first).toBe(second);
		await Promise.resolve();
		expect(refresh).toHaveBeenCalledOnce();
		gate.resolve(completeResult);
		await Promise.all([first, second]);
	});

	it("does not coalesce scheduler work with cleanup-owned publication", async () => {
		const gate = deferred<CacheRefreshResult>();
		const refresh = vi.fn(() => gate.promise);
		const { observer } = makeObserver();
		const instance = publicationSnapshot();

		const scheduler = runJellyfinCacheRefreshSingleFlight(instance, refresh, observer);
		const cleanup = runJellyfinCacheRefreshSingleFlight(instance, refresh, observer, {
			cleanupRunClaimToken: "cleanup-run",
		});

		expect(scheduler).not.toBe(cleanup);
		await Promise.resolve();
		expect(refresh).toHaveBeenCalledTimes(2);
		gate.resolve(completeResult);
		await Promise.all([scheduler, cleanup]);
	});

	it("allows a new attempt after the previous refresh settles", async () => {
		const refresh = vi.fn().mockResolvedValue(completeResult);
		const { observer } = makeObserver();
		const instance = publicationSnapshot();

		await runJellyfinCacheRefreshSingleFlight(instance, refresh, observer);
		await Promise.resolve();
		await runJellyfinCacheRefreshSingleFlight(instance, refresh, observer);

		expect(refresh).toHaveBeenCalledTimes(2);
	});

	it("records one dual-generation failure for coalesced incomplete callers", async () => {
		const gate = deferred<CacheRefreshResult>();
		const refresh = vi.fn(() => gate.promise);
		const { observer, upsert } = makeObserver();
		const instance = publicationSnapshot();
		const first = runJellyfinCacheRefreshSingleFlight(instance, refresh, observer);
		const second = runJellyfinCacheRefreshSingleFlight(instance, refresh, observer);

		gate.resolve({
			...completeResult,
			errors: 1,
			errorMessages: ["Jellyfin request timed out"],
			complete: false,
			completedAt: undefined,
		});
		await Promise.all([first, second]);

		expect(upsert).toHaveBeenCalledOnce();
		expect(upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({ connectionGeneration: 7, identityGeneration: 3 }),
			}),
		);
	});

	it("preserves a thrown refresh rejection after recording failure", async () => {
		const failure = new Error("upstream connection reset");
		const refresh = vi.fn().mockRejectedValue(failure);
		const { observer, upsert } = makeObserver();

		await expect(
			runJellyfinCacheRefreshSingleFlight(publicationSnapshot(), refresh, observer),
		).rejects.toBe(failure);
		expect(upsert).toHaveBeenCalledOnce();
	});

	it("does not record a superseded result as a failure", async () => {
		const refresh = vi.fn().mockResolvedValue({
			...completeResult,
			complete: false,
			completedAt: undefined,
			superseded: true,
		});
		const { observer, upsert } = makeObserver();

		await runJellyfinCacheRefreshSingleFlight(publicationSnapshot(), refresh, observer);

		expect(upsert).not.toHaveBeenCalled();
	});

	it.each(["incomplete", "rejected"] as const)(
		"does not let an old-identity %s degrade a newer success",
		async (outcome) => {
			const oldGate = deferred<CacheRefreshResult>();
			const oldRefresh = vi.fn(() => oldGate.promise);
			const newRefresh = vi.fn().mockResolvedValue(completeResult);
			const newer = publicationSnapshot({ identityGeneration: 4 });
			const { observer, upsert } = makeObserver(newer);

			const oldAttempt = runJellyfinCacheRefreshSingleFlight(
				publicationSnapshot(),
				oldRefresh,
				observer,
			);
			await runJellyfinCacheRefreshSingleFlight(newer, newRefresh, observer);
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
				oldGate.reject(new Error("old endpoint reset"));
				await expect(oldAttempt).rejects.toThrow("old endpoint reset");
			}

			expect(upsert).not.toHaveBeenCalled();
		},
	);
});
