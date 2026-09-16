import Fastify, { type FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	refresh: vi.fn(),
	runSingleFlight: vi.fn(),
}));

vi.mock("../../lib/jellyfin/jellyfin-cache-refresher.js", () => ({
	refreshOwnedJellyfinCache: mocks.refresh,
}));
vi.mock("../../lib/jellyfin/jellyfin-cache-singleflight.js", () => ({
	runJellyfinCacheRefreshSingleFlight: mocks.runSingleFlight,
}));

import type { FastifyWithLibraryRefreshRecovery } from "../../lib/services/library-refresh-recovery.js";
import jellyfinCacheSchedulerPlugin, {
	refreshScheduledJellyfinCacheInstance,
} from "../jellyfin-cache-scheduler.js";

function instance(service: "JELLYFIN" | "EMBY" = "JELLYFIN") {
	return {
		id: "instance-1",
		userId: "user-1",
		service,
		label: "Private label",
		baseUrl: "https://provider.example.com",
		externalUrl: null,
		encryptedApiKey: "encrypted-api-key",
		encryptionIv: "api-iv",
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
		isDefault: false,
		enabled: true,
		storageGroupId: null,
		hasLocalFilesystemAccess: false,
		pathPrefix: null,
		connectionGeneration: 7,
		expectedIdentity: "provider-1",
		identityKind: null,
		identityStatus: "VERIFIED",
		identityGeneration: 3,
		identityVerifiedAt: null,
		identityLastCheckedAt: null,
		createdAt: new Date(),
		updatedAt: new Date(),
	};
}

function app() {
	return {
		encryptor: { decrypt: vi.fn() },
		prisma: {},
		log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
	};
}

describe("refreshScheduledJellyfinCacheInstance", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.runSingleFlight.mockImplementation(
			async (_authority: unknown, _cacheType: unknown, refresh: () => Promise<unknown>) =>
				await refresh(),
		);
		mocks.refresh.mockResolvedValue({ complete: true, upserted: 2, errors: 0 });
	});

	it.each(["JELLYFIN", "EMBY"] as const)(
		"forwards the raw %s instance and encryptor through an authority-only flight",
		async (service) => {
			const state = app();
			const stored = instance(service);
			await refreshScheduledJellyfinCacheInstance(state as never, stored as never);

			expect(mocks.runSingleFlight).toHaveBeenCalledWith(
				expect.objectContaining({
					id: stored.id,
					userId: stored.userId,
					encryptedApiKey: stored.encryptedApiKey,
				}),
				"jellyfin",
				expect.any(Function),
			);
			expect(mocks.refresh).toHaveBeenCalledWith({
				prisma: state.prisma,
				encryptor: state.encryptor,
				instance: stored,
				log: state.log,
			});
			expect(state.encryptor.decrypt as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
			expect(state.log.error).not.toHaveBeenCalled();
		},
	);

	it("logs only bounded generic data when an owned refresh rejects", async () => {
		const state = app();
		const stored = instance();
		const secret = "secret-error-marker";
		mocks.runSingleFlight.mockRejectedValue(new Error(secret));

		await refreshScheduledJellyfinCacheInstance(state as never, stored as never);

		const errorCalls = state.log.error.mock.calls;
		expect(errorCalls).toHaveLength(1);
		expect(errorCalls[0]).toEqual([
			{ instanceId: stored.id, category: "refresh-failed" },
			"Jellyfin cache refresh failed for instance",
		]);
		expect(errorCalls.flat()).not.toContain(secret);
		expect(errorCalls.flat()).not.toContain(stored.label);
		expect(errorCalls.flat()).not.toContain(stored.baseUrl);
		expect(state.log.error).toHaveBeenCalledWith(
			{ instanceId: stored.id, category: "refresh-failed" },
			"Jellyfin cache refresh failed for instance",
		);
	});

	it("retries a failed native inventory despite a successful canonical cache", async () => {
		mocks.refresh.mockResolvedValue({
			complete: true,
			upserted: 2,
			errors: 0,
			nativeInventoryStatus: "failed",
		});
		expect(await refreshScheduledJellyfinCacheInstance(app() as never, instance() as never)).toBe(
			"retryable",
		);
	});

	it("classifies an error-free positive-only publication as settled", async () => {
		const state = app();
		mocks.refresh.mockResolvedValue({
			complete: false,
			upserted: 7,
			errors: 0,
		});

		await expect(
			refreshScheduledJellyfinCacheInstance(state as never, instance() as never),
		).resolves.toBe("settled");
	});
});

