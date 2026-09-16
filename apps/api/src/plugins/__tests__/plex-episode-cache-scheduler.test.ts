import Fastify, { type FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), observation: vi.fn() }));

vi.mock("../../lib/plex/plex-refresh-orchestration.js", () => ({
	refreshOwnedPlexEpisodeCache: mocks.refresh,
}));
vi.mock("../../lib/plex/plex-persisted-observation-repository.js", () => ({
	getPublishedEpisodeGenerationObservation: mocks.observation,
}));

import { dispatchPulseAction } from "../../lib/pulse/actions.js";
import type { FastifyWithEpisodeRefreshScheduler } from "../../lib/services/episode-refresh-scheduler-bridge.js";
import scheduler, { plexEpisodeRefreshResultStatus } from "../plex-episode-cache-scheduler.js";

let app: FastifyInstance;
let serializedLogs: string[];
let serviceInstanceFindFirst: ReturnType<typeof vi.fn>;

beforeEach(async () => {
	vi.useFakeTimers();
	serializedLogs = [];
	serviceInstanceFindFirst = vi.fn();
	mocks.refresh.mockReset().mockResolvedValue({
		complete: false,
		errors: 0,
		upserted: 0,
		refreshedShows: 0,
		capacityDegraded: false,
	});
	mocks.observation.mockReset().mockResolvedValue({ available: true });
	app = Fastify({
		logger: { level: "info", stream: { write: (record) => serializedLogs.push(record) } },
	});
	await app.register(
		fastifyPlugin(
			async (server) => {
				server.decorate("prisma", {
					serviceInstance: {
						findFirst: serviceInstanceFindFirst,
						findMany: vi.fn().mockResolvedValue([
							{ id: "a", label: "A" },
							{ id: "b", label: "B" },
						]),
					},
					providerObservationRun: { findFirst: vi.fn().mockResolvedValue(null) },
					cacheRefreshStatus: { findMany: vi.fn().mockResolvedValue([]) },
				} as never);
			},
			{ name: "prisma" },
		),
	);
	await app.register(
		fastifyPlugin(
			async (server) => {
				server.decorate("encryptor", {} as never);
			},
			{ name: "security" },
		),
	);
	await app.register(
		fastifyPlugin(
			async (server) => {
				server.decorate("notificationService", {
					notify: vi.fn().mockResolvedValue(undefined),
				} as never);
			},
			{ name: "notification-service" },
		),
	);
	await app.register(
		fastifyPlugin(
			async (server) => {
				server.decorate("schedulerRegistry", {
					track: vi.fn(async (_id: string, run: () => Promise<unknown>) => await run()),
				} as never);
			},
			{ name: "scheduler-registry" },
		),
	);
	await app.register(scheduler);
});

afterEach(async () => {
	await app.close();
	vi.useRealTimers();
});

describe("plexEpisodeRefreshResultStatus", () => {
	it("reports mixed authoritative success and attribution errors as partial", () => {
		expect(
			plexEpisodeRefreshResultStatus({
				errors: 1,
				upserted: 1,
				refreshedShows: 1,
				capacityDegraded: false,
			}),
		).toBe("partial");
	});

	it("reserves error for runs with no persisted refresh", () => {
		expect(
			plexEpisodeRefreshResultStatus({
				errors: 1,
				upserted: 0,
				refreshedShows: 1,
				capacityDegraded: false,
			}),
		).toBe("error");
	});

	it("keeps capacity degradation partial and complete runs successful", () => {
		expect(
			plexEpisodeRefreshResultStatus({
				errors: 0,
				upserted: 10,
				refreshedShows: 2,
				capacityDegraded: true,
			}),
		).toBe("partial");
		expect(
			plexEpisodeRefreshResultStatus({
				errors: 0,
				upserted: 10,
				refreshedShows: 2,
				capacityDegraded: false,
			}),
		).toBe("success");
	});
});

