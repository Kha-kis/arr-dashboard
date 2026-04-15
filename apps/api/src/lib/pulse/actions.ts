/**
 * Pulse Action Dispatcher
 *
 * Maps a validated {@link PulseAction} envelope (parsed from the
 * `POST /pulse/:id/action` request body) to the existing service call
 * that actually effects the change — no new backend capability is
 * introduced here.
 *
 * Error contract:
 * - `InstanceNotFoundError` (404) — target instance missing or not owned by user
 * - `AppValidationError` (400)    — target instance exists but is the wrong service type
 * - `ConflictError` (409)         — action is already satisfied (scheduler already running)
 *
 * All three error classes map to their status codes via the centralized
 * error handler in `server.ts`, so the route handler just re-throws.
 */

import type { PulseAction, PulseCacheType, QueueRetryService, SchedulerJobId } from "@arr/shared";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import {
	isLidarrClient,
	isRadarrClient,
	isReadarrClient,
	isSonarrClient,
} from "../arr/client-helpers.js";
import { requireEnabledInstance } from "../arr/instance-helpers.js";
import { parseQueueId } from "../dashboard/queue-utils.js";
import { AppValidationError, ConflictError } from "../errors.js";
import { getHuntingScheduler } from "../hunting/scheduler.js";
import { refreshPlexCache } from "../plex/plex-cache-refresher.js";
import { requirePlexClient } from "../plex/plex-helpers.js";
import { getQueueCleanerScheduler } from "../queue-cleaner/scheduler.js";
import { refreshTautulliCache } from "../tautulli/tautulli-cache-refresher.js";
import { requireTautulliClient } from "../tautulli/tautulli-helpers.js";

export interface PulseActionResult {
	status: "ok";
	detail?: string;
	/**
	 * Optional promise resolving when any fire-and-forget background task
	 * kicked off by the dispatcher completes. The HTTP route handler
	 * **ignores** this — it returns 200 as soon as the dispatcher returns.
	 * Tests await it to verify post-refresh state without polling.
	 *
	 * Only populated by cache.refresh today; scheduler.enable and
	 * queue.retry complete synchronously within the request.
	 */
	backgroundTask?: Promise<void>;
}

/**
 * Dispatch a Pulse action to the corresponding service call.
 *
 * Callers must pre-validate `action` against `pulseActionSchema` from
 * `@arr/shared` — the `switch` below relies on the discriminated union
 * narrowing, not runtime validation.
 */
export async function dispatchPulseAction(
	app: FastifyInstance,
	userId: string,
	action: PulseAction,
	log: FastifyBaseLogger,
): Promise<PulseActionResult> {
	switch (action.kind) {
		case "scheduler.enable":
			return dispatchSchedulerEnable(app, action.target.jobId, log);
		case "cache.refresh":
			return dispatchCacheRefresh(
				app,
				userId,
				action.target.instanceId,
				action.target.cacheType,
				log,
			);
		case "queue.retry":
			return dispatchQueueRetry(
				app,
				userId,
				action.target.instanceId,
				action.target.queueItemId,
				action.target.service,
				log,
			);
	}
}

// ---------------------------------------------------------------------------
// scheduler.enable
// ---------------------------------------------------------------------------
//
// Single-admin architecture — the scheduler is global, not per-user, so no
// ownership check. Matches the existing `/hunting/scheduler/toggle` and
// `/queue-cleaner/scheduler/toggle` endpoints' authorization model.

async function dispatchSchedulerEnable(
	app: FastifyInstance,
	jobId: SchedulerJobId,
	log: FastifyBaseLogger,
): Promise<PulseActionResult> {
	const scheduler = jobId === "hunting" ? getHuntingScheduler() : getQueueCleanerScheduler();

	if (scheduler.isRunning()) {
		throw new ConflictError(`Scheduler "${jobId}" is already running`);
	}

	scheduler.start(app);

	// Write through to the source-of-truth collectSchedulerHealth reads from.
	// The scheduler class's `start()` flips its own `running` flag but does
	// not touch the registry — so without this call the collector would keep
	// emitting scheduler-disabled-<jobId> on the next poll and a second click
	// would 409 against a registry still marked disabled. The scheduler row
	// on the Pulse surface would never drop, which breaks the whole
	// "click action → issue resolves → row disappears" promise.
	app.schedulerRegistry.markEnabled(jobId);

	log.info({ jobId }, "pulse-action: scheduler enabled");
	return { status: "ok" };
}

