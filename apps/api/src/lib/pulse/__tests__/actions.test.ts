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
vi.mock("../../plex/plex-cache-refresher.js", () => ({
	refreshPlexCache: (...args: unknown[]) => refreshPlexCache(...args),
}));

const requirePlexClient = vi.fn();
vi.mock("../../plex/plex-helpers.js", () => ({
	requirePlexClient: (...args: unknown[]) => requirePlexClient(...args),
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
	requirePlexClient.mockReset();
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
		destructive: false,
	};

	it("refreshes the plex cache via requirePlexClient + refreshPlexCache", async () => {
		const fakeClient = { id: "plex-client" };
		requirePlexClient.mockResolvedValue({ client: fakeClient, instance: {} });
		refreshPlexCache.mockResolvedValue({ upserted: 42, errors: 0, errorMessages: [] });

		const result = await dispatchPulseAction(fakeApp, "user-1", plexAction, fakeLog);

		// Dispatch returns immediately with `status: "ok"` — the refresh runs
		// in the background to avoid blowing through the HTTP proxy timeout
		// on large libraries. `detail` is no longer populated because we
		// don't yet know the upsert count at return time.
		expect(result.status).toBe("ok");
		expect(result.detail).toBeUndefined();
		expect(requirePlexClient).toHaveBeenCalledWith(fakeApp, "user-1", "inst-plex-1");

		// Await the background task so the rest of the assertions see the
		// post-refresh state. In production the route handler does NOT await
		// this; the HTTP client has already received 200.
		await result.backgroundTask;

		expect(refreshPlexCache).toHaveBeenCalledWith(
			fakeClient,
			fakeApp.prisma,
			"inst-plex-1",
			fakeLog,
		);
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

	it("returns 200 immediately even when the refresher is slow — fire-and-forget contract", async () => {
		// Regression guard for the Next.js proxy timeout issue. If this
		// test times out or returns after the refresher resolves, someone
		// has re-introduced the `await refreshPlexCache(...)` in the main
		// code path.
		requirePlexClient.mockResolvedValue({ client: {}, instance: {} });
		let resolveRefresh: (v: unknown) => void = () => {};
		const pendingRefresh = new Promise((r) => {
			resolveRefresh = r;
		});
		refreshPlexCache.mockReturnValue(pendingRefresh);

		const dispatchStart = Date.now();
		const result = await dispatchPulseAction(fakeApp, "user-1", plexAction, fakeLog);
		const dispatchElapsed = Date.now() - dispatchStart;

		// Must return well under the proxy's 30s timeout — we target < 100ms
		// even on loaded CI boxes. In practice dispatch returns in <10ms
		// because the only `await` is requirePlexClient (stubbed).
		expect(dispatchElapsed).toBeLessThan(100);
		expect(result.status).toBe("ok");
		// The refresher has NOT completed yet — upsert should not have fired.
		expect(cacheStatusUpsert).not.toHaveBeenCalled();

		// Let the slow refresh complete, then the background task should
		// run the write-through.
		resolveRefresh({ upserted: 999, errors: 0, errorMessages: [] });
		await result.backgroundTask;

		expect(cacheStatusUpsert).toHaveBeenCalledTimes(1);
	});

	it("does NOT write through when the BACKGROUND refresher throws — stale row must keep emitting", async () => {
		// If the refresher throws mid-refresh, lastRefreshedAt must stay
		// unchanged so the staleness collector re-emits the row on the next
		// poll. Writing on failure would tell operators "it's fresh" when
		// it isn't — trust regression.
		requirePlexClient.mockResolvedValue({ client: {}, instance: {} });
		refreshPlexCache.mockRejectedValue(new Error("upstream Plex timeout"));

		const result = await dispatchPulseAction(fakeApp, "user-1", plexAction, fakeLog);
		expect(result.status).toBe("ok");

		// Background task runs; it should swallow the error (logged) and
		// deliberately NOT call cacheStatusUpsert.
		await result.backgroundTask;

		expect(cacheStatusUpsert).not.toHaveBeenCalled();
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

});

// -----------------------------------------------------------------------------
// queue.retry
// -----------------------------------------------------------------------------

// These tests exercise the dispatcher through a stubbed `prisma.serviceInstance`
// + a stubbed `arrClientFactory` that hands back a queue-bearing client whose
// `queue.delete` we can observe. Mirrors the stubbing pattern used elsewhere in
// this file.

// We need to re-mock client-helpers to make the isSonarrClient guard return
// true for our stub. vi.mock is hoisted to the top of the file, but we can
// inject guards via a partial stub later. Simpler: inject a literal instance
// that satisfies `instanceof SonarrClient` by mocking arr-sdk's class check.
vi.mock("../../arr/client-helpers.js", () => ({
	isSonarrClient: (client: unknown): boolean =>
		typeof client === "object" &&
		client !== null &&
		(client as { __kind?: string }).__kind === "sonarr",
	isRadarrClient: (client: unknown): boolean =>
		typeof client === "object" &&
		client !== null &&
		(client as { __kind?: string }).__kind === "radarr",
	isLidarrClient: () => false,
	isReadarrClient: () => false,
}));

describe("dispatchPulseAction — queue.retry", () => {
	const retryAction: PulseAction = {
		kind: "queue.retry",
		target: {
			instanceId: "inst-sonarr-1",
			queueItemId: "42",
			service: "sonarr",
		},
		label: "Retry",
		destructive: false,
	};

	// Minimal fakeApp override: the global fakeApp doesn't include
	// `arrClientFactory` or `prisma.serviceInstance`. We build a tighter
	// fake per-test to avoid leaking state.
	function buildRetryApp(opts: {
		instance?: { id: string; service: string; enabled: boolean } | null;
		deleteImpl?: (id: number) => Promise<void>;
	}): FastifyInstance {
		const queueDelete = vi.fn(opts.deleteImpl ?? (async () => {}));
		const client = { __kind: "sonarr", queue: { delete: queueDelete } };
		return {
			prisma: {
				serviceInstance: {
					findFirst: vi.fn(async () => opts.instance ?? null),
				},
			},
			arrClientFactory: {
				create: () => client,
			},
			// Not used by queue.retry path but needs to exist since the
			// same app will flow through the top-level dispatcher.
			schedulerRegistry: { markEnabled: () => {} },
		} as unknown as FastifyInstance;
	}

	it("200s and calls queue.delete with retry options when the item exists", async () => {
		const deleteImpl = vi.fn(async () => {});
		const app = buildRetryApp({
			instance: { id: "inst-sonarr-1", service: "SONARR", enabled: true },
			deleteImpl,
		});

		const result = await dispatchPulseAction(app, "user-1", retryAction, fakeLog);

		expect(result).toEqual({ status: "ok" });
		// Exact options match the /dashboard/queue/action retry path — we must
		// not silently drift to a destructive variant (e.g. blocklist: true).
		expect(deleteImpl).toHaveBeenCalledWith(42, {
			removeFromClient: true,
			blocklist: false,
			changeCategory: false,
		});
	});

	it("throws InstanceNotFoundError (404) when the instance is missing or unowned", async () => {
		const app = buildRetryApp({ instance: null });

		await expect(dispatchPulseAction(app, "user-1", retryAction, fakeLog)).rejects.toMatchObject({
			name: "InstanceNotFoundError",
			statusCode: 404,
		});
	});

	it("throws AppValidationError (400) when the envelope's service mismatches the instance", async () => {
		const app = buildRetryApp({
			instance: { id: "inst-sonarr-1", service: "RADARR", enabled: true },
		});

		await expect(dispatchPulseAction(app, "user-1", retryAction, fakeLog)).rejects.toMatchObject({
			name: "AppValidationError",
			statusCode: 400,
		});
	});

	it("throws AppValidationError when queueItemId is not a valid queue id", async () => {
		const app = buildRetryApp({
			instance: { id: "inst-sonarr-1", service: "SONARR", enabled: true },
		});
		const badAction: PulseAction = {
			...retryAction,
			target: { ...retryAction.target, queueItemId: "not-a-number" },
		};

		await expect(dispatchPulseAction(app, "user-1", badAction, fakeLog)).rejects.toMatchObject({
			name: "AppValidationError",
		});
	});
});
