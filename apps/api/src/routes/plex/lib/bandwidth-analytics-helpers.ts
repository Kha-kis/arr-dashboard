/**
 * Bandwidth Analytics Helpers
 *
 * Pure functions for aggregating bandwidth and concurrency trends
 * from SessionSnapshot data.
 */

import type { BandwidthAnalytics } from "@arr/shared";

/** Snapshot row for bandwidth analysis */
export interface SnapshotForBandwidth {
	capturedAt: Date;
	concurrentStreams: number;
	totalBandwidth: number;
	lanBandwidth: number;
	wanBandwidth: number;
}

/** Aggregation result including diagnostic counters */
export interface BandwidthAggregationResult extends BandwidthAnalytics {
	parseFailures: number;
	totalSnapshots: number;
}

/**
 * Aggregate bandwidth analytics from session snapshots.
 *
 * Uses pre-computed columns (no JSON parsing), so parseFailures is always 0.
 */
export function aggregateBandwidthAnalytics(snapshots: SnapshotForBandwidth[]): BandwidthAggregationResult {
	let peakConcurrent = 0;
	let peakBandwidth = 0;
	let totalBandwidthSum = 0;

	const dailyMap = new Map<
		string,
		{ concurrent: number; bandwidth: number; lanBandwidth: number; wanBandwidth: number; count: number }
	>();

	for (const snap of snapshots) {
		if (snap.concurrentStreams > peakConcurrent) peakConcurrent = snap.concurrentStreams;
		if (snap.totalBandwidth > peakBandwidth) peakBandwidth = snap.totalBandwidth;
		totalBandwidthSum += snap.totalBandwidth;

		const dateKey = snap.capturedAt.toISOString().split("T")[0]!;
		const daily = dailyMap.get(dateKey) ?? {
			concurrent: 0,
			bandwidth: 0,
			lanBandwidth: 0,
			wanBandwidth: 0,
			count: 0,
		};

		if (snap.concurrentStreams > daily.concurrent) daily.concurrent = snap.concurrentStreams;
		daily.bandwidth += snap.totalBandwidth;
		daily.lanBandwidth += snap.lanBandwidth;
		daily.wanBandwidth += snap.wanBandwidth;
		daily.count++;
		dailyMap.set(dateKey, daily);
	}

	const timeSeries = [...dailyMap.entries()].map(([date, d]) => ({
		date,
		concurrent: d.concurrent,
		bandwidth: d.count > 0 ? Math.round(d.bandwidth / d.count) : 0,
		lanBandwidth: d.count > 0 ? Math.round(d.lanBandwidth / d.count) : 0,
		wanBandwidth: d.count > 0 ? Math.round(d.wanBandwidth / d.count) : 0,
	}));

	return {
		peakConcurrent,
		peakBandwidth,
		avgBandwidth: snapshots.length > 0 ? Math.round(totalBandwidthSum / snapshots.length) : 0,
		timeSeries,
		parseFailures: 0,
		totalSnapshots: snapshots.length,
	};
}
