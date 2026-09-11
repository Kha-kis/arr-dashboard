import Fastify, { type FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JELLYFIN_EPISODE_SUCCESSFUL_PROGRESS_CONTINUATION_DELAY_MS } from "../../lib/jellyfin/jellyfin-episode-refresh-policy.js";

const mocks = vi.hoisted(() => ({
	refresh: vi.fn(),
	runSingleFlight: vi.fn(),
}));

vi.mock("../../lib/jellyfin/jellyfin-episode-cache-refresher.js", () => ({
	refreshOwnedJellyfinEpisodeCache: mocks.refresh,
}));
vi.mock("../../lib/jellyfin/jellyfin-cache-singleflight.js", () => ({
	runJellyfinCacheRefreshSingleFlight: mocks.runSingleFlight,
}));

import { dispatchPulseAction } from "../../lib/pulse/actions.js";
import type { FastifyWithEpisodeRefreshScheduler } from "../../lib/services/episode-refresh-scheduler-bridge.js";
import jellyfinEpisodeCacheSchedulerPlugin, {
	refreshScheduledJellyfinEpisodeCacheInstance,
} from "../jellyfin-episode-cache-scheduler.js";

function instance(service: "JELLYFIN" | "EMBY" = "EMBY") {
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

describe("refreshScheduledJellyfinEpisodeCacheInstance", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.runSingleFlight.mockImplementation(
			async (_authority: unknown, _cacheType: unknown, refresh: () => Promise<unknown>) =>
				await refresh(),
		);
		mocks.refresh.mockResolvedValue({ complete: true, upserted: 1, errors: 0, progressed: false });
	});

	it.each(["JELLYFIN", "EMBY"] as const)(
		"forwards the raw %s instance and encryptor through the episode flight",
		async (service) => {
			const state = app();
			const stored = instance(service);
			const result = await refreshScheduledJellyfinEpisodeCacheInstance(
				state as never,
				stored as never,
				true,
			);

			expect(mocks.runSingleFlight).toHaveBeenCalledWith(
				expect.objectContaining({
					id: stored.id,
					userId: stored.userId,
					encryptedApiKey: stored.encryptedApiKey,
				}),
				"jellyfin_episode",
				expect.any(Function),
			);
			expect(mocks.refresh).toHaveBeenCalledWith({
				prisma: state.prisma,
				encryptor: state.encryptor,
				instance: stored,
				log: state.log,
				resumeFailed: true,
			});
			expect(result).toEqual({ complete: true, upserted: 1, errors: 0, progressed: false });
			expect(state.encryptor.decrypt).not.toHaveBeenCalled();
			expect(state.log.error).not.toHaveBeenCalled();
		},
	);

	it("logs only bounded generic data when an owned refresh rejects", async () => {
		const state = app();
		const stored = instance();
		const secret = "secret-error-marker";
		mocks.runSingleFlight.mockRejectedValue(new Error(secret));

		await refreshScheduledJellyfinEpisodeCacheInstance(state as never, stored as never);

		const errorCalls = state.log.error.mock.calls;
		expect(errorCalls).toHaveLength(1);
		expect(errorCalls[0]).toEqual([
			{ instanceId: stored.id, category: "refresh-failed" },
			"Jellyfin episode cache refresh failed for instance",
		]);
		expect(errorCalls.flat()).not.toContain(secret);
		expect(errorCalls.flat()).not.toContain(stored.label);
		expect(errorCalls.flat()).not.toContain(stored.baseUrl);
		expect(state.log.error).toHaveBeenCalledWith(
			{ instanceId: stored.id, category: "refresh-failed" },
			"Jellyfin episode cache refresh failed for instance",
		);
	});
});

