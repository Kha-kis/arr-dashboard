import { beforeEach, describe, expect, it, vi } from "vitest";

const { createPublicationSnapshot, runSingleFlight } = vi.hoisted(() => ({
	createPublicationSnapshot: vi.fn(),
	runSingleFlight: vi.fn(),
}));

vi.mock("../../lib/jellyfin/jellyfin-cache-refresher.js", () => ({
	createOwnedJellyfinPublicationSnapshot: createPublicationSnapshot,
	refreshJellyfinCache: vi.fn(),
}));
vi.mock("../../lib/jellyfin/jellyfin-cache-singleflight.js", () => ({
	runJellyfinCacheRefreshSingleFlight: runSingleFlight,
}));

import { refreshScheduledJellyfinCacheInstance } from "../jellyfin-cache-scheduler.js";

describe("refreshScheduledJellyfinCacheInstance", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("preserves status when the owned snapshot cannot be decrypted", async () => {
		const failure = new Error("stored credential could not be decrypted");
		createPublicationSnapshot.mockImplementation(() => {
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
		expect(app.log.error).toHaveBeenCalledOnce();
	});

	it("does not duplicate failures already observed by the single-flight wrapper", async () => {
		createPublicationSnapshot.mockReturnValue({ id: "jellyfin-1" });
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
		expect(app.log.error).toHaveBeenCalledOnce();
	});
});
