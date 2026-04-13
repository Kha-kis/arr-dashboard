/**
 * Scheduler initialization helpers.
 *
 * Standardizes the failure-handling contract for scheduler plugins so that
 * an init failure is always visible to operators on `/api/system/jobs`
 * instead of being silently swallowed by Fastify's error path.
 *
 * The full failure-handling policy (init failure / tick error / serial
 * busy / disabled state) is documented in `docs/domains/schedulers.md`.
 */

import type { FastifyBaseLogger } from "fastify";
import { getErrorMessage } from "../utils/error-message.js";
import type { SchedulerRegistry } from "./scheduler-registry.js";

export interface SchedulerInitContext {
	registry: SchedulerRegistry;
	log: FastifyBaseLogger;
}

/**
 * Run a scheduler plugin's `onReady` initialization with the standard
 * failure-handling contract.
 *
 * On success: `initFn` runs to completion and the helper returns `true`.
 * Tick-level state will then be tracked by the plugin's existing
 * `app.schedulerRegistry.track()` calls.
 *
 * On failure: the error is logged at error level with `{ err, jobId }`,
 * the registry is marked `disabled` with a human-readable
 * `disabledReason` (`"Init failed: <message>"`), and the helper returns
 * `false`. The job appears as `state: "disabled"` on `/api/system/jobs`
 * with the reason exposed to operators. The error is NOT re-thrown — a
 * single scheduler's init failure must not crash other schedulers'
 * `onReady` hooks or block server startup.
 *
 * Plugins that need to gate routes on a feature flag (e.g. setting
 * `app.foobarSchedulerEnabled = true` only on success) should branch on
 * the returned boolean rather than placing flag-setting code inside the
 * `initFn` after side-effects that may have partially completed.
 *
 * @param ctx - Registry + logger (typically `{ registry: app.schedulerRegistry, log: app.log }`)
 * @param jobId - The `JOB_ID.*` constant for the scheduler being initialized
 * @param label - Human-readable scheduler name used in the log message (e.g. `"backup"`)
 * @param initFn - Async initialization body — creates instances, registers decorations, calls `start()`
 * @returns `true` if init succeeded, `false` if it failed and the job was disabled
 */
export async function runSchedulerInit(
	ctx: SchedulerInitContext,
	jobId: string,
	label: string,
	initFn: () => Promise<void>,
): Promise<boolean> {
	try {
		await initFn();
		return true;
	} catch (error) {
		const reason = `Init failed: ${getErrorMessage(error, "unknown error")}`;
		ctx.log.error(
			{ err: error, jobId },
			`Failed to initialize ${label} scheduler — feature disabled`,
		);
		ctx.registry.markDisabled(jobId, reason);
		return false;
	}
}
