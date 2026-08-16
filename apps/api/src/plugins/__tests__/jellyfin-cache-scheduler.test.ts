import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	expectPreservedSuccessWithSanitizedDecryptFailure,
	watchSchedulerDecryptFailureFixture,
} from "./watch-scheduler-decrypt-failure-fixture.js";

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

	it("records a sanitized failed attempt without replacing the prior success on decrypt failure", async () => {
		const state = watchSchedulerDecryptFailureFixture("JELLYFIN");
		createPublicationSnapshot.mockImplementation(() => {
			throw new Error("stored credential secret-token could not be decrypted");
		});

		await refreshScheduledJellyfinCacheInstance(state.app as never, state.instance as never);

		expect(runSingleFlight).not.toHaveBeenCalled();
		expectPreservedSuccessWithSanitizedDecryptFailure(state);
	});

	it("does not record decrypt failure after a concurrent identity-only replacement", async () => {
		const state = watchSchedulerDecryptFailureFixture("EMBY");
		createPublicationSnapshot.mockImplementation(() => {
			state.current.identityGeneration++;
			throw new Error("stored credential secret-token could not be decrypted");
		});

		await refreshScheduledJellyfinCacheInstance(state.app as never, state.instance as never);

		expect(state.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
		expect(state.status.lastAttemptResult).toBe("success");
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
