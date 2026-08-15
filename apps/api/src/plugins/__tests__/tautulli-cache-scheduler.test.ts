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

	it("records incomplete attempts with the exact publication snapshot", async () => {
		mocks.refresh.mockResolvedValue({
			complete: false,
			upserted: 0,
			errors: 1,
			errorMessages: ["history failed"],
		});

		const state = watchSchedulerDecryptFailureFixture("TAUTULLI");
		await refreshScheduledTautulliCacheInstance(state.app as never, state.instance as never);

		expect(state.status.lastAttemptResult).toBe("error");
		expect(state.status.lastAttemptErrorMessage).toBe("history failed");
	});
});
