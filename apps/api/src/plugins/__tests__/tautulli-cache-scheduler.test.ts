import { beforeEach, describe, expect, it, vi } from "vitest";
import { watchSchedulerDecryptFailureFixture } from "./watch-scheduler-decrypt-failure-fixture.js";

const mocks = vi.hoisted(() => ({
	refreshOwned: vi.fn(),
}));

vi.mock("../../lib/tautulli/tautulli-cache-refresher.js", () => ({
	refreshOwnedTautulliCache: mocks.refreshOwned,
	summarizeTautulliRefreshResultForLog: (result: {
		kind?: string;
		upserted: number;
		errors: number;
		superseded?: boolean;
	}) => ({
		terminalKind: result.kind,
		upserted: result.upserted,
		errors: result.errors,
		superseded: result.superseded === true,
	}),
}));

import { refreshScheduledTautulliCacheInstance } from "../tautulli-cache-scheduler.js";

describe("refreshScheduledTautulliCacheInstance", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.refreshOwned.mockResolvedValue({
			kind: "published-authoritative",
			complete: true,
			completedAt: new Date(),
			publicationLevel: "authoritative",
			upserted: 5,
			errors: 0,
			errorMessages: [],
			reasonCodes: [],
		});
	});

	it("delegates the persisted instance and encryptor to the ownership-first refresher", async () => {
		const state = watchSchedulerDecryptFailureFixture("TAUTULLI");

		await refreshScheduledTautulliCacheInstance(state.app as never, state.instance as never);

		expect(mocks.refreshOwned).toHaveBeenCalledWith({
			prisma: state.app.prisma,
			encryptor: state.app.encryptor,
			instance: state.instance,
			log: state.app.log,
		});
		expect(state.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});

	it("does not wrapper-finalize a centrally sealed credential failure", async () => {
		const state = watchSchedulerDecryptFailureFixture("TAUTULLI");
		mocks.refreshOwned.mockResolvedValue({
			kind: "unpublished",
			complete: false,
			upserted: 0,
			errors: 1,
			errorMessages: ["credential_unavailable"],
			reasonCodes: ["credential_unavailable"],
		});

		await refreshScheduledTautulliCacheInstance(state.app as never, state.instance as never);

		expect(state.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
		expect(state.app.log.info).toHaveBeenCalledWith(
			expect.objectContaining({
				instanceId: state.instance.id,
				terminalKind: "unpublished",
			}),
			"Tautulli cache refresh completed for instance",
		);
	});

	it("does not record a superseded refresh as a failure", async () => {
		const state = watchSchedulerDecryptFailureFixture("TAUTULLI");
		mocks.refreshOwned.mockResolvedValue({
			kind: "superseded",
			complete: false,
			upserted: 0,
			errors: 0,
			errorMessages: [],
			reasonCodes: [],
			superseded: true,
		});

		await refreshScheduledTautulliCacheInstance(state.app as never, state.instance as never);

		expect(state.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
		expect(state.app.log.error).not.toHaveBeenCalled();
	});

	it("logs only the bounded summary of a positive publication", async () => {
		const state = watchSchedulerDecryptFailureFixture("TAUTULLI");
		const canaries = {
			title: "CANARY_TITLE",
			username: "CANARY_USERNAME",
			sectionId: "CANARY_SECTION",
			ratingKey: "CANARY_RATING_KEY",
			tmdbId: 987654,
			guid: "plex://movie/CANARY_GUID",
			url: "https://CANARY_URL.invalid",
			token: "CANARY_TOKEN",
		};
		mocks.refreshOwned.mockResolvedValue({
			kind: "published-positive",
			complete: false,
			publicationLevel: "positive-only",
			completedAt: new Date(),
			upserted: 1,
			errors: 1,
			errorMessages: ["observation_count_unavailable"],
			reasonCodes: ["observation_count_unavailable"],
			partialReasons: [{ code: "observation_count_unavailable", count: 1 }],
			snapshot: { rows: [canaries], exactObservations: [canaries] },
		});

		await refreshScheduledTautulliCacheInstance(state.app as never, state.instance as never);

		const serializedLogs = JSON.stringify([
			...state.app.log.info.mock.calls,
			...state.app.log.warn.mock.calls,
			...state.app.log.error.mock.calls,
		]);
		for (const value of Object.values(canaries)) {
			expect(serializedLogs).not.toContain(String(value));
		}
	});
});
