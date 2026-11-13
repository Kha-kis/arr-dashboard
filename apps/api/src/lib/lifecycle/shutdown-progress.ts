import type { RestoreRuntimeShutdownStatus } from "../backup/restore-runtime-admission.js";
import { JOB_ID } from "../scheduler-registry/job-definitions.js";
import type { JobStatus } from "../scheduler-registry/scheduler-registry.js";

type ShutdownJobKind = (typeof JOB_ID)[keyof typeof JOB_ID] | "other";
type ShutdownSchedulerStatus = Readonly<{
	runningSchedulers: number;
	runningSchedulerKinds: ReadonlyArray<{ kind: ShutdownJobKind; count: number }>;
}>;
const publicJobKinds = new Set<string>(Object.values(JOB_ID));

/** Counts registered jobs, not concurrent runs. Never forward registry metadata. */
export function getShutdownSchedulerStatus(
	jobs: readonly Pick<JobStatus, "id" | "state">[],
): ShutdownSchedulerStatus {
	let runningSchedulers = 0;
	const counts = new Map<ShutdownJobKind, number>();
	for (const job of jobs) {
		if (job.state !== "running") continue;
		runningSchedulers++;
		const kind = publicJobKinds.has(job.id) ? (job.id as ShutdownJobKind) : "other";
		counts.set(kind, (counts.get(kind) ?? 0) + 1);
	}
	return {
		runningSchedulers,
		runningSchedulerKinds: [...counts]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([kind, count]) => ({ kind, count })),
	};
}

export type ShutdownPhase = "initialization" | "fastify" | "runtime" | "complete" | "failed";
export type ShutdownProgressStatus = Readonly<{
	phase: ShutdownPhase;
	failedPhase?: "initialization" | "fastify" | "runtime";
	runtime?: RestoreRuntimeShutdownStatus;
	admissionClosed?: boolean;
	pendingHandlers?: number;
	runningSchedulers?: number;
	runningSchedulerKinds?: ShutdownSchedulerStatus["runningSchedulerKinds"];
}>;

/** Diagnostic-only timer: neither logging nor observation can settle a drain. */
export function startShutdownProgress(options: {
	read(): ShutdownProgressStatus;
	report(payload: ShutdownProgressStatus & { elapsedMs: number }): void;
}): { report(): void; stop(): void } {
	const started = performance.now();
	let stopped = false;
	const report = () => {
		if (stopped) return;
		try {
			options.report({ ...options.read(), elapsedMs: Math.max(0, performance.now() - started) });
		} catch {
			// Diagnostics must never reject or shorten the authoritative shutdown.
		}
	};
	report();
	const timer = setInterval(report, 5000);
	timer.unref();
	return {
		report,
		stop: () => {
			if (stopped) return;
			stopped = true;
			clearInterval(timer);
		},
	};
}
