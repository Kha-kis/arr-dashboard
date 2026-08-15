import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createSnapshot: vi.fn(),
	refresh: vi.fn(),
	recordFailure: vi.fn(),
}));

vi.mock("../../lib/tautulli/tautulli-cache-refresher.js", () => ({
	createOwnedTautulliPublicationSnapshot: mocks.createSnapshot,
	refreshTautulliCache: mocks.refresh,
}));
vi.mock("../../lib/services/provider-cache-status.js", () => ({
	recordWatchProviderCacheRefreshFailure: mocks.recordFailure,
}));

import { refreshScheduledTautulliCacheInstance } from "../tautulli-cache-scheduler.js";

const app = {
	encryptor: {},
	prisma: {},
	log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
};
const storedInstance = { id: "tautulli-1", label: "Tautulli" };
const publicationInstance = { id: "tautulli-1", identityGeneration: 8 };

describe("refreshScheduledTautulliCacheInstance", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.createSnapshot.mockReturnValue(publicationInstance);
	});

	it("does not record a superseded refresh as a failure", async () => {
		mocks.refresh.mockResolvedValue({
			complete: false,
			upserted: 0,
			errors: 0,
			errorMessages: [],
			superseded: true,
		});

		await refreshScheduledTautulliCacheInstance(app as never, storedInstance as never);

		expect(mocks.refresh).toHaveBeenCalledWith({
			prisma: app.prisma,
			instance: publicationInstance,
			log: app.log,
		});
		expect(mocks.recordFailure).not.toHaveBeenCalled();
	});

	it("records incomplete attempts with the exact publication snapshot", async () => {
		mocks.refresh.mockResolvedValue({
			complete: false,
			upserted: 0,
			errors: 1,
			errorMessages: ["history failed"],
		});

		await refreshScheduledTautulliCacheInstance(app as never, storedInstance as never);

		expect(mocks.recordFailure).toHaveBeenCalledWith(
			app.prisma,
			"tautulli",
			"history failed",
			publicationInstance,
			app.log,
		);
	});
});
