import { describe, expect, it, vi } from "vitest";
import { recordCacheRefreshFailure } from "../cache-refresh-status.js";
import { recordProviderCacheRefreshFailure } from "./provider-cache-status.js";
import { providerConnectionIdentity } from "./provider-connection-guard.js";

const plexConnection = {
	service: "PLEX" as const,
	baseUrl: "https://plex.example.test",
	encryptedApiKey: "key",
	encryptionIv: "iv",
	encryptedHttpAuthCredentials: null,
	httpAuthEncryptionIv: null,
	enabled: true,
	connectionGeneration: 7,
};

describe("recordCacheRefreshFailure", () => {
	it("records a failed attempt without replacing the last published generation", async () => {
		const upsert = vi.fn().mockResolvedValue({});
		const attemptedAt = new Date("2026-08-12T12:00:00.000Z");

		await recordCacheRefreshFailure(
			{ cacheRefreshStatus: { upsert } } as never,
			"plex-1",
			"plex",
			"Connection refused by the configured host (ECONNREFUSED)",
			attemptedAt,
		);

		expect(upsert).toHaveBeenCalledWith({
			where: { instanceId_cacheType: { instanceId: "plex-1", cacheType: "plex" } },
			create: expect.objectContaining({
				lastResult: "error",
				lastAttemptAt: attemptedAt,
				lastAttemptResult: "error",
			}),
			update: {
				lastAttemptAt: attemptedAt,
				lastAttemptResult: "error",
				lastAttemptErrorMessage: "Connection refused by the configured host (ECONNREFUSED)",
			},
		});
	});
});

describe("recordProviderCacheRefreshFailure", () => {
	it("does not restore a failure status after the provider generation is superseded", async () => {
		const upsert = vi.fn();
		const transaction = vi.fn(
			async (
				callback: (tx: {
					serviceInstance: { findUnique: () => Promise<unknown> };
					cacheRefreshStatus: { upsert: typeof upsert };
				}) => Promise<unknown>,
			) =>
				await callback({
					serviceInstance: {
						findUnique: async () => ({
							...plexConnection,
							connectionGeneration: 8,
						}),
					},
					cacheRefreshStatus: { upsert },
				}),
		);

		const result = await recordProviderCacheRefreshFailure(
			{ $transaction: transaction } as never,
			"plex-1",
			"plex",
			"old connection failed",
			providerConnectionIdentity(plexConnection),
			{ warn: vi.fn() },
		);

		expect(result).toBe("superseded");
		expect(upsert).not.toHaveBeenCalled();
	});
});
