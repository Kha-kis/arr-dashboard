import type { RestoreRuntimeShutdownStatus } from "../backup/restore-runtime-admission.js";

export type ShutdownPhase = "initialization" | "fastify" | "runtime" | "complete" | "failed";
export type ShutdownProgressStatus = Readonly<{
	phase: ShutdownPhase;
	failedPhase?: "initialization" | "fastify" | "runtime";
	runtime?: RestoreRuntimeShutdownStatus;
	admissionClosed?: boolean;
	pendingHandlers?: number;
	runningSchedulers?: number;
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
