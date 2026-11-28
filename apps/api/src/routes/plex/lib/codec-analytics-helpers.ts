/**
 * Codec Analytics Helpers
 *
 * Pure functions for aggregating video/audio codec and resolution
 * distributions from SessionSnapshot data.
 */

import type {
	CodecAnalytics,
	CodecAnalyticsMeasurementSummary,
	SnapshotCollectionCoverage,
} from "@arr/shared";
import { parseSessionSnapshotMeasurement } from "../../../plugins/lib/session-snapshot-measurements.js";

/** Snapshot row for codec analysis */
export interface SnapshotForCodec {
	sessionsJson: string;
	concurrentStreams?: number;
	measurementJson?: string | null;
}

/**
 * Aggregate codec/resolution analytics from session snapshots.
 * Fields missing from pre-enrichment snapshots are counted as "unknown".
 */
export interface CodecAggregationResult extends CodecAnalytics {
	measurement: CodecAnalyticsMeasurementSummary;
	parseFailures: number;
	totalSnapshots: number;
	failedPreviews: string[];
}

export interface CodecAnalyticsAccumulator {
	addSnapshots(snapshots: readonly SnapshotForCodec[]): void;
	getResult(collection?: SnapshotCollectionCoverage): CodecAggregationResult;
}

function codec(value: unknown): string {
	if (typeof value !== "string") return "unknown";
	const normalized = value.trim().toLowerCase();
	return /^[a-z0-9][a-z0-9._+-]{0,63}$/.test(normalized) ? normalized : "unknown";
}
function resolution(value: unknown): string {
	if (typeof value !== "string") return "unknown";
	const normalized = value.trim().toLowerCase();
	if (normalized === "4k") return "2160";
	if (normalized === "sd") return "sd";
	const dimensions = /^(\d+)\s*x\s*(\d+)$/.exec(normalized);
	const height = /^(\d+)p?$/.exec(normalized);
	const values = dimensions
		? [Number(dimensions[1]), Number(dimensions[2])]
		: height
			? [Number(height[1])]
			: [];
	return values.length > 0 && values.every((n) => Number.isSafeInteger(n) && n > 0)
		? String(Math.min(...values))
		: "unknown";
}
function parseRows(value: string): unknown[] | null {
	try {
		const rows: unknown = JSON.parse(value);
		return Array.isArray(rows) ? rows : null;
	} catch {
		return null;
	}
}

export function createCodecAnalyticsAccumulator(): CodecAnalyticsAccumulator {
	const videoCodecMap = new Map<string, number>();
	const audioCodecMap = new Map<string, number>();
	const resolutionMap = new Map<string, number>();
	let totalSessions = 0;
	let totalSnapshots = 0;
	let invalidDetailSnapshots = 0;
	let videoCodecMeasuredSessions = 0;
	let audioCodecMeasuredSessions = 0;
	let resolutionMeasuredSessions = 0;
	const ownCollection: SnapshotCollectionCoverage = {
		activeSnapshots: 0,
		idleSnapshots: 0,
		failedSnapshots: 0,
		legacySnapshots: 0,
		invalidSnapshots: 0,
	};
	const add = (map: Map<string, number>, key: string, count = 1) => {
		if (count > 0) map.set(key, (map.get(key) ?? 0) + count);
	};
	const addUnknown = (count: number) => {
		for (const map of [videoCodecMap, audioCodecMap, resolutionMap]) add(map, "unknown", count);
	};

	return {
		addSnapshots(snapshots) {
			totalSnapshots += snapshots.length;
			for (const snap of snapshots) {
				const parsed = parseSessionSnapshotMeasurement(snap.measurementJson);
				if (
					parsed.status === "invalid" ||
					(snap.concurrentStreams !== undefined &&
						(!Number.isSafeInteger(snap.concurrentStreams) ||
							snap.concurrentStreams < 0 ||
							(parsed.status === "verified" &&
								parsed.measurement.observedSessions !== null &&
								parsed.measurement.observedSessions !== snap.concurrentStreams)))
				) {
					ownCollection.invalidSnapshots++;
					continue;
				}
				if (parsed.status === "legacy") {
					const rows = parseRows(snap.sessionsJson);
					const count = snap.concurrentStreams ?? rows?.length;
					if (count === undefined) {
						ownCollection.invalidSnapshots++;
						continue;
					}
					ownCollection.legacySnapshots++;
					totalSessions += count;
					addUnknown(count);
					if (rows === null || rows.length !== count) invalidDetailSnapshots++;
					continue;
				}
				const receipt = parsed.measurement;
				if (receipt.status === "idle") {
					ownCollection.idleSnapshots++;
					continue;
				}
				if (receipt.status === "failed") {
					ownCollection.failedSnapshots++;
					continue;
				}
				ownCollection.activeSnapshots++;
				totalSessions += receipt.observedSessions;
				const rows = parseRows(snap.sessionsJson);
				if (rows === null || rows.length !== receipt.observedSessions) {
					invalidDetailSnapshots++;
					addUnknown(receipt.observedSessions);
					continue;
				}
				let invalidDetail = false;
				for (const row of rows) {
					const session =
						row !== null && typeof row === "object" && !Array.isArray(row)
							? (row as Record<string, unknown>)
							: null;
					if (session === null) invalidDetail = true;
					const vc = codec(session?.videoCodec);
					const ac = codec(session?.audioCodec);
					const res = resolution(session?.videoResolution);
					add(videoCodecMap, vc);
					add(audioCodecMap, ac);
					add(resolutionMap, res);
					if (vc !== "unknown") videoCodecMeasuredSessions++;
					if (ac !== "unknown") audioCodecMeasuredSessions++;
					if (res !== "unknown") resolutionMeasuredSessions++;
				}
				if (invalidDetail) invalidDetailSnapshots++;
			}
		},
		getResult(collection = ownCollection) {
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
				measurement: {
					version: 1,
					status:
						videoCodecMeasuredSessions + audioCodecMeasuredSessions + resolutionMeasuredSessions ===
						0
							? "unavailable"
							: videoCodecMeasuredSessions === totalSessions &&
									audioCodecMeasuredSessions === totalSessions &&
									resolutionMeasuredSessions === totalSessions &&
									invalidDetailSnapshots === 0 &&
									collection.failedSnapshots === 0 &&
									collection.legacySnapshots === 0 &&
									collection.invalidSnapshots === 0
								? "complete"
								: "partial",
					observedSessions: totalSessions,
					videoCodecMeasuredSessions,
					audioCodecMeasuredSessions,
					resolutionMeasuredSessions,
					invalidDetailSnapshots,
					collection: { ...collection },
				},
				parseFailures: collection.invalidSnapshots + invalidDetailSnapshots,
				totalSnapshots,
				failedPreviews: [],
			};
		},
	};
}

export function aggregateCodecAnalytics(snapshots: SnapshotForCodec[]): CodecAggregationResult {
	const accumulator = createCodecAnalyticsAccumulator();
	accumulator.addSnapshots(snapshots);
	return accumulator.getResult();
}
