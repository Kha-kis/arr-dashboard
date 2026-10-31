/**
 * Bandwidth Analytics Helpers
 *
 * Pure functions for aggregating bandwidth and concurrency trends
 * from SessionSnapshot data.
 */

import type {
	BandwidthAnalytics,
	BandwidthMeasurementSummary,
	SnapshotCollectionCoverage,
} from "@arr/shared";
import { parseSessionSnapshotMeasurement } from "../../../plugins/lib/session-snapshot-measurements.js";

/** Snapshot row for bandwidth analysis */
export interface SnapshotForBandwidth {
	capturedAt: Date;
	concurrentStreams: number;
	totalBandwidth: number;
	lanBandwidth: number;
	wanBandwidth: number;
	/** Missing receipts remain legacy/unverified, including old callers. */
	measurementJson?: string | null;
}

/** Aggregation result including diagnostic counters */
export interface BandwidthAggregationResult extends BandwidthAnalytics {
	parseFailures: number;
	totalSnapshots: number;
	measurement: BandwidthMeasurementSummary;
}

export interface BandwidthAnalyticsAccumulator {
	addSnapshots(snapshots: readonly SnapshotForBandwidth[]): void;
	getResult(
		collection?: SnapshotCollectionCoverage,
		collectionByDate?: Record<string, SnapshotCollectionCoverage>,
	): BandwidthAggregationResult;
}

interface MeasurementAggregate {
	concurrent: number | null;
	peakBandwidth: number | null;
	meanBandwidth: number | null;
	observedSessions: number;
	measuredSessions: number;
	observedSnapshots: number;
	measuredSnapshots: number;
	bandwidthBasis: BandwidthMeasurementSummary["bandwidthBasis"];
	collection: SnapshotCollectionCoverage;
}

function emptyAggregate(): MeasurementAggregate {
	return {
		concurrent: null,
		peakBandwidth: null,
		meanBandwidth: null,
		observedSessions: 0,
		measuredSessions: 0,
		observedSnapshots: 0,
		measuredSnapshots: 0,
		bandwidthBasis: null,
		collection: {
			activeSnapshots: 0,
			idleSnapshots: 0,
			failedSnapshots: 0,
			legacySnapshots: 0,
			invalidSnapshots: 0,
		},
	};
}

function summarize(
	aggregate: MeasurementAggregate,
	collection = aggregate.collection,
): BandwidthMeasurementSummary {
	const hasRate = aggregate.measuredSnapshots > 0 && aggregate.bandwidthBasis !== "mixed";
	const complete =
		aggregate.measuredSessions === aggregate.observedSessions &&
		aggregate.measuredSnapshots === aggregate.observedSnapshots &&
		collection.legacySnapshots === 0 &&
		collection.invalidSnapshots === 0 &&
		collection.failedSnapshots === 0;
	return {
		version: 1,
		status: !hasRate ? "unavailable" : complete ? "complete" : "partial",
		bandwidthBasis: aggregate.bandwidthBasis,
		observedSessions: aggregate.observedSessions,
		measuredSessions: aggregate.measuredSessions,
		observedSnapshots: aggregate.observedSnapshots,
		measuredSnapshots: aggregate.measuredSnapshots,
		collection: { ...collection },
	};
}

/** Aggregate receipt-authoritative active rates; historical columns cannot certify them. */
export function createBandwidthAnalyticsAccumulator(): BandwidthAnalyticsAccumulator {
	const aggregate = emptyAggregate();
	const dailyMap = new Map<string, MeasurementAggregate>();
	let totalSnapshots = 0;

	return {
		addSnapshots(snapshots) {
			totalSnapshots += snapshots.length;
			for (const snap of snapshots) {
				const dateKey = snap.capturedAt.toISOString().split("T")[0]!;
				const daily = dailyMap.get(dateKey) ?? emptyAggregate();
				dailyMap.set(dateKey, daily);
				const parsed = parseSessionSnapshotMeasurement(snap.measurementJson);
				const invalid =
					parsed.status === "invalid" ||
					(parsed.status === "legacy" &&
						(!Number.isInteger(snap.concurrentStreams) || snap.concurrentStreams < 0)) ||
					(parsed.status === "verified" &&
						parsed.measurement.observedSessions !== null &&
						parsed.measurement.observedSessions !== snap.concurrentStreams);
				for (const target of [aggregate, daily]) {
					if (invalid) {
						target.collection.invalidSnapshots += 1;
						continue;
					}
					if (parsed.status === "legacy") {
						target.collection.legacySnapshots += 1;
						target.concurrent = Math.max(
							target.concurrent ?? snap.concurrentStreams,
							snap.concurrentStreams,
						);
						target.observedSessions += snap.concurrentStreams;
						target.observedSnapshots += 1;
						continue;
					}
					if (parsed.status !== "verified") continue;
					const receipt = parsed.measurement;
					if (receipt.status === "idle") {
						target.collection.idleSnapshots += 1;
						continue;
					}
					if (receipt.status === "failed") {
						target.collection.failedSnapshots += 1;
						continue;
					}
					target.collection.activeSnapshots += 1;
					target.concurrent = Math.max(
						target.concurrent ?? receipt.observedSessions,
						receipt.observedSessions,
					);
					target.observedSessions += receipt.observedSessions;
					target.measuredSessions += receipt.bandwidth.measuredSessions;
					target.observedSnapshots += 1;
					target.bandwidthBasis =
						target.bandwidthBasis === null || target.bandwidthBasis === receipt.bandwidthBasis
							? receipt.bandwidthBasis
							: "mixed";
					const rate = receipt.bandwidth.knownTotalKbps;
					if (rate === null) continue;
					target.measuredSnapshots += 1;
					target.peakBandwidth = Math.max(target.peakBandwidth ?? 0, rate);
					// All rates are finite and nonnegative. Incremental means avoid sum overflow.
					target.meanBandwidth =
						target.meanBandwidth === null
							? rate
							: target.meanBandwidth + (rate - target.meanBandwidth) / target.measuredSnapshots;
				}
			}
		},
		getResult(collection, collectionByDate) {
			const measurement = summarize(aggregate, collection);
			const timeSeries = [...dailyMap.entries()]
				.filter(([, daily]) => daily.observedSnapshots > 0)
				.map(([date, daily]) => ({
					date,
					concurrent: daily.concurrent,
					bandwidth: daily.bandwidthBasis === "mixed" ? null : daily.meanBandwidth,
					lanBandwidth: null,
					wanBandwidth: null,
					measurement: summarize(daily, collectionByDate?.[date]),
				}));
			return {
				peakConcurrent:
					aggregate.concurrent ?? (measurement.collection.idleSnapshots > 0 ? 0 : null),
				peakBandwidth: aggregate.bandwidthBasis === "mixed" ? null : aggregate.peakBandwidth,
				avgBandwidth: aggregate.bandwidthBasis === "mixed" ? null : aggregate.meanBandwidth,
				timeSeries,
				measurement,
				parseFailures: measurement.collection.invalidSnapshots,
				totalSnapshots,
			};
		},
	};
}

export function aggregateBandwidthAnalytics(
	snapshots: SnapshotForBandwidth[],
): BandwidthAggregationResult {
	const accumulator = createBandwidthAnalyticsAccumulator();
	accumulator.addSnapshots(snapshots);
	return accumulator.getResult();
}
