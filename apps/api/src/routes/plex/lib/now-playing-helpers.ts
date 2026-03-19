/**
 * Now Playing Helpers
 *
 * Pure functions for computing aggregate now-playing statistics.
 */

import type { PlexSession } from "@arr/shared";

/**
 * Sum the bandwidth of all active sessions.
 */
export function computeTotalBandwidth(sessions: Pick<PlexSession, "bandwidth">[]): number {
	let total = 0;
	for (const session of sessions) {
		total += session.bandwidth ?? 0;
	}
	return total;
}
