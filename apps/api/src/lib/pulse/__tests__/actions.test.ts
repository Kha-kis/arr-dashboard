/**
 * Dispatcher unit tests — per-kind behavior.
 *
 * The dispatcher is a pure function over a Zod-validated PulseAction and a
 * FastifyInstance. These tests stub the four external collaborators
 * (scheduler getters, require*Client helpers, refresh functions) so the
 * dispatcher's branching + error semantics can be asserted in isolation.
 */

import type { PulseAction } from "@arr/shared";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -----------------------------------------------------------------------------
// Module mocks — declared before the dispatcher import so vi can hoist them.
// -----------------------------------------------------------------------------

const huntingScheduler = {
	isRunning: vi.fn<() => boolean>(),
	start: vi.fn(),
	stop: vi.fn(),
};
const queueCleanerScheduler = {
	isRunning: vi.fn<() => boolean>(),
	start: vi.fn(),
	stop: vi.fn(),
};

vi.mock("../../hunting/scheduler.js", () => ({
	getHuntingScheduler: () => huntingScheduler,
}));
vi.mock("../../queue-cleaner/scheduler.js", () => ({
	getQueueCleanerScheduler: () => queueCleanerScheduler,
}));

const refreshPlexCache = vi.fn();
const refreshTautulliCache = vi.fn();
vi.mock("../../plex/plex-cache-refresher.js", () => ({
	refreshPlexCache: (...args: unknown[]) => refreshPlexCache(...args),
}));
vi.mock("../../tautulli/tautulli-cache-refresher.js", () => ({
	refreshTautulliCache: (...args: unknown[]) => refreshTautulliCache(...args),
}));

const requirePlexClient = vi.fn();
const requireTautulliClient = vi.fn();
vi.mock("../../plex/plex-helpers.js", () => ({
	requirePlexClient: (...args: unknown[]) => requirePlexClient(...args),
}));
vi.mock("../../tautulli/tautulli-helpers.js", () => ({
	requireTautulliClient: (...args: unknown[]) => requireTautulliClient(...args),
}));

import { InstanceNotFoundError } from "../../errors.js";
import { dispatchPulseAction } from "../actions.js";

// -----------------------------------------------------------------------------
// Harness
// -----------------------------------------------------------------------------

const fakeLog = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
	child: vi.fn(() => fakeLog),
} as unknown as FastifyBaseLogger;

const markEnabled = vi.fn();
const cacheStatusUpsert = vi.fn();

const fakeApp = {
	prisma: {
		cacheRefreshStatus: {
			upsert: (...args: unknown[]) => cacheStatusUpsert(...args),
		},
	},
	schedulerRegistry: {
		markEnabled: (jobId: string) => markEnabled(jobId),
	},
} as unknown as FastifyInstance;

beforeEach(() => {
	huntingScheduler.isRunning.mockReset();
	huntingScheduler.start.mockReset();
	queueCleanerScheduler.isRunning.mockReset();
	queueCleanerScheduler.start.mockReset();
	refreshPlexCache.mockReset();
	refreshTautulliCache.mockReset();
	requirePlexClient.mockReset();
	requireTautulliClient.mockReset();
	markEnabled.mockReset();
	cacheStatusUpsert.mockReset();
	cacheStatusUpsert.mockResolvedValue({});
});

afterEach(() => {
	vi.clearAllMocks();
});

// -----------------------------------------------------------------------------
// scheduler.enable
// -----------------------------------------------------------------------------

