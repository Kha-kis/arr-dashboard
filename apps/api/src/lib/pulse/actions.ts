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

import type { PulseAction, PulseCacheType, SchedulerJobId } from "@arr/shared";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { ConflictError } from "../errors.js";
import { getHuntingScheduler } from "../hunting/scheduler.js";
import { refreshPlexCache } from "../plex/plex-cache-refresher.js";
import { requirePlexClient } from "../plex/plex-helpers.js";
import { getQueueCleanerScheduler } from "../queue-cleaner/scheduler.js";
import { refreshTautulliCache } from "../tautulli/tautulli-cache-refresher.js";
import { requireTautulliClient } from "../tautulli/tautulli-helpers.js";

export interface PulseActionResult {
	status: "ok";
	detail?: string;
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
// Delegates ownership + service-type validation to the existing
// require*Client helpers, which throw InstanceNotFoundError (→ 404) for
// missing/unowned instances and AppValidationError (→ 400) when the
// instance exists but is the wrong service.

async function dispatchCacheRefresh(
	app: FastifyInstance,
	userId: string,
	instanceId: string,
	cacheType: PulseCacheType,
	log: FastifyBaseLogger,
): Promise<PulseActionResult> {
	if (cacheType === "plex") {
		const { client } = await requirePlexClient(app, userId, instanceId);
		const result = await refreshPlexCache(client, app.prisma, instanceId, log);
		await recordCacheRefreshSuccess(app, instanceId, "plex", result, log);
		log.info(
			{ instanceId, cacheType, upserted: result.upserted, errors: result.errors },
			"pulse-action: plex cache refreshed",
		);
		return {
			status: "ok",
			detail: `${result.upserted} item(s) refreshed`,
		};
	}

	// tautulli
	const { client } = await requireTautulliClient(app, userId, instanceId);
	const result = await refreshTautulliCache(client, app.prisma, instanceId, log);
	await recordCacheRefreshSuccess(app, instanceId, "tautulli", result, log);
	log.info(
		{ instanceId, cacheType, upserted: result.upserted, errors: result.errors },
		"pulse-action: tautulli cache refreshed",
	);
	return {
		status: "ok",
		detail: `${result.upserted} item(s) refreshed`,
	};
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
