/**
 * Codec Analytics Helpers
 *
 * Pure functions for aggregating video/audio codec and resolution
 * distributions from SessionSnapshot data.
 */

import type { CodecAnalytics } from "@arr/shared";

/** Parsed session entry with enriched codec fields */
interface SessionEntry {
	videoCodec?: string | null;
	audioCodec?: string | null;
	videoResolution?: string | null;
}

/** Snapshot row for codec analysis */
export interface SnapshotForCodec {
	sessionsJson: string;
}

/**
 * Aggregate codec/resolution analytics from session snapshots.
 * Fields missing from pre-enrichment snapshots are counted as "unknown".
 */
export interface CodecAggregationResult extends CodecAnalytics {
	parseFailures: number;
	totalSnapshots: number;
	failedPreviews: string[];
}

export function aggregateCodecAnalytics(snapshots: SnapshotForCodec[]): CodecAggregationResult {
	const videoCodecMap = new Map<string, number>();
	const audioCodecMap = new Map<string, number>();
	const resolutionMap = new Map<string, number>();
	let totalSessions = 0;
	let parseFailures = 0;
	const failedPreviews: string[] = [];

	for (const snap of snapshots) {
		let sessions: SessionEntry[];
		try {
			sessions = JSON.parse(snap.sessionsJson);
		} catch {
			parseFailures++;
			if (failedPreviews.length < 5) failedPreviews.push(snap.sessionsJson.slice(0, 100));
			continue;
		}

		for (const session of sessions) {
			totalSessions++;

			const vc = session.videoCodec || "unknown";
			videoCodecMap.set(vc, (videoCodecMap.get(vc) ?? 0) + 1);

			const ac = session.audioCodec || "unknown";
			audioCodecMap.set(ac, (audioCodecMap.get(ac) ?? 0) + 1);

			const res = session.videoResolution || "unknown";
			resolutionMap.set(res, (resolutionMap.get(res) ?? 0) + 1);
		}
	}

	const toSorted = (map: Map<string, number>) =>
		[...map.entries()]
			.map(([key, count]) => ({
				key,
				count,
				percent: totalSessions > 0 ? Math.round((count / totalSessions) * 1000) / 10 : 0,
			}))
			.sort((a, b) => b.count - a.count);

	const videoCodecs = toSorted(videoCodecMap).map(({ key, count, percent }) => ({
		codec: key,
		count,
		percent,
	}));
	const audioCodecs = toSorted(audioCodecMap).map(({ key, count, percent }) => ({
		codec: key,
		count,
		percent,
	}));
	const resolutions = toSorted(resolutionMap).map(({ key, count, percent }) => ({
		resolution: key,
		count,
		percent,
	}));

	return {
		videoCodecs,
		audioCodecs,
		resolutions,
		totalSessions,
		parseFailures,
		totalSnapshots: snapshots.length,
		failedPreviews,
	};
}