describe("dispatchPulseAction — scheduler.enable", () => {
	const huntAction: PulseAction = {
		kind: "scheduler.enable",
		target: { jobId: "hunting" },
		label: "Enable scheduler",
		confirmLabel: "Click again to enable",
		destructive: false,
	};
	const cleanerAction: PulseAction = {
		...huntAction,
		target: { jobId: "queue-cleaner" },
	};

	it("starts the hunt scheduler when it is not running", async () => {
		huntingScheduler.isRunning.mockReturnValue(false);

		const result = await dispatchPulseAction(fakeApp, "user-1", huntAction, fakeLog);

		expect(result).toEqual({ status: "ok" });
		expect(huntingScheduler.start).toHaveBeenCalledWith(fakeApp);
		expect(queueCleanerScheduler.start).not.toHaveBeenCalled();
		// Write-through: collectSchedulerHealth reads from the registry, not
		// from the scheduler class — so markEnabled must fire for the row
		// to actually drop on the next poll.
		expect(markEnabled).toHaveBeenCalledWith("hunting");
	});

	it("starts the queue-cleaner scheduler when it is not running", async () => {
		queueCleanerScheduler.isRunning.mockReturnValue(false);

		const result = await dispatchPulseAction(fakeApp, "user-1", cleanerAction, fakeLog);

		expect(result).toEqual({ status: "ok" });
		expect(queueCleanerScheduler.start).toHaveBeenCalledWith(fakeApp);
		expect(huntingScheduler.start).not.toHaveBeenCalled();
		expect(markEnabled).toHaveBeenCalledWith("queue-cleaner");
	});

	it("does NOT call markEnabled when the dispatcher short-circuits on already-running (409)", async () => {
		// Protects against a regression where a 409 inadvertently still wrote
		// to the registry — which would reset disabledReason audit data we
		// may want to preserve in future.
		huntingScheduler.isRunning.mockReturnValue(true);

		await expect(dispatchPulseAction(fakeApp, "user-1", huntAction, fakeLog)).rejects.toMatchObject(
			{ statusCode: 409 },
		);

		expect(markEnabled).not.toHaveBeenCalled();
	});

	it("throws ConflictError (statusCode 409) when the hunt scheduler is already running", async () => {
		huntingScheduler.isRunning.mockReturnValue(true);

		await expect(dispatchPulseAction(fakeApp, "user-1", huntAction, fakeLog)).rejects.toMatchObject(
			{
				name: "ConflictError",
				statusCode: 409,
				message: expect.stringContaining("hunting"),
			},
		);

		expect(huntingScheduler.start).not.toHaveBeenCalled();
	});

	it("throws ConflictError when the queue-cleaner is already running", async () => {
		queueCleanerScheduler.isRunning.mockReturnValue(true);

		await expect(
			dispatchPulseAction(fakeApp, "user-1", cleanerAction, fakeLog),
		).rejects.toMatchObject({
			statusCode: 409,
			message: expect.stringContaining("queue-cleaner"),
		});
	});
});

// -----------------------------------------------------------------------------
// cache.refresh
// -----------------------------------------------------------------------------

