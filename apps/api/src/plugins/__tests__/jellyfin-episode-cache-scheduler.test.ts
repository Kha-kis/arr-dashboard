import { beforeEach, describe, expect, it, vi } from "vitest";

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

	it("publishes episodes only through the sealed owned snapshot", async () => {
		const app = {
			encryptor: {},
			prisma: {},
			log: { info: vi.fn(), error: vi.fn() },
		};
		const storedInstance = { id: "emby-1", label: "Emby" };
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