// ---------------------------------------------------------------------------
// cache.refresh
// ---------------------------------------------------------------------------
//
// **Fire-and-forget semantics.** Ownership validation is synchronous (the
// require*Client helpers throw InstanceNotFoundError → 404 for
// missing/unowned instances and AppValidationError → 400 for wrong
// service type), but the actual refresh runs in the background. We return
// 200 as soon as the refresh is *accepted* — not when it completes —
// because:
//
//   1. Plex/Tautulli refreshes can run 30-60+ seconds on large libraries
//      (observed: 1082 Tautulli history items = ~43s).
//   2. Next.js dev-server's proxy (and most reverse proxies) time out
//      around 30s, returning a misleading 500 to the client even though
//      the backend work is succeeding.
//   3. The user-visible contract is already eventually-consistent:
//      "row drops on next poll" depends on recordCacheRefreshSuccess
//      bumping lastRefreshedAt, which happens when the background task
//      resolves — no need to block the HTTP response on that.
//
// Errors during background refresh are logged but **do not** write
// through to CacheRefreshStatus, so the stale row correctly re-emits
// on the next poll (trust invariant: failure → row stays).
//
// The optional `backgroundTask` on the return is unused by the route
// handler (fire-and-forget) but awaited by tests that want to verify
// post-refresh state without polling.

async function dispatchCacheRefresh(
	app: FastifyInstance,
	userId: string,
	instanceId: string,
	cacheType: PulseCacheType,
	log: FastifyBaseLogger,
): Promise<PulseActionResult> {
	if (cacheType === "plex") {
		const { client } = await requirePlexClient(app, userId, instanceId);
		const backgroundTask = runBackgroundCacheRefresh({
			app,
			log,
			instanceId,
			cacheType: "plex",
			refresh: () => refreshPlexCache(client, app.prisma, instanceId, log),
		});
		log.info({ instanceId, cacheType }, "pulse-action: plex cache refresh dispatched");
		return { status: "ok", backgroundTask };
	}

	// tautulli
	const { client } = await requireTautulliClient(app, userId, instanceId);
	const backgroundTask = runBackgroundCacheRefresh({
		app,
		log,
		instanceId,
		cacheType: "tautulli",
		refresh: () => refreshTautulliCache(client, app.prisma, instanceId, log),
	});
	log.info({ instanceId, cacheType }, "pulse-action: tautulli cache refresh dispatched");
	return { status: "ok", backgroundTask };
}

function runBackgroundCacheRefresh(opts: {
	app: FastifyInstance;
	log: FastifyBaseLogger;
	instanceId: string;
	cacheType: "plex" | "tautulli";
	refresh: () => Promise<CacheRefreshResult>;
}): Promise<void> {
	const { app, log, instanceId, cacheType, refresh } = opts;
	return (async () => {
		try {
			const result = await refresh();
			await recordCacheRefreshSuccess(app, instanceId, cacheType, result, log);
			log.info(
				{ instanceId, cacheType, upserted: result.upserted, errors: result.errors },
				"pulse-action: cache refresh completed (background)",
			);
		} catch (err) {
			// Do NOT write through on failure — the stale row must keep
			// emitting so the operator sees the problem persists. The
			// caller has already received 200; this error is logged only.
			log.error({ err, instanceId, cacheType }, "pulse-action: cache refresh failed (background)");
		}
	})();
}

