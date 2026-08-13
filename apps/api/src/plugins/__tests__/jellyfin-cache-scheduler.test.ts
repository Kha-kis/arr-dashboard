import { beforeEach, describe, expect, it, vi } from "vitest";

const { createJellyfinClient, runSingleFlight } = vi.hoisted(() => ({
	createJellyfinClient: vi.fn(),
	runSingleFlight: vi.fn(),
}));

vi.mock("../../lib/jellyfin/jellyfin-client.js", () => ({ createJellyfinClient }));
vi.mock("../../lib/jellyfin/jellyfin-cache-singleflight.js", () => ({
	runJellyfinCacheRefreshSingleFlight: runSingleFlight,
}));

import { refreshScheduledJellyfinCacheInstance } from "../jellyfin-cache-scheduler.js";

describe("refreshScheduledJellyfinCacheInstance", () => {
	beforeEach(() => vi.clearAllMocks());

	it("records a guarded failure when client construction fails", async () => {
		const statusUpsert = vi.fn().mockResolvedValue({});
		createJellyfinClient.mockImplementation(() => {
			throw new Error("stored credential could not be decrypted");
		});
		const app = {
			encryptor: {},
			prisma: {
				$transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
					callback({
						serviceInstance: {
							findUnique: vi.fn().mockResolvedValue({
								service: "JELLYFIN",
								baseUrl: "https://jellyfin.example.com",
								encryptedApiKey: "encrypted-key",
								encryptionIv: "key-iv",
								encryptedHttpAuthCredentials: null,
								httpAuthEncryptionIv: null,
								enabled: true,
								connectionGeneration: 7,
							}),
						},
						cacheRefreshStatus: { upsert: statusUpsert },
					}),
				),
			},
			log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
		};
		const instance = {
			id: "jellyfin-1",
			label: "Living Room",
			service: "JELLYFIN",
			baseUrl: "https://jellyfin.example.com",
			encryptedApiKey: "encrypted-key",
			encryptionIv: "key-iv",
			encryptedHttpAuthCredentials: null,
			httpAuthEncryptionIv: null,
			connectionGeneration: 7,
		};

		await refreshScheduledJellyfinCacheInstance(app as never, instance as never);

		expect(runSingleFlight).not.toHaveBeenCalled();
		expect(statusUpsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					cacheType: "jellyfin",
					lastAttemptResult: "error",
				}),
			}),
		);
	});
});
