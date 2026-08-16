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
import { LIBRARY_SERVICES_UPPER } from "@arr/shared";
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
import {
	createOwnedJellyfinPublicationSnapshot,
	refreshJellyfinCache,
} from "../jellyfin/jellyfin-cache-refresher.js";
import { runJellyfinCacheRefreshSingleFlight } from "../jellyfin/jellyfin-cache-singleflight.js";
import { requireJellyfinClient } from "../jellyfin/jellyfin-helpers.js";
import { getLibrarySyncScheduler } from "../library-sync/index.js";
import {
	createOwnedPlexPublicationSnapshot,
	refreshPlexCache,
} from "../plex/plex-cache-refresher.js";
import { requirePlexClient } from "../plex/plex-helpers.js";
import { getQueueCleanerScheduler } from "../queue-cleaner/scheduler.js";
import { recordWatchProviderCacheRefreshFailure } from "../services/provider-cache-status.js";
import type { OwnedProviderPublicationSnapshot } from "../services/provider-identity-guard.js";
import {
	createOwnedTautulliPublicationSnapshot,
	refreshTautulliCache,
} from "../tautulli/tautulli-cache-refresher.js";
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
	 * Only populated by cache.refresh and library.sync today;
	 * scheduler.enable and queue.retry complete synchronously within
	 * the request.
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
		case "library.sync":
			return dispatchLibrarySync(app, userId, action.target.instanceId, log);
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
//   1. Media-server refreshes can run 30-60+ seconds on large libraries.
//   2. Next.js dev-server's proxy (and most reverse proxies) time out
//      around 30s, returning a misleading 500 to the client even though
//      the backend work is succeeding.
//   3. The user-visible contract is already eventually-consistent:
//      "row drops on next poll" depends on the refresher atomically
//      publishing a complete cache generation — no need to block the HTTP
//      response on that.
//
// Full refreshers atomically publish success themselves. Plex failures are
// recorded as guarded attempts here; Jellyfin's single-flight owner records
// its own failure attempts. Either way, failure never advances the last
// successful generation (trust invariant: failure → row stays).
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
		const { instance } = await requirePlexClient(app, userId, instanceId);
		const publicationInstance = createOwnedPlexPublicationSnapshot(app.encryptor, instance);
		const backgroundTask = runBackgroundCacheRefresh({
			app,
			log,
			instanceId,
			cacheType: "plex",
			refresh: () => refreshPlexCache({ prisma: app.prisma, instance: publicationInstance, log }),
			publicationAuthority: publicationInstance,
		});
		log.info({ instanceId, cacheType }, "pulse-action: plex cache refresh dispatched");
		return { status: "ok", backgroundTask };
	}

	if (cacheType === "jellyfin") {
		const { instance } = await requireJellyfinClient(app, userId, instanceId);
		const publicationInstance = createOwnedJellyfinPublicationSnapshot(app.encryptor, instance);
		const backgroundTask = runBackgroundCacheRefresh({
			app,
			log,
			instanceId,
			cacheType,
			refresh: () =>
				runJellyfinCacheRefreshSingleFlight(
					publicationInstance,
					() =>
						refreshJellyfinCache({
							prisma: app.prisma,
							instance: publicationInstance,
							log,
						}),
					{ prisma: app.prisma, log },
				),
			failureRecordedByRefresh: true,
			publicationAuthority: publicationInstance,
		});
		log.info({ instanceId, cacheType }, "pulse-action: Jellyfin cache refresh dispatched");
		return { status: "ok", backgroundTask };
	}

	// tautulli
	const { instance } = await requireTautulliClient(app, userId, instanceId);
	const publicationInstance = createOwnedTautulliPublicationSnapshot(app.encryptor, instance);
	const backgroundTask = runBackgroundCacheRefresh({
		app,
		log,
		instanceId,
		cacheType: "tautulli",
		refresh: () => refreshTautulliCache({ prisma: app.prisma, instance: publicationInstance, log }),
		publicationAuthority: publicationInstance,
	});
	log.info({ instanceId, cacheType }, "pulse-action: tautulli cache refresh dispatched");
	return { status: "ok", backgroundTask };
}

