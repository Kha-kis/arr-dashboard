/**
 * Transcode Analytics Helpers
 *
 * Pure functions for aggregating transcode decision breakdowns
 * from SessionSnapshot data.
 */

import {
	normalizeSessionPlaybackDecision,
	type SessionMethodMeasurementSummary,
	type SessionPlaybackDecision,
	type SnapshotCollectionCoverage,
	type TranscodeAnalytics,
} from "@arr/shared";
import {
	parseSessionSnapshotMeasurement,
	type SessionSnapshotMeasurement,
} from "../../../plugins/lib/session-snapshot-measurements.js";

/** Snapshot row for transcode analysis */
export interface SnapshotForTranscode {
	capturedAt: Date;
	concurrentStreams: number;
	sessionsJson: string;
	/** Missing receipts cannot certify historical method defaults. */
	measurementJson?: string | null;
	/** Compatibility projections, never method measurement authority. */
	directPlayCount?: number;
	transcodeCount?: number;
	directStreamCount?: number;
}

/** Aggregation result including diagnostic counters */
export interface TranscodeAggregationResult extends TranscodeAnalytics {
	parseFailures: number;
	totalSnapshots: number;
	unknown: number;
	measurement: SessionMethodMeasurementSummary;
}

export interface TranscodeAnalyticsAccumulator {
	addSnapshots(snapshots: readonly SnapshotForTranscode[]): void;
	getResult(
		collection?: SnapshotCollectionCoverage,
		collectionByDate?: Record<string, SnapshotCollectionCoverage>,
	): TranscodeAggregationResult;
}

interface MethodCounts {
	directPlay: number;
	transcode: number;
	directStream: number;
	unknown: number;
}

interface MethodAggregate extends MethodCounts {
	observedSessions: number;
	invalidDetailSnapshots: number;
	collection: SnapshotCollectionCoverage;
}

function emptyCounts(): MethodCounts {
	return { directPlay: 0, transcode: 0, directStream: 0, unknown: 0 };
}

function emptyAggregate(): MethodAggregate {
	return {
		...emptyCounts(),
		observedSessions: 0,
		invalidDetailSnapshots: 0,
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
	aggregate: MethodAggregate,
	collection = aggregate.collection,
): SessionMethodMeasurementSummary {
	const measuredSessions = aggregate.directPlay + aggregate.transcode + aggregate.directStream;
	const complete =
		measuredSessions === aggregate.observedSessions &&
		aggregate.invalidDetailSnapshots === 0 &&
		collection.failedSnapshots === 0 &&
		collection.legacySnapshots === 0 &&
		collection.invalidSnapshots === 0;
	return {
		version: 1,
		methodAxis: "video",
		status: measuredSessions === 0 ? "unavailable" : complete ? "complete" : "partial",
		observedSessions: aggregate.observedSessions,
		measuredSessions,
		invalidDetailSnapshots: aggregate.invalidDetailSnapshots,
		collection: { ...collection },
	};
}

/** Shared native detail validation; consumers must not re-impute video decisions. */
export function readVideoMethods(
	sessionsJson: string,
	receipt: Extract<SessionSnapshotMeasurement, { status: "active" }>,
): {
	counts: MethodCounts;
	invalidDetail: boolean;
	rows: readonly unknown[] | null;
	decisions: readonly SessionPlaybackDecision[] | null;
} {
	const unknownDetail = {
		counts: { ...emptyCounts(), unknown: receipt.observedSessions },
		invalidDetail: true,
		rows: null,
		decisions: null,
	};
	let detail: unknown;
	try {
		detail = JSON.parse(sessionsJson);
	} catch {
		return unknownDetail;
	}
	if (!Array.isArray(detail) || detail.length !== receipt.observedSessions) return unknownDetail;
	const counts = emptyCounts();
	const decisions: SessionPlaybackDecision[] = [];
	let invalidDetail = false;
	for (const row of detail) {
		if (row === null || typeof row !== "object" || Array.isArray(row)) {
			counts.unknown += 1;
			decisions.push("unknown");
			invalidDetail = true;
			continue;
		}
		const decision = normalizeSessionPlaybackDecision(row.videoDecision);
		decisions.push(decision);
		switch (decision) {
			case "direct_play":
				counts.directPlay += 1;
				break;
			case "transcode":
				counts.transcode += 1;
				break;
			case "direct_stream":
				counts.directStream += 1;
				break;
			default:
				counts.unknown += 1;
		}
	}
	// Older v1 Jellyfin/Emby summaries used overall playback, but retained native
	// video rows. Only explicitly video-axis receipts certify summary agreement.
	if (
		receipt.methodAxis === "video" &&
		(counts.directPlay !== receipt.methods.directPlayCount ||
			counts.transcode !== receipt.methods.transcodeCount ||
			counts.directStream !== receipt.methods.directStreamCount ||
			counts.unknown !== receipt.methods.unknownDecisionCount)
	) {
		return { ...unknownDetail, rows: detail };
	}
	return { counts, invalidDetail, rows: detail, decisions };
}

/** Aggregate comparable native video decisions without scalar or overall-method fallbacks. */
export function createTranscodeAnalyticsAccumulator(): TranscodeAnalyticsAccumulator {
	const aggregate = emptyAggregate();
	const dailyMap = new Map<string, MethodAggregate>();
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
				const video =
					!invalid && parsed.status === "verified" && parsed.measurement.status === "active"
						? readVideoMethods(snap.sessionsJson, parsed.measurement)
						: null;
				for (const target of [aggregate, daily]) {
					if (invalid) {
						target.collection.invalidSnapshots += 1;
						continue;
					}
					if (parsed.status === "legacy") {
						target.collection.legacySnapshots += 1;
						target.observedSessions += snap.concurrentStreams;
						target.unknown += snap.concurrentStreams;
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
					if (video === null) continue;
					target.collection.activeSnapshots += 1;
					target.observedSessions += receipt.observedSessions;
					target.directPlay += video.counts.directPlay;
					target.transcode += video.counts.transcode;
					target.directStream += video.counts.directStream;
					target.unknown += video.counts.unknown;
					if (video.invalidDetail) target.invalidDetailSnapshots += 1;
				}
			}
		},
		getResult(collection, collectionByDate) {
			const measurement = summarize(aggregate, collection);
			const dates = new Set([...dailyMap.keys(), ...Object.keys(collectionByDate ?? {})]);
			const dailyBreakdown = [...dates].sort().map((date) => {
				const daily = dailyMap.get(date) ?? emptyAggregate();
				return {
					date,
					directPlay: daily.directPlay,
					transcode: daily.transcode,
					directStream: daily.directStream,
					unknown: daily.unknown,
					measurement: summarize(daily, collectionByDate?.[date]),
				};
			});
			return {
				directPlay: aggregate.directPlay,
				transcode: aggregate.transcode,
				directStream: aggregate.directStream,
				unknown: aggregate.unknown,
				totalSessions: aggregate.observedSessions,
				dailyBreakdown,
				measurement,
				parseFailures: measurement.collection.invalidSnapshots + measurement.invalidDetailSnapshots,
				totalSnapshots,
			};
		},
	};
}

export function aggregateTranscodeAnalytics(
	snapshots: SnapshotForTranscode[],
): TranscodeAggregationResult {
	const accumulator = createTranscodeAnalyticsAccumulator();
	accumulator.addSnapshots(snapshots);
	return accumulator.getResult();
}
