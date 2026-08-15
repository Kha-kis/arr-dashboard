import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	expectPreservedSuccessWithSanitizedDecryptFailure,
	watchSchedulerDecryptFailureFixture,
} from "./watch-scheduler-decrypt-failure-fixture.js";

const mocks = vi.hoisted(() => ({ createSnapshot: vi.fn(), refresh: vi.fn() }));

vi.mock("../../lib/jellyfin/jellyfin-cache-refresher.js", () => ({
	createOwnedJellyfinPublicationSnapshot: mocks.createSnapshot,
}));
vi.mock("../../lib/jellyfin/jellyfin-episode-cache-refresher.js", () => ({
	refreshJellyfinEpisodeCache: mocks.refresh,
}));

import { refreshScheduledJellyfinEpisodeCacheInstance } from "../jellyfin-episode-cache-scheduler.js";

describe("refreshScheduledJellyfinEpisodeCacheInstance", () => {
	beforeEach(() => vi.clearAllMocks());

	it("records a sanitized failed episode attempt without replacing the prior success", async () => {
		const state = watchSchedulerDecryptFailureFixture("EMBY");
		state.status.cacheType = "jellyfin_episode";
		mocks.createSnapshot.mockImplementation(() => {
			throw new Error("proxy-secret decrypt failed");
		});

		await refreshScheduledJellyfinEpisodeCacheInstance(state.app as never, state.instance as never);

		expect(mocks.refresh).not.toHaveBeenCalled();
		expectPreservedSuccessWithSanitizedDecryptFailure(state);
	});

	it("does not record episode decrypt failure after a concurrent configuration change", async () => {
		const state = watchSchedulerDecryptFailureFixture("JELLYFIN");
		state.status.cacheType = "jellyfin_episode";
		mocks.createSnapshot.mockImplementation(() => {
			state.current.baseUrl = "https://replacement.example.com";
			throw new Error("secret-token decrypt failed");
		});

		await refreshScheduledJellyfinEpisodeCacheInstance(state.app as never, state.instance as never);

		expect(state.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
		expect(state.status.lastAttemptResult).toBe("success");
	});

	it("publishes episodes only through the sealed owned snapshot", async () => {
		const app = {
			encryptor: {},
			prisma: {},
			log: { info: vi.fn(), error: vi.fn() },
		};
		const storedInstance = {
			id: "emby-1",
			userId: "user-1",
			service: "EMBY",
			label: "Emby",
			baseUrl: "https://emby.example.com",
			enabled: true,
			encryptedApiKey: "encrypted-key",
			encryptionIv: "key-iv",
			encryptedHttpAuthCredentials: null,
			httpAuthEncryptionIv: null,
			expectedIdentity: "emby-a",
			identityStatus: "VERIFIED",
			connectionGeneration: 2,
			identityGeneration: 3,
		};
		const publicationInstance = { id: "emby-1", identityGeneration: 3 };
		mocks.createSnapshot.mockReturnValue(publicationInstance);
		mocks.refresh.mockResolvedValue({ complete: false, superseded: true, upserted: 0, errors: 0 });

		await refreshScheduledJellyfinEpisodeCacheInstance(app as never, storedInstance as never);

		expect(mocks.createSnapshot).toHaveBeenCalledWith(app.encryptor, storedInstance);
		expect(mocks.refresh).toHaveBeenCalledWith({
			prisma: app.prisma,
			instance: publicationInstance,
			log: app.log,
		});
		expect(app.log.error).not.toHaveBeenCalled();
	});
});
