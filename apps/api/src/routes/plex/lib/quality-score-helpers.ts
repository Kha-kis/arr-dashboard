/** Native video-processing/resolution heuristic; not a playback QoE measurement. */

import type {
	QualityScoreAnalytics,
	QualityScoreComponents,
	QualityScoreCoverage,
	QualityScoreMeasurementSummary,
	SessionPlaybackDecision,
	SnapshotCollectionCoverage,
} from "@arr/shared";
import {
	parseSessionSnapshotMeasurement,
	readSessionSnapshotActorKey,
} from "../../../plugins/lib/session-snapshot-measurements.js";
import { readVideoMethods } from "./transcode-analytics-helpers.js";

export interface SnapshotForQuality {
	capturedAt: Date;
	sessionsJson: string;
	concurrentStreams: number;
	measurementJson?: string | null;
	/** Provider-native IDs are attributable only within their source instance. */
	instanceId?: string;
}

export interface QualityScoreResult extends QualityScoreAnalytics {
	components: QualityScoreComponents;
	measurement: QualityScoreMeasurementSummary;
	parseFailures: number;
	totalSnapshots: number;
}

interface ScoreCounters extends QualityScoreCoverage {
	directPlay: number;
	transcode: number;
	resolutionTotal: number;
	jointDirectPlay: number;
	jointTranscode: number;
	jointResolutionTotal: number;
}

interface ScoreAggregate extends ScoreCounters {
	invalidDetailSnapshots: number;
	unattributedSessions: number;
	collection: SnapshotCollectionCoverage;
}

interface UserAggregate extends ScoreCounters {
	username: string;
	labelCapturedAt: number;
}

function emptyCounters(): ScoreCounters {
	return {
		observedSessions: 0,
		methodMeasuredSessions: 0,
		resolutionMeasuredSessions: 0,
		scoredSessions: 0,
		directPlay: 0,
		transcode: 0,
		resolutionTotal: 0,
		jointDirectPlay: 0,
		jointTranscode: 0,
		jointResolutionTotal: 0,
	};
}

function emptyAggregate(): ScoreAggregate {
	return {
		...emptyCounters(),
		invalidDetailSnapshots: 0,
		unattributedSessions: 0,
		collection: {
			activeSnapshots: 0,
			idleSnapshots: 0,
			failedSnapshots: 0,
			legacySnapshots: 0,
			invalidSnapshots: 0,
		},
	};
}

/** Accept explicit wire strings only; absent evidence never becomes SD. */
function getResolutionScore(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const resolution = value.trim().toLowerCase();
	if (resolution === "4k") return 100;
	if (resolution === "sd") return 25;
	const dimensions = /^(\d+)\s*x\s*(\d+)$/.exec(resolution);
	const height = /^(\d+)p?$/.exec(resolution);
	let edge: number;
	if (dimensions) {
		const width = Number(dimensions[1]);
		const dimensionHeight = Number(dimensions[2]);
		if (
			!Number.isSafeInteger(width) ||
			width <= 0 ||
			!Number.isSafeInteger(dimensionHeight) ||
			dimensionHeight <= 0
		)
			return null;
		edge = Math.min(width, dimensionHeight);
	} else if (height) {
		edge = Number(height[1]);
		if (!Number.isSafeInteger(edge) || edge <= 0) return null;
	} else {
		return null;
	}
	if (edge >= 2160) return 100;
	if (edge >= 1080) return 75;
	if (edge >= 720) return 50;
	if (edge >= 576) return 35;
	return 25;
}

function coverage(counters: ScoreCounters): QualityScoreCoverage {
	return {
		observedSessions: counters.observedSessions,
		methodMeasuredSessions: counters.methodMeasuredSessions,
		resolutionMeasuredSessions: counters.resolutionMeasuredSessions,
		scoredSessions: counters.scoredSessions,
	};
}

function components(counters: ScoreCounters, joint = false): QualityScoreComponents {
	const methods = joint ? counters.scoredSessions : counters.methodMeasuredSessions;
	const resolutions = joint ? counters.scoredSessions : counters.resolutionMeasuredSessions;
	return {
		directPlayScore:
			methods === 0
				? null
				: Math.round(((joint ? counters.jointDirectPlay : counters.directPlay) / methods) * 100),
		resolutionScore:
			resolutions === 0
				? null
				: Math.round(
						(joint ? counters.jointResolutionTotal : counters.resolutionTotal) / resolutions,
					),
		transcodeScore:
			methods === 0
				? null
				: Math.round((1 - (joint ? counters.jointTranscode : counters.transcode) / methods) * 100),
	};
}

function composite(counters: ScoreCounters): number | null {
	if (counters.scoredSessions === 0) return null;
	// Keep components unrounded until the single final composite rounding.
	return Math.round(
		(counters.jointDirectPlay / counters.scoredSessions) * 100 * 0.4 +
			(counters.jointResolutionTotal / counters.scoredSessions) * 0.3 +
			(1 - counters.jointTranscode / counters.scoredSessions) * 100 * 0.3,
	);
}

function summarize(
	aggregate: ScoreAggregate,
	collection = aggregate.collection,
): QualityScoreMeasurementSummary {
	const complete =
		aggregate.scoredSessions === aggregate.observedSessions &&
		aggregate.invalidDetailSnapshots === 0 &&
		collection.failedSnapshots === 0 &&
		collection.legacySnapshots === 0 &&
		collection.invalidSnapshots === 0;
	return {
		version: 1,
		methodAxis: "video",
		status: aggregate.scoredSessions === 0 ? "unavailable" : complete ? "complete" : "partial",
		...coverage(aggregate),
		invalidDetailSnapshots: aggregate.invalidDetailSnapshots,
		unattributedSessions: aggregate.unattributedSessions,
		collection: { ...collection },
	};
}

