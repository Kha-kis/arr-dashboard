import { beforeEach, describe, expect, it, vi } from "vitest";

const { createJellyfinClient, recordFailure, runSingleFlight } = vi.hoisted(() => ({
	createJellyfinClient: vi.fn(),
	recordFailure: vi.fn().mockResolvedValue(undefined),
	runSingleFlight: vi.fn(),
}));

vi.mock("../../lib/jellyfin/jellyfin-client.js", () => ({ createJellyfinClient }));
vi.mock("../../lib/jellyfin/jellyfin-cache-singleflight.js", () => ({
	recordJellyfinCacheRefreshFailure: recordFailure,
	runJellyfinCacheRefreshSingleFlight: runSingleFlight,
}));

import { refreshScheduledJellyfinCacheInstance } from "../jellyfin-cache-scheduler.js";

describe("refreshScheduledJellyfinCacheInstance", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("records a guarded failure when client construction fails", async () => {
		const failure = new Error("stored credential could not be decrypted");
		createJellyfinClient.mockImplementation(() => {
			throw failure;
		});
		const app = {
			encryptor: {},
			prisma: {},
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
		expect(recordFailure).toHaveBeenCalledWith(
			"jellyfin-1",
			expect.any(String),
			"stored credential could not be decrypted",
			{ prisma: app.prisma, log: app.log },
		);
	});

	it("does not duplicate failures already observed by the single-flight wrapper", async () => {
		createJellyfinClient.mockReturnValue({});
		runSingleFlight.mockRejectedValue(new Error("refresh failed"));
		const app = {
			encryptor: {},
			prisma: {},
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

		expect(runSingleFlight).toHaveBeenCalledOnce();
		expect(recordFailure).not.toHaveBeenCalled();
		expect(app.log.error).toHaveBeenCalledOnce();
	});
});
