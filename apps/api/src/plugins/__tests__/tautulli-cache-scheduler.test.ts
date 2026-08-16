import Fastify, { type FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

import tautulliCacheSchedulerPlugin, {
	refreshScheduledTautulliCacheInstance,
} from "../tautulli-cache-scheduler.js";

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

	it("reports a superseded refresh as an unsuccessful scheduler instance", async () => {
		mocks.refresh.mockResolvedValue({
			complete: false,
			upserted: 0,
			errors: 0,
			errorMessages: [],
			superseded: true,
		});

		const state = watchSchedulerDecryptFailureFixture("TAUTULLI");
		const succeeded = await refreshScheduledTautulliCacheInstance(
			state.app as never,
			state.instance as never,
		);

		expect(mocks.refresh).toHaveBeenCalledWith({
			prisma: state.app.prisma,
			instance: publicationInstance,
			log: state.app.log,
		});
		expect(state.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
		expect(succeeded).toBe(false);
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

describe("tautulli cache scheduler", () => {
	let app: FastifyInstance;
	const trackedTickFailures: unknown[] = [];
	const schedulerRegistry = {
		track: vi.fn(async (_jobId, callback: () => Promise<unknown>) => {
			try {
				return await callback();
			} catch (error) {
				trackedTickFailures.push(error);
				throw error;
			}
		}),
	};

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		trackedTickFailures.length = 0;
		mocks.createSnapshot.mockImplementation((_encryptor, instance) => instance);
		mocks.refresh
			.mockResolvedValueOnce({
				complete: false,
				upserted: 0,
				errors: 1,
				errorMessages: ["history failed"],
			})
			.mockResolvedValueOnce({
				complete: true,
				completedAt: new Date(),
				upserted: 1,
				errors: 0,
				errorMessages: [],
			});

		app = Fastify({ logger: false });
		await app.register(
			fastifyPlugin(
				async (server) => {
					server.decorate("prisma", {
						serviceInstance: {
							findMany: vi.fn().mockResolvedValue([
								{ ...publicationInstance, id: "tautulli-failed" },
								{ ...publicationInstance, id: "tautulli-succeeded" },
							]),
						},
						cacheRefreshStatus: { findMany: vi.fn().mockResolvedValue([]) },
					} as never);
				},
				{ name: "prisma" },
			),
		);
		await app.register(
			fastifyPlugin(
				async (server) => {
					server.decorate("encryptor", { decrypt: vi.fn() } as never);
				},
				{ name: "security" },
			),
		);
		await app.register(
			fastifyPlugin(
				async (server) => {
					server.decorate("notificationService", {
						notify: vi.fn().mockResolvedValue({}),
					} as never);
				},
				{ name: "notification-service" },
			),
		);
		await app.register(
			fastifyPlugin(
				async (server) => {
					server.decorate("schedulerRegistry", schedulerRegistry as never);
				},
				{ name: "scheduler-registry" },
			),
		);
		await app.register(tautulliCacheSchedulerPlugin);
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
		vi.useRealTimers();
	});

	it("reports an incomplete instance refresh to the scheduler after refreshing every instance", async () => {
		await vi.advanceTimersByTimeAsync(2 * 60_000);

		expect(mocks.refresh).toHaveBeenCalledTimes(2);
		expect(mocks.refresh).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ instance: expect.objectContaining({ id: "tautulli-failed" }) }),
		);
		expect(mocks.refresh).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ instance: expect.objectContaining({ id: "tautulli-succeeded" }) }),
		);
		expect(trackedTickFailures).toEqual([expect.any(Error)]);
	});
});
