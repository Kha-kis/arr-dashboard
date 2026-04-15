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
	const scheduler = jobId === "hunt" ? getHuntingScheduler() : getQueueCleanerScheduler();

	if (scheduler.isRunning()) {
		throw new ConflictError(`Scheduler "${jobId}" is already running`);
	}

	scheduler.start(app);
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
	log.info(
		{ instanceId, cacheType, upserted: result.upserted, errors: result.errors },
		"pulse-action: tautulli cache refreshed",
	);
	return {
		status: "ok",
		detail: `${result.upserted} item(s) refreshed`,
	};
}