describe("Jellyfin cache scheduler lifecycle", () => {
	let app: FastifyInstance;
	let findMany: ReturnType<typeof vi.fn>;
	let findFirst: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		mocks.runSingleFlight
			.mockReset()
			.mockImplementation(
				async (_authority: unknown, _cacheType: unknown, refresh: () => Promise<unknown>) =>
					await refresh(),
			);
		mocks.refresh.mockReset().mockResolvedValue({
			complete: true,
			upserted: 2,
			errors: 0,
			errorMessages: [],
		});
		findMany = vi.fn().mockResolvedValue([]);
		findFirst = vi.fn().mockResolvedValue(null);
		app = Fastify({ logger: false });

		void app.register(
			fastifyPlugin(
				async (server) => {
					server.decorate("prisma", {
						serviceInstance: { findMany, findFirst },
					} as never);
				},
				{ name: "prisma" },
			),
		);
		void app.register(
			fastifyPlugin(
				async (server) => {
					server.decorate("encryptor", {} as never);
				},
				{ name: "security" },
			),
		);
		void app.register(
			fastifyPlugin(
				async (server) => {
					server.decorate("schedulerRegistry", {
						track: vi.fn(
							async (_jobId: string, callback: () => Promise<unknown>) => await callback(),
						),
					} as never);
				},
				{ name: "scheduler-registry" },
			),
		);
	});

	afterEach(async () => {
		if (!app.initialConfig) return;
		await app.close();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("does not arm a timer before the earlier recovery onReady hook completes", async () => {
		const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const intervalSpy = vi.spyOn(globalThis, "setInterval");
		let schedulerTimersWhenRecoveryReady = -1;
		await app.register(
			fastifyPlugin(
				async (server) => {
					server.addHook("onReady", async () => {
						schedulerTimersWhenRecoveryReady =
							timeoutSpy.mock.calls.filter(([, delay]) => delay === 45_000).length +
							intervalSpy.mock.calls.filter(([, delay]) => delay === 6 * 60 * 60 * 1000).length;
					});
				},
				{ name: "provider-cache-attempt-recovery" },
			),
		);
		await app.register(jellyfinCacheSchedulerPlugin);

		await app.ready();

		expect(schedulerTimersWhenRecoveryReady).toBe(0);
		expect(timeoutSpy.mock.calls.filter(([, delay]) => delay === 45_000)).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(45_000);
		expect(intervalSpy.mock.calls.filter(([, delay]) => delay === 6 * 60 * 60 * 1000)).toHaveLength(
			1,
		);
	});

	it("retries an incomplete parent refresh three times with bounded backoff", async () => {
		const stored = instance();
		findMany.mockResolvedValue([stored]);
		findFirst.mockResolvedValue(stored);
		mocks.refresh.mockResolvedValue({
			complete: false,
			upserted: 0,
			errors: 1,
			errorMessages: ["private provider failure"],
		});

		await app.register(jellyfinCacheSchedulerPlugin);
		await app.ready();
		await vi.advanceTimersByTimeAsync(45_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(4);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(4);
		expect(findFirst).toHaveBeenCalledTimes(3);
	});

	it("arms the existing 30-second recovery queue for a manual native-only failure", async () => {
		const stored = instance();
		findMany.mockResolvedValue([stored]);
		findFirst.mockResolvedValue(stored);
		await app.register(jellyfinCacheSchedulerPlugin);
		await app.ready();
		await vi.advanceTimersByTimeAsync(45_000);
		mocks.refresh.mockClear();

		const recovery = (app as FastifyWithLibraryRefreshRecovery).libraryRefreshRecovery;
		const request = {
			provider: "jellyfin" as const,
			userId: stored.userId,
			instanceId: stored.id,
			attempt: {
				attemptedAt: new Date("2026-09-14T12:00:00.000Z"),
				resultMarker: "in_progress:00000000-0000-4000-8000-000000000001",
			},
		};
		recovery.admit(request);
		expect(await recovery.arm(request)).toEqual({ status: "accepted" });
		await vi.advanceTimersByTimeAsync(29_999);
		expect(mocks.refresh).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(mocks.refresh).toHaveBeenCalledOnce();
	});

	it("does not refresh after shutdown while a recovery lookup is pending", async () => {
		const stored = instance();
		findMany.mockResolvedValue([stored]);
		mocks.refresh.mockResolvedValueOnce({ complete: false, errors: 1, upserted: 0 });
		let resolveLookup!: (value: typeof stored) => void;
		findFirst.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveLookup = resolve;
				}),
		);
		await app.register(jellyfinCacheSchedulerPlugin);
		await app.ready();
		await vi.advanceTimersByTimeAsync(45_000 + 30_000);
		expect(findFirst).toHaveBeenCalledOnce();
		expect(mocks.refresh).toHaveBeenCalledOnce();

		await app.close();
		resolveLookup(stored);
		await vi.advanceTimersByTimeAsync(0);
		expect(mocks.refresh).toHaveBeenCalledOnce();
	});

	it("reloads current connection authority and stops the ladder after recovery succeeds", async () => {
		const initial = instance();
		const current = { ...initial, baseUrl: "https://current-provider.example.com" };
		findMany.mockResolvedValue([initial]);
		findFirst.mockResolvedValue(current);
		mocks.refresh
			.mockResolvedValueOnce({
				complete: false,
				upserted: 0,
				errors: 1,
				errorMessages: ["temporary failure"],
			})
			.mockResolvedValueOnce({
				complete: true,
				upserted: 2,
				errors: 0,
				errorMessages: [],
			});

		await app.register(jellyfinCacheSchedulerPlugin);
		await app.ready();
		await vi.advanceTimersByTimeAsync(45_000 + 30_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(2);
		expect(mocks.refresh.mock.calls[1]?.[0]).toMatchObject({ instance: current });
		await vi.advanceTimersByTimeAsync(20 * 60_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(2);
		expect(findFirst).toHaveBeenCalledOnce();
	});

	it("stops the recovery ladder after an error-free positive-only publication", async () => {
		const stored = instance();
		findMany.mockResolvedValue([stored]);
		mocks.refresh.mockResolvedValue({
			complete: false,
			upserted: 7,
			errors: 0,
		});

		await app.register(jellyfinCacheSchedulerPlugin);
		await app.ready();
		await vi.advanceTimersByTimeAsync(45_000 + 20 * 60_000);

		expect(mocks.refresh).toHaveBeenCalledOnce();
		expect(findFirst).not.toHaveBeenCalled();
	});

	it("does not retry a refresh superseded by newer publication authority", async () => {
		findMany.mockResolvedValue([instance()]);
		mocks.refresh.mockResolvedValue({
			complete: false,
			upserted: 0,
			errors: 0,
			errorMessages: [],
			superseded: true,
		});

		await app.register(jellyfinCacheSchedulerPlugin);
		await app.ready();
		await vi.advanceTimersByTimeAsync(45_000 + 20 * 60_000);
		expect(mocks.refresh).toHaveBeenCalledOnce();
		expect(findFirst).not.toHaveBeenCalled();
	});
});