describe("dispatchPulseAction — cache.refresh", () => {
	const plexAction: PulseAction = {
		kind: "cache.refresh",
		target: { instanceId: "inst-plex-1", cacheType: "plex" },
		label: "Refresh now",
		confirmLabel: "Click again to refresh",
		destructive: false,
	};
	const tautulliAction: PulseAction = {
		...plexAction,
		target: { instanceId: "inst-tautulli-1", cacheType: "tautulli" },
	};

	it("refreshes the plex cache via requirePlexClient + refreshPlexCache", async () => {
		const fakeClient = { id: "plex-client" };
		requirePlexClient.mockResolvedValue({ client: fakeClient, instance: {} });
		refreshPlexCache.mockResolvedValue({ upserted: 42, errors: 0, errorMessages: [] });

		const result = await dispatchPulseAction(fakeApp, "user-1", plexAction, fakeLog);

		expect(result).toEqual({ status: "ok", detail: "42 item(s) refreshed" });
		expect(requirePlexClient).toHaveBeenCalledWith(fakeApp, "user-1", "inst-plex-1");
		expect(refreshPlexCache).toHaveBeenCalledWith(
			fakeClient,
			fakeApp.prisma,
			"inst-plex-1",
			fakeLog,
		);
		expect(requireTautulliClient).not.toHaveBeenCalled();
		// Write-through: collectCacheStaleness reads lastRefreshedAt from
		// CacheRefreshStatus. Without this upsert the row stays stale and
		// re-emits on the next poll.
		expect(cacheStatusUpsert).toHaveBeenCalledTimes(1);
		const upsertArgs = cacheStatusUpsert.mock.calls[0]?.[0] as {
			where: { instanceId_cacheType: { instanceId: string; cacheType: string } };
			update: { lastRefreshedAt: Date; lastResult: string; itemCount: number };
		};
		expect(upsertArgs.where.instanceId_cacheType).toEqual({
			instanceId: "inst-plex-1",
			cacheType: "plex",
		});
		expect(upsertArgs.update.lastResult).toBe("success");
		expect(upsertArgs.update.itemCount).toBe(42);
		expect(upsertArgs.update.lastRefreshedAt).toBeInstanceOf(Date);
	});

	it("refreshes the tautulli cache via requireTautulliClient + refreshTautulliCache", async () => {
		const fakeClient = { id: "tautulli-client" };
		requireTautulliClient.mockResolvedValue({ client: fakeClient, instance: {} });
		refreshTautulliCache.mockResolvedValue({ upserted: 7, errors: 0 });

		const result = await dispatchPulseAction(fakeApp, "user-1", tautulliAction, fakeLog);

		expect(result).toEqual({ status: "ok", detail: "7 item(s) refreshed" });
		expect(requireTautulliClient).toHaveBeenCalledWith(fakeApp, "user-1", "inst-tautulli-1");
		expect(refreshTautulliCache).toHaveBeenCalledWith(
			fakeClient,
			fakeApp.prisma,
			"inst-tautulli-1",
			fakeLog,
		);
		// Same write-through contract for the tautulli branch.
		expect(cacheStatusUpsert).toHaveBeenCalledTimes(1);
		const upsertArgs = cacheStatusUpsert.mock.calls[0]?.[0] as {
			where: { instanceId_cacheType: { instanceId: string; cacheType: string } };
		};
		expect(upsertArgs.where.instanceId_cacheType).toEqual({
			instanceId: "inst-tautulli-1",
			cacheType: "tautulli",
		});
	});

	it("does NOT call cacheRefreshStatus.upsert when the refresher rejects before completing", async () => {
		// Regression guard: a thrown ownership error (404) should short-circuit
		// before any write-through. Writing status on a failed refresh would
		// advance lastRefreshedAt dishonestly.
		requirePlexClient.mockRejectedValue(new InstanceNotFoundError("inst-plex-1"));

		await expect(dispatchPulseAction(fakeApp, "user-1", plexAction, fakeLog)).rejects.toMatchObject(
			{ statusCode: 404 },
		);

		expect(cacheStatusUpsert).not.toHaveBeenCalled();
	});

	it("propagates InstanceNotFoundError from requirePlexClient (ownership failure)", async () => {
		requirePlexClient.mockRejectedValue(new InstanceNotFoundError("inst-plex-1"));

		await expect(dispatchPulseAction(fakeApp, "user-1", plexAction, fakeLog)).rejects.toMatchObject(
			{
				name: "InstanceNotFoundError",
				statusCode: 404,
			},
		);
		expect(refreshPlexCache).not.toHaveBeenCalled();
	});

	it("propagates InstanceNotFoundError from requireTautulliClient", async () => {
		requireTautulliClient.mockRejectedValue(new InstanceNotFoundError("inst-tautulli-1"));

		await expect(
			dispatchPulseAction(fakeApp, "user-1", tautulliAction, fakeLog),
		).rejects.toMatchObject({
			statusCode: 404,
		});
		expect(refreshTautulliCache).not.toHaveBeenCalled();
	});
});