function runBackgroundCacheRefresh(opts: {
	app: FastifyInstance;
	log: FastifyBaseLogger;
	instanceId: string;
	cacheType: PulseCacheType;
	refresh: () => Promise<CacheRefreshResult>;
	failureRecordedByRefresh?: boolean;
	publicationAuthority?: OwnedProviderPublicationSnapshot;
}): Promise<void> {
	const {
		log,
		instanceId,
		cacheType,
		refresh,
		failureRecordedByRefresh = false,
		publicationAuthority,
	} = opts;
	return (async () => {
		try {
			const result = await refresh();
			if (
				(!result.complete || !result.completedAt) &&
				!result.superseded &&
				!failureRecordedByRefresh &&
				publicationAuthority
			) {
				await recordBackgroundCacheRefreshFailure(
					opts,
					result.errorMessages?.slice(0, 3).join("; ").slice(0, 200) ||
						`${cacheType} refresh did not publish a complete generation`,
				);
			}
			log.info(
				{ instanceId, cacheType, upserted: result.upserted, errors: result.errors },
				"pulse-action: cache refresh completed (background)",
			);
		} catch (err) {
			if (!failureRecordedByRefresh && publicationAuthority) {
				await recordBackgroundCacheRefreshFailure(
					opts,
					err instanceof Error ? err.message : String(err),
				);
			}
			log.error({ err, instanceId, cacheType }, "pulse-action: cache refresh failed (background)");
		}
	})();
}

async function recordBackgroundCacheRefreshFailure(
	opts: {
		app: FastifyInstance;
		log: FastifyBaseLogger;
		instanceId: string;
		cacheType: PulseCacheType;
		publicationAuthority?: OwnedProviderPublicationSnapshot;
	},
	message: string,
): Promise<void> {
	if (opts.publicationAuthority) {
		await recordWatchProviderCacheRefreshFailure(
			opts.app.prisma,
			opts.cacheType,
			message,
			opts.publicationAuthority,
			opts.log,
		);
	}
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
// library.sync
// ---------------------------------------------------------------------------
//
// Trigger a manual library cache sync for one *arr instance. Mirrors the
// existing `POST /library/sync/:instanceId` route — ownership + enabled
// check, library-service check, 409 if the scheduler is down or a sync is
// already running, then fire-and-forget `scheduler.triggerSync()`. Like
// cache.refresh, we
// return 200 when the sync is *accepted*, not completed: large libraries
// sync for minutes and the Pulse contract is already eventually-consistent
// (the `library-sync-*` row drops on a later poll once the sync succeeds
// and clears `lastError` / bumps `lastFullSync`).
//
// A failed background sync writes `lastError` via the sync executor, so
// the signal honestly re-emits — no extra write-through is needed here.

async function dispatchLibrarySync(
	app: FastifyInstance,
	userId: string,
	instanceId: string,
	log: FastifyBaseLogger,
): Promise<PulseActionResult> {
	const instance = await requireEnabledInstance(app, userId, instanceId);

	if (!(LIBRARY_SERVICES_UPPER as readonly string[]).includes(instance.service)) {
		throw new AppValidationError(
			`Instance is not a library service (got ${instance.service}) — only Sonarr, Radarr, Lidarr, and Readarr libraries can be synced`,
		);
	}

	const scheduler = getLibrarySyncScheduler();

	// Degraded-boot guard. The library-sync scheduler is started inside an
	// onReady hook wrapped in runSchedulerInit, which by policy CATCHES init
	// failures and lets the server keep serving. In that state `start()` was
	// never called, so `triggerSync()` would short-circuit on its `!this.app`
	// branch and return null — and our fire-and-forget `.then()` below would
	// treat that "nothing ran" as success, returning 200 + a "Library sync
	// started" toast while no sync happened (the silent no-op the trust model
	// forbids). `isRunning()` is the precise signal: `start()` sets `app` and
	// `running` together, so a not-running scheduler is exactly the case
	// triggerSync can't honor. Surface it as a real error instead.
	if (!scheduler.isRunning()) {
		throw new ConflictError(
			"Library sync scheduler is not running — sync cannot be triggered right now",
		);
	}

	if (scheduler.isInstanceSyncing(instanceId)) {
		throw new ConflictError("Library sync is already in progress for this instance");
	}

	// Fire-and-forget, mirroring the manual-sync route. With the not-running
	// and already-syncing cases pre-checked above (and the service check
	// earlier), the only remaining `null` returns from `triggerSync` are
	// benign races — the instance was deleted, or another sync started,
	// between our checks and the call. Those are safe to lose quietly: the
	// operator can retry and the next poll reflects reality.
	const backgroundTask = scheduler
		.triggerSync(instanceId)
		.then(() => undefined)
		.catch((err: unknown) => {
			// The executor records lastError itself; this catch only guards the
			// trigger plumbing so an unhandled rejection can't crash the process.
			log.error({ err, instanceId }, "pulse-action: library sync failed (background)");
		});

	log.info({ instanceId }, "pulse-action: library sync dispatched");
	return { status: "ok", backgroundTask };
}

interface CacheRefreshResult {
	upserted: number;
	errors: number;
	errorMessages?: readonly string[];
	complete: boolean;
	completedAt?: Date;
	superseded?: boolean;
}
