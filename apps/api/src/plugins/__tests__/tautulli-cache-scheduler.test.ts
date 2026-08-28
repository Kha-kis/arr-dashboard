import { beforeEach, describe, expect, it, vi } from "vitest";
import { watchSchedulerDecryptFailureFixture } from "./watch-scheduler-decrypt-failure-fixture.js";

const mocks = vi.hoisted(() => ({
	refresh: vi.fn(),
}));

vi.mock("../../lib/tautulli/tautulli-cache-refresher.js", () => ({
	refreshOwnedTautulliCache: mocks.refresh,
}));

import { refreshScheduledTautulliCacheInstance } from "../tautulli-cache-scheduler.js";

describe("refreshScheduledTautulliCacheInstance", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.refresh.mockResolvedValue({
			complete: true,
			completedAt: new Date(),
			upserted: 1,
			errors: 0,
			errorMessages: [],
		});
	});

	it("delegates credential handling to the attempt-owning refresher", async () => {
		const state = watchSchedulerDecryptFailureFixture("TAUTULLI");

		await refreshScheduledTautulliCacheInstance(state.app as never, state.instance as never);

		expect(mocks.refresh).toHaveBeenCalledWith({
			prisma: state.app.prisma,
			encryptor: state.app.encryptor,
			instance: state.instance,
			log: state.app.log,
		});
	});

	it("does not perform a second status write for a bounded credential failure", async () => {
		const state = watchSchedulerDecryptFailureFixture("TAUTULLI");
		mocks.refresh.mockResolvedValue({
			complete: false,
			upserted: 0,
			errors: 1,
			errorMessages: ["credential_unavailable"],
		});

		await refreshScheduledTautulliCacheInstance(state.app as never, state.instance as never);

		expect(state.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
		expect(state.status.lastAttemptResult).toBe("success");
	});

	it("does not record a superseded refresh as a failure", async () => {
		mocks.refresh.mockResolvedValue({
			complete: false,
			upserted: 0,
			errors: 0,
			errorMessages: [],
			superseded: true,
		});

		const state = watchSchedulerDecryptFailureFixture("TAUTULLI");
		await refreshScheduledTautulliCacheInstance(state.app as never, state.instance as never);

		expect(mocks.refresh).toHaveBeenCalledWith({
			prisma: state.app.prisma,
			encryptor: state.app.encryptor,
			instance: state.instance,
			log: state.app.log,
		});
		expect(state.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});

	it("does not persist or log raw provider failure text outside the refresher", async () => {
		mocks.refresh.mockResolvedValue({
			complete: false,
			upserted: 0,
			errors: 1,
			errorMessages: ["provider_response_invalid"],
		});

		const state = watchSchedulerDecryptFailureFixture("TAUTULLI");
		await refreshScheduledTautulliCacheInstance(state.app as never, state.instance as never);

		expect(state.status.lastAttemptResult).toBe("success");
		expect(JSON.stringify(state.app.log.info.mock.calls)).not.toContain(
			"provider_response_invalid",
		);
	});
});