describe("Plex episode scheduler continuations", () => {
	it("routes Pulse Retry through the full continuation chain and suppresses duplicates", async () => {
		const instance = {
			id: "a",
			userId: "user-1",
			service: "PLEX" as const,
			enabled: true,
			label: "A",
		};
		serviceInstanceFindFirst.mockResolvedValue(instance);
		await app.ready();
		const action = {
			kind: "cache.refresh" as const,
			target: { instanceId: instance.id, cacheType: "plex_episode" as const },
			label: "Retry refresh",
			destructive: false as const,
		};
		mocks.refresh
			.mockResolvedValueOnce({
				complete: false,
				errors: 0,
				upserted: 0,
				refreshedShows: 0,
				capacityDegraded: false,
			})
			.mockResolvedValueOnce({
				complete: true,
				errors: 0,
				upserted: 1,
				refreshedShows: 1,
				capacityDegraded: false,
			});

		const [firstRetry, duplicateRetry] = await Promise.all([
			dispatchPulseAction(app, "user-1", action, app.log),
			dispatchPulseAction(app, "user-1", action, app.log),
		]);
		expect(firstRetry.backgroundTask).toBeInstanceOf(Promise);
		expect(duplicateRetry.backgroundTask).toBeUndefined();
		await firstRetry.backgroundTask;
		expect(mocks.refresh).toHaveBeenCalledOnce();
		expect(mocks.refresh.mock.calls[0]![0].resumeFailed).toBe(true);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(2);
		expect(mocks.refresh.mock.calls[1]![0].resumeFailed).toBe(false);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(2);
	});

	it("rejects a Retry whose owner lookup settles after shutdown begins", async () => {
		let resolveLookup!: (value: unknown) => void;
		serviceInstanceFindFirst.mockReturnValue(
			new Promise((resolve) => {
				resolveLookup = resolve;
			}),
		);
		await app.ready();
		const retry = (app as FastifyWithEpisodeRefreshScheduler).episodeRefreshScheduler.retry(
			"plex_episode",
			{ userId: "user-1", instanceId: "a" },
		);
		const closing = app.close();
		await vi.advanceTimersByTimeAsync(0);
		resolveLookup({ id: "a", userId: "user-1", service: "PLEX", enabled: true });
		expect(await retry).toEqual({ status: "unavailable" });
		await closing;
		expect(mocks.refresh).not.toHaveBeenCalled();
	});

	it("does not overlap a scheduled tick with an admitted manual page", async () => {
		const stored = { id: "a", userId: "user-1", service: "PLEX" as const, enabled: true };
		serviceInstanceFindFirst.mockResolvedValue(stored);
		(app.prisma.serviceInstance.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([stored]);
		let finish!: (value: unknown) => void;
		mocks.refresh.mockReturnValue(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		await app.ready();
		const retry = (app as FastifyWithEpisodeRefreshScheduler).episodeRefreshScheduler.retry(
			"plex_episode",
			{ userId: stored.userId, instanceId: stored.id },
		);
		await retry;
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(mocks.refresh).toHaveBeenCalledOnce();
		finish({ complete: true, errors: 0, upserted: 1, refreshedShows: 1, capacityDegraded: false });
		await app.close();
	});

	it.each(["wrong owner", "disabled instance"])("fails closed for %s", async () => {
		serviceInstanceFindFirst.mockResolvedValue(null);
		await app.ready();
		const result = await (app as FastifyWithEpisodeRefreshScheduler).episodeRefreshScheduler.retry(
			"plex_episode",
			{
				userId: "user-1",
				instanceId: "a",
			},
		);
		expect(result).toEqual({ status: "ineligible" });
		expect(mocks.refresh).not.toHaveBeenCalled();
	});

	it("does not accept a manual Retry after scheduler shutdown", async () => {
		serviceInstanceFindFirst.mockResolvedValue({
			id: "a",
			userId: "user-1",
			service: "PLEX",
			enabled: true,
		});
		await app.ready();
		await app.close();
		const result = await (app as FastifyWithEpisodeRefreshScheduler).episodeRefreshScheduler.retry(
			"plex_episode",
			{
				userId: "user-1",
				instanceId: "a",
			},
		);
		expect(result).toEqual({ status: "unavailable" });
	});

	it("drains an admitted manual page before scheduler close completes", async () => {
		const stored = { id: "a", userId: "user-1", service: "PLEX" as const, enabled: true };
		serviceInstanceFindFirst.mockResolvedValue(stored);
		let finish!: (value: unknown) => void;
		mocks.refresh.mockReturnValue(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		await app.ready();
		const admission = await (
			app as FastifyWithEpisodeRefreshScheduler
		).episodeRefreshScheduler.retry("plex_episode", {
			userId: stored.userId,
			instanceId: stored.id,
		});
		if (admission.status !== "accepted") throw new Error("Expected accepted retry");
		expect(admission.backgroundTask).toBeInstanceOf(Promise);
		const closing = app.close();
		await vi.advanceTimersByTimeAsync(0);
		let closed = false;
		void closing.then(() => {
			closed = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(closed).toBe(false);
		finish({ complete: true, errors: 0, upserted: 1, refreshedShows: 1, capacityDegraded: false });
		await closing;
		expect(closed).toBe(true);
	});

	it("does not schedule a dependency retry after shutdown during an in-flight request", async () => {
		(app.prisma.serviceInstance.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ id: "a", label: "A" },
		]);
		let finish!: (result: unknown) => void;
		mocks.refresh.mockReturnValueOnce(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		await app.ready();
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		const closing = app.close();
		await Promise.resolve();
		finish({
			complete: false,
			errors: 1,
			upserted: 0,
			retryCategory: "parent-refresh-unavailable",
		});
		await closing;
		await vi.advanceTimersByTimeAsync(30_000);
		expect(mocks.refresh).toHaveBeenCalledOnce();
	});

	it("resumes failed work only at startup and preserves exhaustion on recurring ticks", async () => {
		(app.prisma.serviceInstance.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ id: "a", label: "A" },
		]);
		mocks.refresh.mockResolvedValue({
			complete: true,
			errors: 0,
			upserted: 1,
			refreshedShows: 1,
			capacityDegraded: false,
		});

		await app.ready();
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);

		expect(mocks.refresh.mock.calls.map(([input]) => input.resumeFailed)).toEqual([true, false]);
	});

	it("starts independent instances together and continues unfinished work after 30 seconds", async () => {
		await app.ready();
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(2);
		expect(mocks.refresh.mock.calls.map(([input]) => input.resumeFailed)).toEqual([true, true]);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(4);
		expect(mocks.refresh.mock.calls.slice(2).map(([input]) => input.resumeFailed)).toEqual([
			false,
			false,
		]);
	});

	it("honors persisted 30-second, 2-minute, and 10-minute retry deadlines then stops exhausted work", async () => {
		(app.prisma.serviceInstance.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ id: "a", label: "A" },
		]);
		const delays = [30_000, 120_000, 600_000];
		mocks.refresh.mockResolvedValue({
			complete: false,
			errors: 1,
			upserted: 0,
			refreshedShows: 0,
			capacityDegraded: false,
		});
		(app.prisma.providerObservationRun.findFirst as ReturnType<typeof vi.fn>).mockImplementation(
			async () => {
				const delay = delays.shift();
				return delay === undefined ? null : { nextAttemptAt: new Date(Date.now() + delay) };
			},
		);
		await app.ready();
		await vi.advanceTimersByTimeAsync(5 * 60_000);
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

	it("retries parent-refresh-unavailable three times with bounded backoff", async () => {
		(app.prisma.serviceInstance.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ id: "a", label: "A" },
		]);
		mocks.refresh.mockResolvedValue({
			complete: false,
			errors: 1,
			upserted: 0,
			refreshedShows: 0,
			capacityDegraded: false,
			retryCategory: "parent-refresh-unavailable",
		});

		await app.ready();
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(4);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(4);
		expect(mocks.refresh.mock.calls.map(([input]) => input.resumeFailed)).toEqual([
			true,
			false,
			false,
			false,
		]);
	});

	it("continues a valid parent-refresh wait beyond bounded backoff and resumes automatically", async () => {
		(app.prisma.serviceInstance.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ id: "a", label: "A" },
		]);
		const continuationAttempt = {
			attemptedAt: new Date("2026-09-15T12:00:00.000Z"),
			resultMarker: "in_progress:parent-wait-test",
		};
		const pending = {
			complete: false,
			errors: 0,
			upserted: 0,
			refreshedShows: 0,
			capacityDegraded: false,
			retryCategory: "parent-refresh-in-progress" as const,
			continuationAttempt,
		};
		const complete = {
			complete: true,
			errors: 0,
			upserted: 1,
			refreshedShows: 1,
			capacityDegraded: false,
		};
		mocks.refresh.mockImplementation(async () =>
			mocks.refresh.mock.calls.length < 25 ? pending : complete,
		);

		await app.ready();
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(1);
		expect(mocks.refresh.mock.calls[0]?.[1]).toBeUndefined();
		for (let retry = 0; retry < 24; retry += 1) {
			await vi.advanceTimersByTimeAsync(30_000);
		}
		expect(mocks.refresh).toHaveBeenCalledTimes(25);
		expect(mocks.refresh.mock.calls[1]?.[1]).toEqual(continuationAttempt);
		expect(mocks.refresh.mock.calls.at(-1)?.[0].resumeFailed).toBe(false);
	});

	it("retries temporary live identity unavailability three times with bounded backoff", async () => {
		(app.prisma.serviceInstance.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ id: "a", label: "A" },
		]);
		mocks.refresh.mockResolvedValue({
			complete: false,
			errors: 1,
			upserted: 0,
			refreshedShows: 0,
			capacityDegraded: false,
			retryCategory: "identity-unavailable",
		});

		await app.ready();
		await vi.advanceTimersByTimeAsync(5 * 60_000);
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

	it("does not retry an ordinary unavailable parent without an active run", async () => {
		(app.prisma.serviceInstance.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ id: "a", label: "A" },
		]);
		mocks.refresh.mockResolvedValue({
			complete: false,
			errors: 1,
			upserted: 0,
			refreshedShows: 0,
			capacityDegraded: false,
		});

		await app.ready();
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		await vi.advanceTimersByTimeAsync(30 * 60_000);

		expect(mocks.refresh).toHaveBeenCalledTimes(1);
	});

	it("does not continue a superseded finalization owned by another attempt", async () => {
		(app.prisma.serviceInstance.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ id: "a", label: "A" },
		]);
		mocks.refresh.mockResolvedValue({
			complete: false,
			errors: 0,
			upserted: 0,
			refreshedShows: 0,
			capacityDegraded: false,
			superseded: true,
		});

		await app.ready();
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		await vi.advanceTimersByTimeAsync(30 * 60_000);

		expect(mocks.refresh).toHaveBeenCalledTimes(1);
	});

	it("serializes only aggregate completion fields and never provider identifiers or errors", async () => {
		(app.prisma.serviceInstance.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ id: "instance-secret-42", label: "Private Plex Library" },
		]);
		mocks.refresh.mockResolvedValue({
			complete: true,
			errors: 0,
			upserted: 1,
			refreshedShows: 1,
			capacityDegraded: false,
			errorMessages: ["https://token.example/private-title?token=private-token private-section-id"],
		});
		await app.ready();
		await vi.advanceTimersByTimeAsync(5 * 60_000);

		const records = serializedLogs.join("\n");
		expect(records).toContain("plex-episode-cache-refresh-completed");
		for (const privateValue of [
			"instance-secret-42",
			"Private Plex Library",
			"https://token.example/private-title?token=private-token",
			"private-token",
			"private-section-id",
		]) {
			expect(records).not.toContain(privateValue);
		}
	});

	it("serializes scheduler failures without provider canaries", async () => {
		const canaries = [
			"https://private.invalid/Private-Title?token=secret",
			"Private Plex Label",
			"private-instance-id",
			"private-section-id",
		];
		(app.prisma.serviceInstance.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ id: canaries[2], label: canaries[1] },
		]);
		mocks.refresh.mockRejectedValue(new Error(canaries.join(" ")));
		await app.ready();
		await vi.advanceTimersByTimeAsync(5 * 60_000);

		const records = serializedLogs.join("\n");
		expect(records).toContain("plex-episode-cache-refresh-failed");
		for (const canary of canaries) expect(records).not.toContain(canary);
	});
});
