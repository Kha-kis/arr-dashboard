import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { ProviderPublicationAuthority } from "../../services/provider-identity-guard.js";
import {
	clearJellyfinCacheRefreshSingleFlightsForTests,
	runJellyfinCacheRefreshSingleFlight,
	runJellyfinCacheRefreshSingleFlightWithAttempt,
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

type RefreshResult = { complete: boolean; upserted: number };

const completeResult: RefreshResult = { complete: true, upserted: 1 };

function authority(
	overrides: Partial<ProviderPublicationAuthority> = {},
): ProviderPublicationAuthority {
	return {
		id: "instance-1",
		userId: "user-1",
		service: "JELLYFIN",
		baseUrl: "https://jellyfin.example.com",
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

afterEach(() => clearJellyfinCacheRefreshSingleFlightsForTests());

describe("runJellyfinCacheRefreshSingleFlight", () => {
	it("coalesces concurrent calls with the exact authority and cache type", async () => {
		const gate = deferred<RefreshResult>();
		const refresh = vi.fn(() => gate.promise);
		const first = runJellyfinCacheRefreshSingleFlight(authority(), "jellyfin", refresh);
		const second = runJellyfinCacheRefreshSingleFlight(authority(), "jellyfin", refresh);

		expect(first).toBe(second);
		expect(refresh).not.toHaveBeenCalled();
		await Promise.resolve();
		expect(refresh).toHaveBeenCalledOnce();
		gate.resolve(completeResult);
		expect(await first).toBe(completeResult);
	});

	it.each([
		["id", { id: "instance-2" }],
		["userId", { userId: "user-2" }],
		["service", { service: "EMBY" as const }],
		["enabled", { enabled: false }],
		["expectedIdentity", { expectedIdentity: "server-b" }],
		["identityStatus", { identityStatus: "MISMATCH" as const }],
		["connectionGeneration", { connectionGeneration: 8 }],
		["identityGeneration", { identityGeneration: 4 }],
		["baseUrl", { baseUrl: "https://other.example.com" }],
		["encryptedApiKey", { encryptedApiKey: "encrypted-other" }],
		["encryptionIv", { encryptionIv: "other-iv" }],
		["encryptedHttpAuthCredentials", { encryptedHttpAuthCredentials: "http-other" }],
		["httpAuthEncryptionIv", { httpAuthEncryptionIv: "http-other-iv" }],
	] as const)("partitions on authority field %s", async (_field, change) => {
		const gate = deferred<RefreshResult>();
		const refresh = vi.fn(() => gate.promise);
		const first = runJellyfinCacheRefreshSingleFlight(authority(), "jellyfin", refresh);
		const second = runJellyfinCacheRefreshSingleFlight(authority(change), "jellyfin", refresh);

		expect(first).not.toBe(second);
		await Promise.resolve();
		expect(refresh).toHaveBeenCalledTimes(2);
		gate.resolve(completeResult);
		await Promise.all([first, second]);
	});

	it("partitions on cache type and cleanup authority", async () => {
		const gate = deferred<RefreshResult>();
		const refresh = vi.fn(() => gate.promise);
		const instance = authority();
		const library = runJellyfinCacheRefreshSingleFlight(instance, "jellyfin", refresh);
		const episode = runJellyfinCacheRefreshSingleFlight(instance, "jellyfin_episode", refresh);
		const cleanup = runJellyfinCacheRefreshSingleFlight(instance, "jellyfin", refresh, "cleanup-1");

		expect(new Set([library, episode, cleanup]).size).toBe(3);
		await Promise.resolve();
		expect(refresh).toHaveBeenCalledTimes(3);
		gate.resolve(completeResult);
		await Promise.all([library, episode, cleanup]);
	});

	it("clears settled flights and preserves exact callback resolution and rejection", async () => {
		const refresh = vi.fn().mockResolvedValue(completeResult);
		const first = await runJellyfinCacheRefreshSingleFlight(authority(), "jellyfin", refresh);
		const second = await runJellyfinCacheRefreshSingleFlight(authority(), "jellyfin", refresh);

		expect(first).toBe(completeResult);
		expect(second).toBe(completeResult);
		expect(refresh).toHaveBeenCalledTimes(2);

		const failure = new Error("exact rejection");
		const rejected = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(completeResult);
		await expect(
			runJellyfinCacheRefreshSingleFlight(authority(), "jellyfin", rejected),
		).rejects.toBe(failure);
		await expect(
			runJellyfinCacheRefreshSingleFlight(authority(), "jellyfin", rejected),
		).resolves.toBe(completeResult);
	});

	it("accepts no plaintext-capable input and performs no status or observer writes", async () => {
		const refresh = vi.fn().mockResolvedValue({ complete: false, upserted: 0 });
		const input = authority();
		expect(input).not.toHaveProperty("apiKey");
		expect(input).not.toHaveProperty("httpAuthHeaders");
		await expect(
			runJellyfinCacheRefreshSingleFlight(input, "jellyfin_episode", refresh),
		).resolves.toEqual({ complete: false, upserted: 0 });
		expect(refresh).toHaveBeenCalledOnce();
	});

	it("partitions preclaimed flights by the exact opaque attempt marker", async () => {
		const gate = deferred<RefreshResult>();
		const refresh = vi.fn(() => gate.promise);
		const firstAttempt = {
			attemptedAt: new Date("2026-08-20T12:00:00.000Z"),
			resultMarker: "in_progress:11111111-1111-4111-8111-111111111111",
		};
		const secondAttempt = {
			...firstAttempt,
			resultMarker: "in_progress:22222222-2222-4222-8222-222222222222",
		};

		const first = runJellyfinCacheRefreshSingleFlightWithAttempt(
			authority(),
			"jellyfin",
			firstAttempt,
			refresh,
		);
		const second = runJellyfinCacheRefreshSingleFlightWithAttempt(
			authority(),
			"jellyfin",
			secondAttempt,
			refresh,
		);

		expect(first).not.toBe(second);
		await Promise.resolve();
		expect(refresh).toHaveBeenCalledTimes(2);
		gate.resolve(completeResult);
		await Promise.all([first, second]);
	});

	it("exposes exactly the plaintext-free authority type as its first parameter", () => {
		expectTypeOf<
			Parameters<typeof runJellyfinCacheRefreshSingleFlight>[0]
		>().toEqualTypeOf<ProviderPublicationAuthority>();
		// @ts-expect-error Plaintext credentials are intentionally excluded from authority.
		const invalidAuthority: ProviderPublicationAuthority = { ...authority(), apiKey: "secret" };
		void invalidAuthority;
	});
});
