import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clearJellyfinCacheRefreshSingleFlightsForTests,
	runJellyfinCacheRefreshSingleFlight,
} from "../jellyfin-cache-singleflight.js";
import { jellyfinConnectionFingerprint } from "../service-instance-fingerprint.js";

const completeResult = {
	upserted: 1,
	errors: 0,
	errorMessages: [],
	complete: true,
	completedAt: new Date("2026-08-12T12:00:00.000Z"),
};

const currentConnection = {
	service: "JELLYFIN" as const,
	baseUrl: "https://jellyfin.example.test",
	encryptedApiKey: "encrypted-key",
	encryptionIv: "iv",
	encryptedHttpAuthCredentials: null,
	httpAuthEncryptionIv: null,
	enabled: true,
	connectionGeneration: 7,
};
const currentFingerprint = jellyfinConnectionFingerprint(currentConnection as never);

function makeObserver() {
	const upsert = vi.fn().mockResolvedValue({});
	const tx = {
		serviceInstance: {
			findUnique: vi.fn().mockResolvedValue(currentConnection),
		},
		cacheRefreshStatus: { upsert },
	};
	return {
		upsert,
		observer: {
			prisma: {
				$transaction: vi.fn(
					async (callback: (transaction: typeof tx) => Promise<unknown>) => await callback(tx),
				),
			} as never,
			log: { warn: vi.fn() },
		},
	};
}

afterEach(() => clearJellyfinCacheRefreshSingleFlightsForTests());

describe("runJellyfinCacheRefreshSingleFlight", () => {
	it("shares an in-flight refresh for one instance generation and allows retry after failure", async () => {
		const { observer, upsert } = makeObserver();
		let reject!: (reason: unknown) => void;
		const pending = new Promise<never>((_resolve, fail) => {
			reject = fail;
		});
		const firstRefresh = vi.fn(() => pending);
		const first = runJellyfinCacheRefreshSingleFlight(
			"jellyfin-1",
			currentFingerprint,
			firstRefresh,
			observer,
		);
		const second = runJellyfinCacheRefreshSingleFlight(
			"jellyfin-1",
			currentFingerprint,
			firstRefresh,
			observer,
		);

		expect(first).toBe(second);
		await Promise.resolve();
		expect(firstRefresh).toHaveBeenCalledOnce();
		reject(new Error("upstream timeout"));
		await expect(first).rejects.toThrow("upstream timeout");
		expect(upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				update: expect.objectContaining({
					lastAttemptResult: "error",
					lastAttemptErrorMessage: "upstream timeout",
				}),
			}),
		);

		const retry = vi.fn().mockResolvedValue(completeResult);
		await expect(
			runJellyfinCacheRefreshSingleFlight("jellyfin-1", currentFingerprint, retry, observer),
		).resolves.toEqual(completeResult);
		expect(retry).toHaveBeenCalledOnce();
	});

	it("records an incomplete result without moving the last successful generation", async () => {
		const { observer, upsert } = makeObserver();
		const incomplete = {
			upserted: 1,
			errors: 1,
			errorMessages: ["Jellyfin request timed out"],
			complete: false,
			completedAt: undefined,
		};

		await expect(
			runJellyfinCacheRefreshSingleFlight(
				"jellyfin-1",
				currentFingerprint,
				vi.fn().mockResolvedValue(incomplete),
				observer,
			),
		).resolves.toEqual(incomplete);

		expect(upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				update: expect.not.objectContaining({ lastRefreshedAt: expect.anything() }),
			}),
		);
	});
});
