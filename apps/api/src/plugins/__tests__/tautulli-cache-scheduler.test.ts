import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	expectPreservedSuccessWithSanitizedDecryptFailure,
	watchSchedulerDecryptFailureFixture,
} from "./watch-scheduler-decrypt-failure-fixture.js";

const mocks = vi.hoisted(() => ({
	createSnapshot: vi.fn(),
	refresh: vi.fn(),
}));

vi.mock("../../lib/tautulli/tautulli-cache-refresher.js", () => ({
	createOwnedTautulliPublicationSnapshot: mocks.createSnapshot,
	refreshTautulliCache: mocks.refresh,
}));

import { refreshScheduledTautulliCacheInstance } from "../tautulli-cache-scheduler.js";

const publicationInstance = {
	id: "tautulli-1",
	userId: "user-1",
	service: "TAUTULLI",
	label: "TAUTULLI",
	baseUrl: "https://tautulli.example.com",
	apiKey: "decrypted",
	httpAuthHeaders: {},
	enabled: true,
	encryptedApiKey: "encrypted-secret-token",
	encryptionIv: "token-iv",
	encryptedHttpAuthCredentials: "encrypted-proxy-secret",
	httpAuthEncryptionIv: "proxy-iv",
	expectedIdentity: "tautulli-server-a",
	identityStatus: "VERIFIED",
	connectionGeneration: 4,
	identityGeneration: 9,
};

describe("refreshScheduledTautulliCacheInstance", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.createSnapshot.mockReturnValue(publicationInstance);
	});

	it("records a sanitized failed attempt without replacing the prior success on decrypt failure", async () => {
		const state = watchSchedulerDecryptFailureFixture("TAUTULLI");
		mocks.createSnapshot.mockImplementation(() => {
			throw new Error("secret-token decrypt failed");
		});

		await refreshScheduledTautulliCacheInstance(state.app as never, state.instance as never);

		expect(mocks.refresh).not.toHaveBeenCalled();
		expectPreservedSuccessWithSanitizedDecryptFailure(state);
	});

	it("does not record decrypt failure after a concurrent proxy credential change", async () => {
		const state = watchSchedulerDecryptFailureFixture("TAUTULLI");
		mocks.createSnapshot.mockImplementation(() => {
			state.current.encryptedHttpAuthCredentials = "replacement-proxy-ciphertext";
			throw new Error("proxy-secret decrypt failed");
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
			instance: publicationInstance,
			log: state.app.log,
		});
		expect(state.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});

	it("preserves a centrally sealed unpublished attempt without wrapper finalization", async () => {
		const state = watchSchedulerDecryptFailureFixture("TAUTULLI");
		mocks.refresh.mockImplementation(async () => {
			Object.assign(state.status, {
				lastAttemptResult: "error",
				lastAttemptErrorMessage: "history_partial",
			});
			return {
				kind: "unpublished",
				complete: false,
				upserted: 0,
				errors: 1,
				errorMessages: ["history_partial"],
				reasonCodes: ["history_partial"],
			};
		});

		await refreshScheduledTautulliCacheInstance(state.app as never, state.instance as never);

		expect(state.status.lastAttemptResult).toBe("error");
		expect(state.status.lastAttemptErrorMessage).toBe("history_partial");
		expect(state.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});

	it("preserves a centrally sealed positive publication as partial and logs only a safe summary", async () => {
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
		mocks.refresh.mockImplementation(async () => {
			Object.assign(state.status, {
				lastResult: "partial",
				lastAttemptResult: "partial",
				lastAttemptErrorMessage: "observation_count_unavailable",
			});
			return {
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
			};
		});

		await refreshScheduledTautulliCacheInstance(state.app as never, state.instance as never);

		expect(state.status.lastAttemptResult).toBe("partial");
		expect(state.status.lastAttemptErrorMessage).toBe("observation_count_unavailable");
		expect(state.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
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
