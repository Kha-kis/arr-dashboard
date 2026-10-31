import { performance } from "node:perf_hooks";
import pino, { type Logger } from "pino";

type SqliteStartupPhase =
	| "catalog-preflight"
	| "date-plan"
	| "oidc-migration"
	| "schema-apply"
	| "catalog-postflight"
	| "date-apply"
	| "foreign-key-check"
	| "commit"
	| "total";

let diagnosticLogger: Pick<Logger, "info"> | undefined;

function report(phase: SqliteStartupPhase, began: number, outcome: "completed" | "failed") {
	try {
		// Pre-launch stdout is a settings protocol. No app logger/file/worker
		// initialization is safe here; emit only bounded diagnostics on stderr.
		diagnosticLogger ??= pino(
			{ base: null, timestamp: false },
			pino.destination({ dest: 2, sync: true }),
		);
		diagnosticLogger.info({
			category: "sqlite-startup-phase",
			phase,
			outcome,
			elapsedMs: Math.round(Math.max(0, performance.now() - began) * 1000) / 1000,
		});
	} catch {
		// Diagnostics never replace the original startup result or failure.
	}
}

/** A phase completion is diagnostic only, never readiness or commit authority. */
export function timeSqliteStartupPhase<T>(phase: SqliteStartupPhase, operation: () => T): T {
	const began = performance.now();
	let outcome: "completed" | "failed" = "failed";
	try {
		const result = operation();
		outcome = "completed";
		return result;
	} finally {
		report(phase, began, outcome);
	}
}

/** Await actual settlement, including native writer closure for the total. */
export async function timeSqliteStartupPhaseAsync<T>(
	phase: SqliteStartupPhase,
	operation: () => Promise<T>,
): Promise<T> {
	const began = performance.now();
	let outcome: "completed" | "failed" = "failed";
	try {
		const result = await operation();
		outcome = "completed";
		return result;
	} finally {
		report(phase, began, outcome);
	}
}