describe("Jellyfin episode cache scheduler lifecycle", () => {
	let app: FastifyInstance;
	let findInstances: ReturnType<typeof vi.fn>;
	let findRetryInstance: ReturnType<typeof vi.fn>;
	let findFailedRun: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		mocks.runSingleFlight.mockImplementation(
			async (_authority: unknown, _cacheType: unknown, refresh: () => Promise<unknown>) =>
				await refresh(),
		);
		mocks.refresh.mockResolvedValue({ complete: false, upserted: 0, errors: 0, progressed: false });
		findInstances = vi
			.fn()
			.mockResolvedValue([instance("JELLYFIN"), { ...instance("EMBY"), id: "instance-2" }]);
		findRetryInstance = vi.fn();
		findFailedRun = vi.fn().mockResolvedValue(null);
		app = Fastify({ logger: false });

		void app.register(
			fastifyPlugin(
				async (server) => {
					server.decorate("prisma", {
						serviceInstance: { findMany: findInstances, findFirst: findRetryInstance },
						providerObservationRun: { findFirst: findFailedRun },
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

	it("routes Jellyfin Pulse Retry into the continuation chain with a fresh owner lookup", async () => {
		const stored = instance("JELLYFIN");
		findRetryInstance.mockResolvedValue(stored);
		await app.register(jellyfinEpisodeCacheSchedulerPlugin);
		await app.ready();

		const result = await dispatchPulseAction(
			app,
			stored.userId,
			{
				kind: "cache.refresh",
				target: { instanceId: stored.id, cacheType: "jellyfin_episode" },
				label: "Retry refresh",
				destructive: false,
			},
			app.log,
		);
		expect(result).toMatchObject({ status: "ok", backgroundTask: expect.any(Promise) });
		await vi.advanceTimersByTimeAsync(0);
		expect(mocks.refresh).toHaveBeenCalledOnce();
		expect(mocks.refresh.mock.calls[0]![0].resumeFailed).toBe(true);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(2);
		expect(mocks.refresh.mock.calls.slice(1).map(([input]) => input.resumeFailed)).toEqual([false]);
	});

	it.each(["wrong owner", "disabled instance"])("rejects manual Retry for %s", async () => {
		findRetryInstance.mockResolvedValue(null);
		await app.register(jellyfinEpisodeCacheSchedulerPlugin);
		await app.ready();
		const result = await (app as FastifyWithEpisodeRefreshScheduler).episodeRefreshScheduler.retry(
			"jellyfin_episode",
			{
				userId: "user-1",
				instanceId: "instance-1",
			},
		);
		expect(result).toEqual({ status: "ineligible" });
		expect(mocks.refresh).not.toHaveBeenCalled();
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
							timeoutSpy.mock.calls.filter(([, delay]) => delay === 6 * 60 * 1000).length +
							intervalSpy.mock.calls.filter(([, delay]) => delay === 6 * 60 * 60 * 1000).length;
					});
				},
				{ name: "provider-cache-attempt-recovery" },
			),
		);
		await app.register(jellyfinEpisodeCacheSchedulerPlugin);

		await app.ready();

		expect(schedulerTimersWhenRecoveryReady).toBe(0);
		expect(timeoutSpy.mock.calls.filter(([, delay]) => delay === 6 * 60 * 1000)).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
		expect(intervalSpy.mock.calls.filter(([, delay]) => delay === 6 * 60 * 60 * 1000)).toHaveLength(
			1,
		);
	});

	it("continues each unfinished instance after 30 seconds without resuming failed units", async () => {
		await app.register(jellyfinEpisodeCacheSchedulerPlugin);
		await app.ready();

		await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
		expect(mocks.refresh).toHaveBeenCalledTimes(2);
		expect(mocks.refresh.mock.calls.map(([input]) => input.resumeFailed)).toEqual([true, true]);

		await vi.advanceTimersByTimeAsync(30_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(4);
		expect(mocks.refresh.mock.calls.slice(2).map(([input]) => input.resumeFailed)).toEqual([
			false,
			false,
		]);
	});

	it("retries one unexpected refresh rejection through the bounded continuation chain", async () => {
		findInstances.mockResolvedValue([instance("JELLYFIN")]);
		mocks.runSingleFlight
			.mockRejectedValueOnce(new Error("private refresh failure"))
			.mockImplementation(
				async (_authority: unknown, _cacheType: unknown, refresh: () => Promise<unknown>) =>
					await refresh(),
			);
		mocks.refresh.mockResolvedValue({ complete: false, upserted: 0, errors: 0, progressed: true });
		await app.register(jellyfinEpisodeCacheSchedulerPlugin);
		await app.ready();

		await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
		expect(mocks.runSingleFlight).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(mocks.runSingleFlight).toHaveBeenCalledTimes(2);
		expect(mocks.refresh).toHaveBeenCalledOnce();
		expect(mocks.refresh.mock.calls[0]![0].resumeFailed).toBe(false);
		expect(mocks.refresh.mock.calls[0]![0].automaticRenewal).toBeUndefined();
	});

	it("stops unexpected refresh rejections after the finite transient budget", async () => {
		findInstances.mockResolvedValue([instance("JELLYFIN")]);
		mocks.runSingleFlight.mockRejectedValue(new Error("private refresh failure"));
		await app.register(jellyfinEpisodeCacheSchedulerPlugin);
		await app.ready();

		await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
		expect(mocks.runSingleFlight).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(mocks.runSingleFlight).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(mocks.runSingleFlight).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(mocks.runSingleFlight).toHaveBeenCalledTimes(4);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(mocks.runSingleFlight).toHaveBeenCalledTimes(4);
	});

	it("preserves the transient budget across no-progress and query failures", async () => {
		findInstances.mockResolvedValue([instance("JELLYFIN")]);
		findFailedRun.mockRejectedValue(new Error("private state failure"));
		mocks.runSingleFlight
			.mockRejectedValueOnce(new Error("private refresh failure"))
			.mockImplementationOnce(
				async (_authority: unknown, _cacheType: unknown, refresh: () => Promise<unknown>) =>
					await refresh(),
			)
			.mockRejectedValueOnce(new Error("private refresh failure"))
			.mockImplementationOnce(
				async (_authority: unknown, _cacheType: unknown, refresh: () => Promise<unknown>) =>
					await refresh(),
			)
			.mockRejectedValue(new Error("private refresh failure"));
		mocks.refresh
			.mockResolvedValueOnce({ complete: false, upserted: 0, errors: 0, progressed: false })
			.mockResolvedValue({ complete: false, upserted: 0, errors: 1, progressed: false });
		await app.register(jellyfinEpisodeCacheSchedulerPlugin);
		await app.ready();

		await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
		expect(mocks.runSingleFlight).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(mocks.runSingleFlight).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(mocks.runSingleFlight).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(mocks.runSingleFlight).toHaveBeenCalledTimes(4);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(mocks.runSingleFlight).toHaveBeenCalledTimes(5);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(mocks.runSingleFlight).toHaveBeenCalledTimes(5);
	});

	it("resets the transient budget only after durable progress", async () => {
		findInstances.mockResolvedValue([instance("JELLYFIN")]);
		findFailedRun.mockResolvedValue({ state: "running", nextAttemptAt: null });
		mocks.runSingleFlight
			.mockImplementationOnce(
				async (_authority: unknown, _cacheType: unknown, refresh: () => Promise<unknown>) =>
					await refresh(),
			)
			.mockImplementationOnce(
				async (_authority: unknown, _cacheType: unknown, refresh: () => Promise<unknown>) =>
					await refresh(),
			)
			.mockRejectedValueOnce(new Error("private refresh failure"))
			.mockImplementation(
				async (_authority: unknown, _cacheType: unknown, refresh: () => Promise<unknown>) =>
					await refresh(),
			);
		mocks.refresh
			.mockResolvedValueOnce({ complete: false, upserted: 0, errors: 1, progressed: false })
			.mockResolvedValueOnce({ complete: false, upserted: 0, errors: 0, progressed: true })
			.mockResolvedValue({ complete: true, upserted: 0, errors: 0, progressed: false });
		await app.register(jellyfinEpisodeCacheSchedulerPlugin);
		await app.ready();

		await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
		expect(mocks.runSingleFlight).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(mocks.runSingleFlight).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(JELLYFIN_EPISODE_SUCCESSFUL_PROGRESS_CONTINUATION_DELAY_MS);
		expect(mocks.runSingleFlight).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(mocks.runSingleFlight).toHaveBeenCalledTimes(4);
	});

	it("uses a fresh retry budget when progressed work meets a state-query failure", async () => {
		findInstances.mockResolvedValue([instance("JELLYFIN")]);
		findFailedRun
			.mockResolvedValueOnce({ state: "running", nextAttemptAt: null })
			.mockResolvedValueOnce({ state: "running", nextAttemptAt: null })
			.mockResolvedValueOnce({ state: "running", nextAttemptAt: null })
			.mockRejectedValueOnce(new Error("private state failure"));
		mocks.refresh
			.mockResolvedValueOnce({ complete: false, upserted: 0, errors: 1, progressed: false })
			.mockResolvedValueOnce({ complete: false, upserted: 0, errors: 1, progressed: false })
			.mockResolvedValueOnce({ complete: false, upserted: 0, errors: 1, progressed: false })
			.mockResolvedValueOnce({ complete: false, upserted: 0, errors: 1, progressed: true })
			.mockResolvedValue({ complete: true, upserted: 0, errors: 0, progressed: false });
		await app.register(jellyfinEpisodeCacheSchedulerPlugin);
		await app.ready();

		await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
		expect(mocks.runSingleFlight).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(30_000);
		await vi.advanceTimersByTimeAsync(120_000);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(mocks.runSingleFlight).toHaveBeenCalledTimes(4);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(mocks.runSingleFlight).toHaveBeenCalledTimes(5);
		expect(mocks.refresh.mock.calls[4]![0].resumeFailed).toBe(false);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(mocks.runSingleFlight).toHaveBeenCalledTimes(5);
	});

	it("continues a successfully progressed instance after the shared ten-second delay", async () => {
		mocks.refresh.mockResolvedValue({ complete: false, upserted: 0, errors: 0, progressed: true });
		await app.register(jellyfinEpisodeCacheSchedulerPlugin);
		await app.ready();

		await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
		expect(mocks.refresh).toHaveBeenCalledTimes(2);

		await vi.advanceTimersByTimeAsync(JELLYFIN_EPISODE_SUCCESSFUL_PROGRESS_CONTINUATION_DELAY_MS);
		expect(mocks.refresh).toHaveBeenCalledTimes(4);
	});

	it("stops after an explicit deferred renewal even when the run rereads as running", async () => {
		findInstances.mockResolvedValue([instance("JELLYFIN")]);
		mocks.refresh.mockResolvedValue({
			complete: false,
			errors: 0,
			progressed: false,
			renewalDeferred: true,
		});
		await app.register(jellyfinEpisodeCacheSchedulerPlugin);
		await app.ready();

		await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
		expect(mocks.refresh).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(1);
	});

	it.each([0, 1])(
		"does not continue when a refresh settles after close (errors=%i)",
		async (errors) => {
			findInstances.mockResolvedValue([instance("JELLYFIN")]);
			let settle!: (value: unknown) => void;
			mocks.refresh.mockImplementation(
				() =>
					new Promise((resolve) => {
						settle = resolve;
					}),
			);
			await app.register(jellyfinEpisodeCacheSchedulerPlugin);
			await app.ready();
			await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
			expect(mocks.refresh).toHaveBeenCalledTimes(1);
			const closing = app.close();
			await vi.advanceTimersByTimeAsync(0);
			settle({ complete: false, upserted: 0, errors, progressed: true });
			await closing;
			await vi.advanceTimersByTimeAsync(60_000);
			expect(mocks.refresh).toHaveBeenCalledTimes(1);
			expect(findFailedRun).not.toHaveBeenCalled();
		},
	);

	it("does not continue when the retry-state read settles after close", async () => {
		findInstances.mockResolvedValue([instance("JELLYFIN")]);
		mocks.refresh.mockResolvedValue({ complete: false, upserted: 0, errors: 1, progressed: false });
		let settle!: (value: unknown) => void;
		findFailedRun.mockImplementation(
			() =>
				new Promise((resolve) => {
					settle = resolve;
				}),
		);
		await app.register(jellyfinEpisodeCacheSchedulerPlugin);
		await app.ready();
		await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
		expect(findFailedRun).toHaveBeenCalledTimes(1);
		const closing = app.close();
		await vi.advanceTimersByTimeAsync(0);
		settle({ state: "running", nextAttemptAt: null });
		await closing;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(1);
	});

	it("does not schedule continuation after a complete refresh", async () => {
		mocks.refresh.mockResolvedValue({ complete: true, upserted: 1, errors: 0, progressed: false });
		const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
		await app.register(jellyfinEpisodeCacheSchedulerPlugin);
		await app.ready();
		const continuationTimerCount = timeoutSpy.mock.calls.filter(
			([, delay]) => delay === 10_000 || delay === 30_000,
		).length;

		await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
		expect(mocks.refresh).toHaveBeenCalledTimes(2);
		expect(
			timeoutSpy.mock.calls.filter(([, delay]) => delay === 10_000 || delay === 30_000),
		).toHaveLength(continuationTimerCount);
	});

	it("resumes failed work only at startup and preserves exhaustion on recurring ticks", async () => {
		findInstances.mockResolvedValue([instance("JELLYFIN")]);
		mocks.refresh.mockResolvedValue({ complete: true, upserted: 1, errors: 0 });
		await app.register(jellyfinEpisodeCacheSchedulerPlugin);
		await app.ready();

		await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
		await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);

		expect(mocks.refresh.mock.calls.map(([input]) => input.resumeFailed)).toEqual([true, false]);
		expect(mocks.refresh.mock.calls[0]![0].automaticRenewal).toBeUndefined();
		expect(mocks.refresh.mock.calls[1]![0].automaticRenewal).toBe("provider-unavailable-cooldown");
	});

	it("starts separate instances independently instead of serializing provider work", async () => {
		let releaseFirst: (value: { complete: boolean; upserted: number; errors: number }) => void =
			() => undefined;
		mocks.refresh
			.mockImplementationOnce(
				async () =>
					await new Promise<{ complete: boolean; upserted: number; errors: number }>((resolve) => {
						releaseFirst = resolve;
					}),
			)
			.mockResolvedValue({ complete: true, upserted: 0, errors: 0 });
		await app.register(jellyfinEpisodeCacheSchedulerPlugin);
		await app.ready();

		await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
		try {
			expect(mocks.refresh).toHaveBeenCalledTimes(2);
		} finally {
			releaseFirst({ complete: true, upserted: 0, errors: 0 });
			await Promise.resolve();
		}
	});

	it("honors persisted retry deadlines and stops when failed work is exhausted", async () => {
		findInstances.mockResolvedValue([instance("JELLYFIN")]);
		const delays = [30_000, 120_000, 600_000];
		mocks.refresh.mockResolvedValue({ complete: false, upserted: 0, errors: 1 });
		findFailedRun.mockImplementation(async () => {
			const delay = delays.shift();
			return delay === undefined
				? { state: "failed", nextAttemptAt: null }
				: { state: "failed", nextAttemptAt: new Date(Date.now() + delay) };
		});
		await app.register(jellyfinEpisodeCacheSchedulerPlugin);
		await app.ready();

		await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
		expect(mocks.refresh).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(4);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(4);
	});

	it("replans once without an active run and retains the replan budget across successful pages", async () => {
		findInstances.mockResolvedValue([instance("JELLYFIN")]);
		mocks.refresh
			.mockResolvedValueOnce({
				complete: false,
				errors: 1,
				progressed: false,
				replanRequired: true,
			})
			.mockResolvedValueOnce({ complete: false, errors: 0, progressed: true })
			.mockResolvedValue({ complete: false, errors: 1, progressed: false, replanRequired: true });
		await app.register(jellyfinEpisodeCacheSchedulerPlugin);
		await app.ready();
		await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
		expect(mocks.refresh).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(2);
		expect(mocks.refresh.mock.calls[1]![0].resumeFailed).toBe(false);
		await vi.advanceTimersByTimeAsync(JELLYFIN_EPISODE_SUCCESSFUL_PROGRESS_CONTINUATION_DELAY_MS);
		expect(mocks.refresh).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
		expect(mocks.refresh).toHaveBeenCalledTimes(3);
	});

	it("does not retry a superseded attempt even if another active run exists", async () => {
		findInstances.mockResolvedValue([instance("JELLYFIN")]);
		findFailedRun.mockResolvedValue({ state: "running", nextAttemptAt: null });
		mocks.refresh.mockResolvedValue({
			complete: false,
			errors: 1,
			progressed: false,
			superseded: true,
		});
		await app.register(jellyfinEpisodeCacheSchedulerPlugin);
		await app.ready();
		await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
		await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
		expect(mocks.refresh).toHaveBeenCalledOnce();
		expect(findFailedRun).not.toHaveBeenCalled();
	});

	it("cancels a pending catalog replan during shutdown", async () => {
		findInstances.mockResolvedValue([instance("JELLYFIN")]);
		mocks.refresh.mockResolvedValue({
			complete: false,
			errors: 1,
			progressed: false,
			replanRequired: true,
		});
		await app.register(jellyfinEpisodeCacheSchedulerPlugin);
		await app.ready();
		await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
		expect(vi.getTimerCount()).toBe(2);
		await app.close();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(mocks.refresh).toHaveBeenCalledOnce();
	});

	it("bounds transient identity-unavailable retries for an otherwise running durable run", async () => {
		findInstances.mockResolvedValue([instance("JELLYFIN")]);
		mocks.refresh.mockResolvedValue({ complete: false, upserted: 0, errors: 1 });
		findFailedRun.mockResolvedValue({ state: "running", nextAttemptAt: null });
		await app.register(jellyfinEpisodeCacheSchedulerPlugin);
		await app.ready();

		await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
		expect(mocks.refresh).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(4);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(4);
	});

	it("bounds a continuation-state query failure without an unhandled rejection", async () => {
		findInstances.mockResolvedValue([instance("JELLYFIN")]);
		mocks.refresh.mockResolvedValue({ complete: false, upserted: 0, errors: 1 });
		findFailedRun.mockRejectedValue(new Error("private database diagnostic"));
		const errorSpy = vi.spyOn(app.log, "error");
		await app.register(jellyfinEpisodeCacheSchedulerPlugin);
		await app.ready();

		await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
		expect(mocks.refresh).toHaveBeenCalledOnce();
		expect(errorSpy).toHaveBeenCalledWith(
			{ category: "episode-continuation-state-failed" },
			"Jellyfin episode cache continuation state unavailable",
		);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(4);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(4);
	});

	it("cancels every pending continuation during shutdown", async () => {
		await app.register(jellyfinEpisodeCacheSchedulerPlugin);
		await app.ready();
		await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
		expect(mocks.refresh).toHaveBeenCalledTimes(2);

		await app.close();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(2);
	});

	it("cancels a pending ten-second progress continuation during shutdown", async () => {
		mocks.refresh.mockResolvedValue({ complete: false, upserted: 0, errors: 0, progressed: true });
		await app.register(jellyfinEpisodeCacheSchedulerPlugin);
		await app.ready();
		await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
		expect(mocks.refresh).toHaveBeenCalledTimes(2);

		await app.close();
		await vi.advanceTimersByTimeAsync(JELLYFIN_EPISODE_SUCCESSFUL_PROGRESS_CONTINUATION_DELAY_MS);
		expect(mocks.refresh).toHaveBeenCalledTimes(2);
	});
});
