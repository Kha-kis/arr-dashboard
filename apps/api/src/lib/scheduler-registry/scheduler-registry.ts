/**
 * SchedulerRegistry — a minimal, in-memory catalog + runtime-state tracker
 * for the background schedulers this API runs.
 *
 * Design intent:
 *  - Observability only. The registry does NOT own scheduling, locking, or
 *    persistence. Each scheduler plugin continues to own its own timer.
 *  - Incremental adoption. A scheduler can register a job up-front and
 *    instrument execution later; the read-only status surface degrades
 *    gracefully if a job has never run.
 *  - Process-local. State lives in memory and is rebuilt on restart. A
 *    future iteration may persist runs if we need historical trends.
 *
 * See docs/adr/0001-scheduler-registry.md for the full rationale.
 */

/**
 * Optional wrapper that delegate scheduler classes accept so callers can
 * route each tick through the SchedulerRegistry for /api/system/jobs
 * observability. Default implementation is a passthrough, so a class
 * constructed without a registry-aware plugin remains fully decoupled.
 *
 * Plugins typically wire it as:
 *   trackTick: (fn) => app.schedulerRegistry.track(JOB_ID.x, fn)
 */
export type TickWrapper = <T>(fn: () => Promise<T>) => Promise<T>;

/** Default passthrough used when a class is constructed without a wrapper. */
export const passthroughTickWrapper: TickWrapper = (fn) => fn();

export type JobConcurrency =
	/** At most one tick in flight at a time (single-process singleton). */
	| "singleton"
	/** Ticks are serialized per ARR instance — different instances can run concurrently. */
	| "per-instance"
	/** Ticks run to completion before the next fires; registry enforces via `track`. */
	| "serial"
	/** Ticks may overlap; registry records the latest stats without gating. */
	| "parallel";

export type JobState = "idle" | "running" | "disabled";

export interface JobDefinition {
	/** Stable identifier — used in API responses, URLs, logs. */
	id: string;
	/** Short, human-readable label for operator UIs. */
	label: string;
	/** One-line description of what the job does. */
	description: string;
	/** Declared concurrency model — informational and, for `serial`, enforced by `track`. */
	concurrency: JobConcurrency;
	/** Expected cadence between ticks, in ms. Omit for event-driven jobs. */
	intervalMs?: number;
}

export interface JobStatus extends JobDefinition {
	state: JobState;
	lastStartedAt: string | null;
	lastFinishedAt: string | null;
	lastSuccessAt: string | null;
	lastFailureAt: string | null;
	lastDurationMs: number | null;
	lastError: string | null;
	consecutiveFailures: number;
	totalRuns: number;
	totalFailures: number;
	/** True when the plugin has disabled the job (e.g. feature flag off). */
	disabled: boolean;
	/** Optional reason captured when the plugin set `disabled=true`. */
	disabledReason: string | null;
}

interface JobRecord {
	definition: JobDefinition;
	state: JobState;
	lastStartedAt: Date | null;
	lastFinishedAt: Date | null;
	lastSuccessAt: Date | null;
	lastFailureAt: Date | null;
	lastDurationMs: number | null;
	lastError: string | null;
	consecutiveFailures: number;
	totalRuns: number;
	totalFailures: number;
	disabled: boolean;
	disabledReason: string | null;
}

export interface Clock {
	now(): Date;
}

const systemClock: Clock = {
	now: () => new Date(),
};

export interface TrackOptions {
	/**
	 * Override the concurrency check for this tick. Defaults to the job's
	 * declared concurrency. `serial` throws if a run is already in flight;
	 * all other values allow the run to proceed.
	 */
	concurrency?: JobConcurrency;
}

export class SerialJobBusyError extends Error {
	readonly statusCode = 409;

	constructor(jobId: string) {
		super(`Job ${jobId} is already running (concurrency=serial)`);
		this.name = "SerialJobBusyError";
	}
}

export class UnknownJobError extends Error {
	readonly statusCode = 404;

	constructor(jobId: string) {
		super(`Job ${jobId} is not registered`);
		this.name = "UnknownJobError";
	}
}

export class SchedulerRegistry {
	private readonly jobs = new Map<string, JobRecord>();

	constructor(private readonly clock: Clock = systemClock) {}

