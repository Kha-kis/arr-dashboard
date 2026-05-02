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

/** Map qBit's raw integer tracker status to a friendly enum for the UI. */
export function mapTrackerHealth(status: number): QuiTrackerHealth {
	return TRACKER_HEALTH[status] ?? "unknown";
}

/**
 * True when the tracker reports a problem. The Library Cleanup gate
 * (Phase 2.2) uses this combined with `unregistered` cross-seed flags
 * to decide whether deletion is safe.
 */
export function isTrackerUnhealthy(health: QuiTrackerHealth): boolean {
	return health === "not_working" || health === "disabled";
}
