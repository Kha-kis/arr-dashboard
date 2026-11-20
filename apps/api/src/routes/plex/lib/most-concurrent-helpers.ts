/**
 * Most Concurrent Helpers
 *
 * Aggregates SessionSnapshot rows into a list of peak concurrent-stream
 * events. Replaces Tautulli's pre-aggregated home-stat `most_concurrent`.
 */

import type {
	MostConcurrentEntry,
	MostConcurrentResponse,
	SnapshotCollectionCoverage,
} from "@arr/shared";
import { parseSessionSnapshotMeasurement } from "../../../plugins/lib/session-snapshot-measurements.js";

/** Snapshot row required for concurrent-peak aggregation. */
export interface SnapshotForConcurrent {
	id?: string;
	capturedAt: Date;
	concurrentStreams: number;
	totalBandwidth: number;
	measurementJson?: string | null;
}

/**
 * Dedup window: consecutive snapshots within this window of an already-emitted
 * peak are treated as part of the same peak event. Wider than watch-history's
 * 10 minutes because concurrent peaks plausibly hold for tens of minutes.
 */
const DEDUP_WINDOW_MS = 30 * 60 * 1000;

export interface MostConcurrentAccumulator {
	addSnapshots(snapshots: readonly SnapshotForConcurrent[]): void;
	getResult(rawCollection?: SnapshotCollectionCoverage): MostConcurrentResponse;
}

/** Accumulates snapshots already ordered by count DESC, timestamp ASC, and ID ASC. */
export function createMostConcurrentAccumulator(opts: {
	limit: number;
}): MostConcurrentAccumulator {
	const maxEvents = Math.min(25, Math.max(0, opts.limit));
	const emitted: Array<{ time: number; entry: MostConcurrentEntry }> = [];
	let peakConcurrent: number | null = null;
	let observedSnapshots = 0;
	const ownCollection: SnapshotCollectionCoverage = {
		activeSnapshots: 0,
		idleSnapshots: 0,
		failedSnapshots: 0,
		legacySnapshots: 0,
		invalidSnapshots: 0,
	};

	return {
		addSnapshots(snapshots) {
			for (const snap of snapshots) {
				const time = snap.capturedAt.getTime();
				const parsed = parseSessionSnapshotMeasurement(snap.measurementJson);
				if (
					!Number.isFinite(time) ||
					!Number.isSafeInteger(snap.concurrentStreams) ||
					snap.concurrentStreams < 0 ||
					parsed.status === "invalid" ||
					(parsed.status === "verified" &&
						parsed.measurement.observedSessions !== null &&
						parsed.measurement.observedSessions !== snap.concurrentStreams)
				) {
					ownCollection.invalidSnapshots++;
					continue;
				}
				if (parsed.status === "verified" && parsed.measurement.status === "failed") {
					ownCollection.failedSnapshots++;
					continue;
				}
				if (parsed.status === "verified" && parsed.measurement.status === "idle") {
					ownCollection.idleSnapshots++;
					continue;
				}
				if (parsed.status === "legacy") ownCollection.legacySnapshots++;
				else ownCollection.activeSnapshots++;
				observedSnapshots++;
				peakConcurrent = Math.max(peakConcurrent ?? snap.concurrentStreams, snap.concurrentStreams);
				if (emitted.length >= maxEvents || snap.concurrentStreams === 0) continue;

				const tooCloseToExisting = emitted.some(
					(event) => Math.abs(event.time - time) <= DEDUP_WINDOW_MS,
				);
				if (tooCloseToExisting) continue;
				const receipt =
					parsed.status === "verified" && parsed.measurement.status === "active"
						? parsed.measurement
						: undefined;
				const bandwidth = receipt?.bandwidth;
				emitted.push({
					time,
					entry: {
						capturedAt: snap.capturedAt.toISOString(),
						concurrentStreams: snap.concurrentStreams,
						totalBandwidth: bandwidth?.status === "complete" ? bandwidth.knownTotalKbps : null,
						knownBandwidthSubtotal: bandwidth?.knownTotalKbps ?? null,
						measurement: {
							version: 1,
							concurrencyStatus: receipt ? "native" : "legacy-unverified",
							bandwidthBasis: receipt?.bandwidthBasis ?? null,
							bandwidthStatus: bandwidth?.status ?? "unavailable",
							observedSessions: snap.concurrentStreams,
							measuredSessions: bandwidth?.measuredSessions ?? 0,
						},
					},
				});
			}
		},
		getResult(rawCollection = ownCollection) {
			const nativeSnapshots = rawCollection.activeSnapshots + rawCollection.idleSnapshots;
			return {
				peakConcurrent: peakConcurrent ?? (rawCollection.idleSnapshots > 0 ? 0 : null),
				events: emitted.map(({ entry }) => ({
					...entry,
					measurement: entry.measurement && { ...entry.measurement },
				})),
				measurement: {
					version: 1,
					scope: "per-source-snapshot",
					status:
						nativeSnapshots === 0
							? "unavailable"
							: rawCollection.failedSnapshots > 0 ||
									rawCollection.invalidSnapshots > 0 ||
									rawCollection.legacySnapshots > 0
								? "partial"
								: "complete",
					observedSnapshots,
					nativeSnapshots,
					collection: { ...rawCollection },
				},
			};
		},
	};
}

export function aggregateMostConcurrent(
	snapshots: SnapshotForConcurrent[],
	opts: { limit: number },
): MostConcurrentResponse {
	const ordered = snapshots
		.map((snapshot, index) => ({ snapshot, index }))
		.sort((a, b) => {
			if (b.snapshot.concurrentStreams !== a.snapshot.concurrentStreams) {
				return b.snapshot.concurrentStreams - a.snapshot.concurrentStreams;
			}
			const timeDifference = a.snapshot.capturedAt.getTime() - b.snapshot.capturedAt.getTime();
			if (timeDifference !== 0) return timeDifference;
			if (a.snapshot.id && b.snapshot.id) return a.snapshot.id.localeCompare(b.snapshot.id);
			return a.index - b.index;
		})
		.map(({ snapshot }) => snapshot);
	const accumulator = createMostConcurrentAccumulator(opts);
	accumulator.addSnapshots(ordered);
	return accumulator.getResult();
}