	/**
	 * Register a job's metadata. Safe to call multiple times with the same id —
	 * the latest definition wins. Preserves any runtime stats captured so far.
	 */
	register(definition: JobDefinition): void {
		const existing = this.jobs.get(definition.id);
		if (existing) {
			existing.definition = definition;
			return;
		}
		this.jobs.set(definition.id, {
			definition,
			state: "idle",
			lastStartedAt: null,
			lastFinishedAt: null,
			lastSuccessAt: null,
			lastFailureAt: null,
			lastDurationMs: null,
			lastError: null,
			consecutiveFailures: 0,
			totalRuns: 0,
			totalFailures: 0,
			disabled: false,
			disabledReason: null,
		});
	}

	/** Mark a job disabled (e.g. feature flag off or init failed). */
	markDisabled(jobId: string, reason: string): void {
		const record = this.mustGet(jobId);
		record.disabled = true;
		record.disabledReason = reason;
		record.state = "disabled";
	}

	/** Clear the disabled flag and return the job to idle. */
	markEnabled(jobId: string): void {
		const record = this.mustGet(jobId);
		record.disabled = false;
		record.disabledReason = null;
		if (record.state === "disabled") {
			record.state = "idle";
		}
	}

	/**
	 * Wrap an async tick with timing, state, and failure tracking.
	 *
	 * Returns the awaited result of `fn`. Re-throws the underlying error so
	 * callers retain existing error-handling semantics; the registry only
	 * observes, it does not swallow.
	 */
	async track<T>(jobId: string, fn: () => Promise<T>, options: TrackOptions = {}): Promise<T> {
		const record = this.mustGet(jobId);
		const concurrency = options.concurrency ?? record.definition.concurrency;

		if (concurrency === "serial" && record.state === "running") {
			throw new SerialJobBusyError(jobId);
		}

		const startedAt = this.clock.now();
		record.lastStartedAt = startedAt;
		record.state = "running";

		try {
			const result = await fn();
			const finishedAt = this.clock.now();
			record.lastFinishedAt = finishedAt;
			record.lastSuccessAt = finishedAt;
			record.lastDurationMs = finishedAt.getTime() - startedAt.getTime();
			record.lastError = null;
			record.consecutiveFailures = 0;
			record.totalRuns += 1;
			if (record.state === "running") {
				record.state = record.disabled ? "disabled" : "idle";
			}
			return result;
		} catch (error) {
			const finishedAt = this.clock.now();
			record.lastFinishedAt = finishedAt;
			record.lastFailureAt = finishedAt;
			record.lastDurationMs = finishedAt.getTime() - startedAt.getTime();
			record.lastError = error instanceof Error ? error.message : String(error);
			record.consecutiveFailures += 1;
			record.totalRuns += 1;
			record.totalFailures += 1;
			if (record.state === "running") {
				record.state = record.disabled ? "disabled" : "idle";
			}
			throw error;
		}
	}

	/** Snapshot of a single job's status, or `null` if unregistered. */
	getStatus(jobId: string): JobStatus | null {
		const record = this.jobs.get(jobId);
		return record ? toStatus(record) : null;
	}

	/** All registered jobs, stable-sorted by id. */
	list(): JobStatus[] {
		return [...this.jobs.values()].map(toStatus).sort((a, b) => a.id.localeCompare(b.id));
	}

	/** Test helper — reset all state. Not used in production code paths. */
	reset(): void {
		this.jobs.clear();
	}

	private mustGet(jobId: string): JobRecord {
		const record = this.jobs.get(jobId);
		if (!record) {
			throw new UnknownJobError(jobId);
		}
		return record;
	}
}

function toStatus(record: JobRecord): JobStatus {
	return {
		...record.definition,
		state: record.state,
		lastStartedAt: record.lastStartedAt?.toISOString() ?? null,
		lastFinishedAt: record.lastFinishedAt?.toISOString() ?? null,
		lastSuccessAt: record.lastSuccessAt?.toISOString() ?? null,
		lastFailureAt: record.lastFailureAt?.toISOString() ?? null,
		lastDurationMs: record.lastDurationMs,
		lastError: record.lastError,
		consecutiveFailures: record.consecutiveFailures,
		totalRuns: record.totalRuns,
		totalFailures: record.totalFailures,
		disabled: record.disabled,
		disabledReason: record.disabledReason,
	};
}
