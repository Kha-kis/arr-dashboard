import type { QuiTrackerHealth } from "@arr/shared";

/**
 * qBittorrent tracker.status enum values (from qBit's WebAPI v2 docs):
 *   0 = Tracker is disabled (used for DHT/PEX/LSD entries)
 *   1 = Tracker has not been contacted yet
 *   2 = Tracker has been contacted and is working
 *   3 = Tracker is updating
 *   4 = Tracker has been contacted, but it is not working (or doesn't send proper replies)
 */
const TRACKER_HEALTH: Record<number, QuiTrackerHealth> = {
	0: "disabled",
	1: "not_contacted",
	2: "working",
	3: "updating",
	4: "not_working",
};

/**
 * Per-process record of unrecognized qBit status ints we've already
 * logged. Stops the warning from flooding logs (this mapper runs once
 * per tracker per torrent fetch — repeating the warn for every call
 * would be noisy). One log per status int per process is enough to spot
 * upstream drift; restart the container to re-arm the warning.
 */
const LOGGED_UNKNOWN_STATUSES = new Set<number>();

/** Map qBit's raw integer tracker status to a friendly enum for the UI. */
export function mapTrackerHealth(status: number): QuiTrackerHealth {
	const mapped = TRACKER_HEALTH[status];
	if (mapped !== undefined) return mapped;
	if (!LOGGED_UNKNOWN_STATUSES.has(status)) {
		LOGGED_UNKNOWN_STATUSES.add(status);
		// Defensive fallback: a `console.warn` here surfaces upstream qBit
		// schema additions (new status int we don't know about) without
		// requiring a request-context logger threaded through. Pure mapper
		// stays pure; the warn is one-shot per status per process.
		// biome-ignore lint/suspicious/noConsole: pure mapper, no request context; intentional defensive fallback to surface upstream qBit drift
		console.warn(
			`tracker-health-mapper: unrecognized qBit status int ${status} — mapping to "unknown" (qBit WebAPI may have added a new status value; check qBit changelog)`,
		);
	}
	return "unknown";
}

/** Test-only — reset the per-process "already logged" set. */
export function __resetTrackerHealthUnknownLog(): void {
	LOGGED_UNKNOWN_STATUSES.clear();
}