function addRow(
	counters: ScoreCounters,
	decision: SessionPlaybackDecision,
	resolution: number | null,
): void {
	counters.observedSessions += 1;
	if (decision !== "unknown") {
		counters.methodMeasuredSessions += 1;
		if (decision === "direct_play") counters.directPlay += 1;
		if (decision === "transcode") counters.transcode += 1;
	}
	if (resolution !== null) {
		counters.resolutionMeasuredSessions += 1;
		counters.resolutionTotal += resolution;
		if (decision !== "unknown") {
			counters.scoredSessions += 1;
			counters.jointResolutionTotal += resolution;
			if (decision === "direct_play") counters.jointDirectPlay += 1;
			if (decision === "transcode") counters.jointTranscode += 1;
		}
	}
}

function nonemptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

export function createQualityScoreAccumulator() {
	const aggregate = emptyAggregate();
	const dailyMap = new Map<string, ScoreAggregate>();
	const userMap = new Map<string, UserAggregate>();
	let totalSnapshots = 0;

	function addBatch(snapshots: readonly SnapshotForQuality[]): void {
		totalSnapshots += snapshots.length;
		for (const snap of snapshots) {
			const date = snap.capturedAt.toISOString().slice(0, 10);
			const daily = dailyMap.get(date) ?? emptyAggregate();
			dailyMap.set(date, daily);
			const targets = [aggregate, daily];
			const parsed = parseSessionSnapshotMeasurement(snap.measurementJson);
			const invalid =
				parsed.status === "invalid" ||
				(parsed.status === "legacy" &&
					(!Number.isInteger(snap.concurrentStreams) || snap.concurrentStreams < 0)) ||
				(parsed.status === "verified" &&
					parsed.measurement.observedSessions !== null &&
					parsed.measurement.observedSessions !== snap.concurrentStreams);
			if (invalid) {
				for (const target of targets) target.collection.invalidSnapshots += 1;
				continue;
			}
			if (parsed.status === "legacy") {
				for (const target of targets) {
					target.collection.legacySnapshots += 1;
					target.observedSessions += snap.concurrentStreams;
					target.unattributedSessions += snap.concurrentStreams;
				}
				continue;
			}
			if (parsed.status !== "verified") continue;
			const receipt = parsed.measurement;
			if (receipt.status !== "active") {
				for (const target of targets) {
					if (receipt.status === "idle") target.collection.idleSnapshots += 1;
					else target.collection.failedSnapshots += 1;
				}
				continue;
			}
			const detail = readVideoMethods(snap.sessionsJson, receipt);
			for (const target of targets) {
				target.collection.activeSnapshots += 1;
				if (detail.invalidDetail) target.invalidDetailSnapshots += 1;
			}
			if (detail.rows === null) {
				for (const target of targets) {
					target.observedSessions += receipt.observedSessions;
					target.unattributedSessions += receipt.observedSessions;
				}
				continue;
			}
			for (const [index, row] of detail.rows.entries()) {
				const entry =
					row !== null && typeof row === "object" && !Array.isArray(row)
						? (row as Record<string, unknown>)
						: null;
				const decision = detail.decisions?.[index] ?? "unknown";
				const resolution = getResolutionScore(entry?.videoResolution);
				for (const target of targets) addRow(target, decision, resolution);
				const key = readSessionSnapshotActorKey(snap.instanceId, entry, receipt);
				if (entry === null || key === null) {
					for (const target of targets) target.unattributedSessions += 1;
					continue;
				}
				const user = userMap.get(key) ?? {
					...emptyCounters(),
					username: "Unlabeled user",
					labelCapturedAt: Number.NEGATIVE_INFINITY,
				};
				if (nonemptyString(entry.user)) {
					const label = entry.user.trim();
					const capturedAt = snap.capturedAt.getTime();
					if (
						capturedAt > user.labelCapturedAt ||
						(capturedAt === user.labelCapturedAt && label.localeCompare(user.username) > 0)
					) {
						user.username = label;
						user.labelCapturedAt = capturedAt;
					}
				}
				addRow(user, decision, resolution);
				userMap.set(key, user);
			}
		}
	}

	function getResult(
		collection?: SnapshotCollectionCoverage,
		collectionByDate?: Record<string, SnapshotCollectionCoverage>,
	): QualityScoreResult {
		const measurement = summarize(aggregate, collection);
		const dates = new Set([...dailyMap.keys(), ...Object.keys(collectionByDate ?? {})]);
		const trend = [...dates].sort().map((date) => {
			const daily = dailyMap.get(date) ?? emptyAggregate();
			return {
				date,
				score: composite(daily),
				components: components(daily),
				measurement: summarize(daily, collectionByDate?.[date]),
			};
		});
		const perUser = [...userMap.entries()]
			.map(([key, user]) => ({
				key,
				username: user.username,
				score: composite(user),
				sessions: user.observedSessions,
				components: components(user),
				coverage: coverage(user),
			}))
			.sort((a, b) => b.sessions - a.sessions || a.key.localeCompare(b.key));
		return {
			overallScore: composite(aggregate),
			breakdown: components(aggregate, true),
			components: components(aggregate),
			measurement,
			trend,
			perUser,
			parseFailures: measurement.collection.invalidSnapshots + measurement.invalidDetailSnapshots,
			totalSnapshots,
		};
	}

	return { addBatch, getResult };
}

export function computeQualityScore(snapshots: SnapshotForQuality[]): QualityScoreResult {
	const accumulator = createQualityScoreAccumulator();
	accumulator.addBatch(snapshots);
	return accumulator.getResult();
}
