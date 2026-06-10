/**
 * Most Concurrent Helpers
 *
 * Aggregates SessionSnapshot rows into a list of peak concurrent-stream
 * events. Replaces Tautulli's pre-aggregated home-stat `most_concurrent`.
 *
 * Unlike top-media / popular-media / last-watched, this aggregator works
 * on snapshot top-level fields (concurrentStreams, totalBandwidth,
 * capturedAt) rather than parsing sessionsJson — every snapshot row
 * already carries the concurrent count.
 */

import type { MostConcurrentResponse } from "@arr/shared";

/** Snapshot row required for concurrent-peak aggregation */
export interface SnapshotForConcurrent {
	capturedAt: Date;
	concurrentStreams: number;
	totalBandwidth: number;
}

/**
 * Dedup window: consecutive snapshots within this window of an already-emitted
 * peak are treated as part of the same peak event. Wider than watch-history's
 * 10 minutes because concurrent peaks plausibly hold for tens of minutes.
 */
const DEDUP_WINDOW_MS = 30 * 60 * 1000;

export function aggregateMostConcurrent(
	snapshots: SnapshotForConcurrent[],
	opts: { limit: number },
): MostConcurrentResponse {
	if (snapshots.length === 0) {
		return { peakConcurrent: 0, events: [] };
	}

	// Walk snapshots ordered by concurrent count DESC. For ties, prefer the
	// earlier timestamp so the "first time we hit this peak" wins.
	const ordered = [...snapshots].sort((a, b) => {
		if (b.concurrentStreams !== a.concurrentStreams) {
			return b.concurrentStreams - a.concurrentStreams;
		}
		return a.capturedAt.getTime() - b.capturedAt.getTime();
	});

	const peakConcurrent = ordered[0]?.concurrentStreams ?? 0;

	// Emit top-N distinct peak events; collapse consecutive ticks within the
	// dedup window into a single event so a 30-min peak doesn't dominate the list.
	const emitted: SnapshotForConcurrent[] = [];
	for (const snap of ordered) {
		if (snap.concurrentStreams === 0) break; // ignore idle snapshots
		const tooCloseToExisting = emitted.some(
			(e) => Math.abs(e.capturedAt.getTime() - snap.capturedAt.getTime()) <= DEDUP_WINDOW_MS,
		);
		if (tooCloseToExisting) continue;
		emitted.push(snap);
		if (emitted.length >= opts.limit) break;
	}

	return {
		peakConcurrent,
		events: emitted.map((e) => ({
			capturedAt: e.capturedAt.toISOString(),
			concurrentStreams: e.concurrentStreams,
			totalBandwidth: e.totalBandwidth,
		})),
	};
}
