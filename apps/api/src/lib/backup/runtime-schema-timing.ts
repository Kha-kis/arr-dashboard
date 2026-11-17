import { performance } from "node:perf_hooks";
import pino, { type Logger } from "pino";

type SqliteStartupPhase =
	| "catalog-preflight"
	| "schema-plan"
	| "date-plan"
	| "oidc-migration"
	| "schema-apply"
	| "catalog-postflight"
	| "date-apply"
	| "foreign-key-check"
	| "commit"
	| "total";

let diagnosticLogger: Pick<Logger, "info"> | undefined;

function report(
	phase: SqliteStartupPhase,
	outcome: "started" | "completed" | "failed",
	began?: number,
) {
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
			elapsedMs:
				began === undefined ? 0 : Math.round(Math.max(0, performance.now() - began) * 1000) / 1000,
		});
	} catch {
		// Diagnostics never replace the original startup result or failure.
	}
}

/** Phase events describe diagnostics only. */
export function timeSqliteStartupPhase<T>(phase: SqliteStartupPhase, operation: () => T): T {
	// Native validation can still be running when the supervisor times out.
	if (phase === "schema-plan" || phase === "date-plan" || phase === "foreign-key-check")
		report(phase, "started");
	const began = performance.now();
	let outcome: "completed" | "failed" = "failed";
	try {
		const result = operation();
		outcome = "completed";
		return result;
	} finally {
		report(phase, outcome, began);
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
		report(phase, outcome, began);
	}
}
