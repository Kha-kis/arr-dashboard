/**
 * Transcode Analytics Helpers
 *
 * Pure functions for aggregating transcode decision breakdowns
 * from SessionSnapshot data.
 */

import type { TranscodeAnalytics } from "@arr/shared";

/** Snapshot row for transcode analysis */
export interface SnapshotForTranscode {
	capturedAt: Date;
	directPlayCount: number;
	transcodeCount: number;
	directStreamCount: number;
}

/** Aggregation result including diagnostic counters */
export interface TranscodeAggregationResult extends TranscodeAnalytics {
	parseFailures: number;
	totalSnapshots: number;
}

/**
 * Aggregate transcode/direct play/direct stream analytics from session snapshots.
 *
 * Uses pre-computed columns (no JSON parsing), so parseFailures is always 0.
 */
export function aggregateTranscodeAnalytics(
	snapshots: SnapshotForTranscode[],
): TranscodeAggregationResult {
	let directPlay = 0;
	let transcode = 0;
	let directStream = 0;

	const dailyMap = new Map<
		string,
		{ directPlay: number; transcode: number; directStream: number }
	>();

	for (const snap of snapshots) {
		directPlay += snap.directPlayCount;
		transcode += snap.transcodeCount;
		directStream += snap.directStreamCount;

		const dateKey = snap.capturedAt.toISOString().split("T")[0]!;
		const daily = dailyMap.get(dateKey) ?? { directPlay: 0, transcode: 0, directStream: 0 };
		daily.directPlay += snap.directPlayCount;
		daily.transcode += snap.transcodeCount;
		daily.directStream += snap.directStreamCount;
		dailyMap.set(dateKey, daily);
	}

	const dailyBreakdown = [...dailyMap.entries()].map(([date, counts]) => ({
		date,
		...counts,
	}));

	return {
		directPlay,
		transcode,
		directStream,
		totalSessions: directPlay + transcode + directStream,
		dailyBreakdown,
		parseFailures: 0,
		totalSnapshots: snapshots.length,
	};
}