// ---------------------------------------------------------------------------
// queue.retry
// ---------------------------------------------------------------------------
//
// Retry a single failed/stuck ARR queue item. Reuses the exact SDK call
// the /dashboard/queue/action route uses: `client.queue.delete(id, {
// removeFromClient: true, blocklist: false, changeCategory: false })`.
// That semantics = "take the item out of the download client queue
// without blocklisting the release; the ARR app will search for it
// again on its next tick." Idempotent at the ARR layer — a retry of an
// already-retried item either succeeds or 404s on the SDK side, both
// of which surface honestly to the operator.
//
// No local DB writeback: queue state is not persisted here. The next
// GET /pulse poll re-fetches from the ARR queue and the retried item
// has already been removed from the queue listing — so the Pulse row
// drops naturally.

async function dispatchQueueRetry(
	app: FastifyInstance,
	userId: string,
	instanceId: string,
	queueItemId: string,
	service: QueueRetryService,
	log: FastifyBaseLogger,
): Promise<PulseActionResult> {
	// Ownership + enabled check — mirrors requirePlexClient/requireTautulliClient
	// semantics (InstanceNotFoundError → 404 for both missing and unowned).
	const instance = await requireEnabledInstance(app, userId, instanceId);

	if (instance.service.toLowerCase() !== service) {
		throw new AppValidationError(`Instance is not a ${service} service (got ${instance.service})`);
	}

	const queueId = parseQueueId(queueItemId);
	if (queueId === null) {
		throw new AppValidationError("Invalid queue item id");
	}

	const client = app.arrClientFactory.create(instance);
	const deleteOptions = {
		removeFromClient: true,
		blocklist: false,
		changeCategory: false,
	};

	if (isSonarrClient(client)) {
		await client.queue.delete(queueId, deleteOptions);
	} else if (isRadarrClient(client)) {
		await client.queue.delete(queueId, deleteOptions);
	} else if (isLidarrClient(client)) {
		await client.queue.delete(queueId, deleteOptions);
	} else if (isReadarrClient(client)) {
		await client.queue.delete(queueId, deleteOptions);
	} else {
		// Service enum and instance.service drifted apart. Surface it honestly
		// rather than silently no-opping the retry.
		throw new AppValidationError(`No queue retry path for service ${instance.service}`);
	}

	log.info(
		{ action: "queue.retry", instanceId, queueItemId: queueId, service },
		"pulse-action: queue item retried",
	);
	return { status: "ok" };
}

// ---------------------------------------------------------------------------
// CacheRefreshStatus write-through
// ---------------------------------------------------------------------------
//
// Bumps the `lastRefreshedAt` timestamp (and result metadata) on the
// `CacheRefreshStatus` row the collector reads from. Without this, a
// successful dispatcher run would leave the row stale on the next GET
// /pulse poll — the collector determines staleness from this table, not
// from the refresher's return value.
//
// Mirrors the upsert already performed by the inline manual-refresh
// route at apps/api/src/routes/plex/cache-routes.ts so the two paths
// behave identically for operators. The status upsert is best-effort
// (`.catch(...)`): a failure here must not fail the action itself, since
// the refresh already succeeded.

interface CacheRefreshResult {
	upserted: number;
	errors: number;
	errorMessages?: readonly string[];
}

async function recordCacheRefreshSuccess(
	app: FastifyInstance,
	instanceId: string,
	cacheType: "plex" | "tautulli",
	result: CacheRefreshResult,
	log: FastifyBaseLogger,
): Promise<void> {
	const now = new Date();
	const errorMessages = result.errorMessages ?? [];
	const lastErrorMessage =
		errorMessages.length > 0 ? errorMessages.slice(0, 3).join("; ").slice(0, 200) : null;
	const lastResult = result.errors > 0 ? "error" : "success";

	await app.prisma.cacheRefreshStatus
		.upsert({
			where: { instanceId_cacheType: { instanceId, cacheType } },
			create: {
				instanceId,
				cacheType,
				lastRefreshedAt: now,
				lastResult,
				lastErrorMessage,
				itemCount: result.upserted,
			},
			update: {
				lastRefreshedAt: now,
				lastResult,
				lastErrorMessage,
				itemCount: result.upserted,
			},
		})
		.catch((err: unknown) => {
			log.warn(
				{ err, instanceId, cacheType },
				"pulse-action: cache refreshed but failed to record status",
			);
		});
}
