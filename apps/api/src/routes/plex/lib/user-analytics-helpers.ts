/** Source-native user observations and measured sampled rates, never traffic volume. */
import {
	getSessionBandwidthKbps,
	measureSessionBandwidth,
	type SnapshotCollectionCoverage,
	type UserAnalytics,
	type UserAnalyticsBandwidthMeasurement,
	type UserAnalyticsMeasurementSummary,
} from "@arr/shared";
import {
	parseSessionSnapshotMeasurement,
	readSessionSnapshotActorKey,
} from "../../../plugins/lib/session-snapshot-measurements.js";
import { readVideoMethods } from "./transcode-analytics-helpers.js";

export interface SnapshotWithSessions {
	capturedAt: Date;
	sessionsJson: string;
	concurrentStreams: number;
	measurementJson?: string | null;
	instanceId?: string;
}

const SNAPSHOT_INTERVAL_MINUTES = 5;

export interface UserAnalyticsMeta {
	parseFailures: number;
	totalSnapshots: number;
}

/** Compatibility for existing top-media callers; user results never emit previews. */
export interface AggregationMeta extends UserAnalyticsMeta {
	failedPreviews: string[];
}

export interface UserAnalyticsResult extends UserAnalytics, UserAnalyticsMeta {
	measurement: UserAnalyticsMeasurementSummary;
}

export interface UserAnalyticsAccumulator {
	addSnapshots(snapshots: readonly SnapshotWithSessions[]): void;
	getResult(
		collection?: SnapshotCollectionCoverage,
		collectionByDate?: Record<string, SnapshotCollectionCoverage>,
	): UserAnalyticsResult;
}

interface AttributionAggregate {
	observedSessions: number;
	attributedSessions: number;
	unattributedSessions: number;
	invalidDetailSnapshots: number;
	collection: SnapshotCollectionCoverage;
}

interface DailyAggregate extends AttributionAggregate {
	userSessions: Map<string, number>;
}

interface UserAggregate {
	username: string;
	labelCapturedAt: number;
	mostRecentActivity: number;
	totalSessions: number;
	measuredSessions: number;
	avgBandwidth: number | null;
	bandwidthBasis: UserAnalyticsBandwidthMeasurement["bandwidthBasis"];
}

function emptyAggregate(): AttributionAggregate {
	return {
		observedSessions: 0,
		attributedSessions: 0,
		unattributedSessions: 0,
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

function emptyDaily(): DailyAggregate {
	return { ...emptyAggregate(), userSessions: new Map() };
}

function summarize(
	aggregate: AttributionAggregate,
	collection = aggregate.collection,
): UserAnalyticsMeasurementSummary {
	const complete =
		aggregate.attributedSessions === aggregate.observedSessions &&
		aggregate.invalidDetailSnapshots === 0 &&
		collection.failedSnapshots === 0 &&
		collection.legacySnapshots === 0 &&
		collection.invalidSnapshots === 0;
	return {
		version: 1,
		attribution: "source-provider-user-id",
		status: aggregate.attributedSessions === 0 ? "unavailable" : complete ? "complete" : "partial",
		observedSessions: aggregate.observedSessions,
		attributedSessions: aggregate.attributedSessions,
		unattributedSessions: aggregate.unattributedSessions,
		invalidDetailSnapshots: aggregate.invalidDetailSnapshots,
		collection: { ...collection },
	};
}

function safeRow(row: unknown): Record<string, unknown> | null {
	return row !== null && typeof row === "object" && !Array.isArray(row)
		? (row as Record<string, unknown>)
		: null;
}

function nonemptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

export function createUserAnalyticsAccumulator(): UserAnalyticsAccumulator {
	const aggregate = emptyAggregate();
	const dailyMap = new Map<string, DailyAggregate>();
	const userMap = new Map<string, UserAggregate>();
	let totalSnapshots = 0;

	return {
		addSnapshots(snapshots) {
			totalSnapshots += snapshots.length;
			for (const snap of snapshots) {
				const date = snap.capturedAt.toISOString().slice(0, 10);
				const daily = dailyMap.get(date) ?? emptyDaily();
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
					target.observedSessions += receipt.observedSessions;
				}
				if (detail.rows === null) {
					for (const target of targets) {
						target.unattributedSessions += receipt.observedSessions;
						target.invalidDetailSnapshots += 1;
					}
					continue;
				}
				const entries = detail.rows.map(safeRow);
				// Rate agreement covers the full native array, including unattributed
				// and malformed rows. A selected-user subtotal cannot certify a receipt.
				const bandwidth = measureSessionBandwidth(
					entries.map((entry) => ({ bandwidth: getSessionBandwidthKbps(entry?.bandwidth) })),
				);
				const ratesVerified =
					bandwidth.measuredSessions === receipt.bandwidth.measuredSessions &&
					bandwidth.knownTotalKbps === receipt.bandwidth.knownTotalKbps;
				if (detail.invalidDetail || !ratesVerified) {
					for (const target of targets) target.invalidDetailSnapshots += 1;
				}
				for (const entry of entries) {
					const key = readSessionSnapshotActorKey(snap.instanceId, entry, receipt);
					if (entry === null || key === null) {
						for (const target of targets) target.unattributedSessions += 1;
						continue;
					}
					const user = userMap.get(key) ?? {
						username: "Unlabeled user",
						labelCapturedAt: Number.NEGATIVE_INFINITY,
						mostRecentActivity: Number.NEGATIVE_INFINITY,
						totalSessions: 0,
						measuredSessions: 0,
						avgBandwidth: null,
						bandwidthBasis: receipt.bandwidthBasis,
					};
					const capturedAt = snap.capturedAt.getTime();
					if (nonemptyString(entry.user)) {
						const label = entry.user.trim();
						if (
							capturedAt > user.labelCapturedAt ||
							(capturedAt === user.labelCapturedAt && label.localeCompare(user.username) > 0)
						) {
							user.username = label;
							user.labelCapturedAt = capturedAt;
						}
					}
					user.mostRecentActivity = Math.max(user.mostRecentActivity, capturedAt);
					user.totalSessions += 1;
					const rate = ratesVerified ? getSessionBandwidthKbps(entry.bandwidth) : null;
					if (rate !== null) {
						user.measuredSessions += 1;
						// Nonnegative finite rates permit a bounded incremental mean, even
						// when summing all rates would overflow the receipt's known total.
						user.avgBandwidth =
							user.avgBandwidth === null
								? rate
								: user.avgBandwidth + (rate - user.avgBandwidth) / user.measuredSessions;
					}
					userMap.set(key, user);
					for (const target of targets) target.attributedSessions += 1;
					daily.userSessions.set(key, (daily.userSessions.get(key) ?? 0) + 1);
				}
			}
		},
		getResult(collection, collectionByDate) {
			const measurement = summarize(aggregate, collection);
			const users = [...userMap.entries()]
				.map(([key, user]) => ({
					key,
					username: user.username,
					totalSessions: user.totalSessions,
					totalBandwidth: null,
					avgBandwidth: user.avgBandwidth,
					// Sample weighting is an estimate, not continuous playback duration.
					estimatedWatchTimeMinutes: user.totalSessions * SNAPSHOT_INTERVAL_MINUTES,
					mostRecentActivity: new Date(user.mostRecentActivity).toISOString(),
					bandwidthMeasurement: {
						version: 1 as const,
						bandwidthBasis: user.bandwidthBasis,
						status:
							user.measuredSessions === 0
								? ("unavailable" as const)
								: user.measuredSessions === user.totalSessions
									? ("complete" as const)
									: ("partial" as const),
						observedSessions: user.totalSessions,
						measuredSessions: user.measuredSessions,
					},
				}))
				.sort((a, b) => b.totalSessions - a.totalSessions || a.key.localeCompare(b.key));
			const dates = new Set([...dailyMap.keys(), ...Object.keys(collectionByDate ?? {})]);
			const dailyBreakdown = [...dates].sort().map((date) => {
				const daily = dailyMap.get(date) ?? emptyDaily();
				return {
					date,
					userSessions: Object.fromEntries(
						[...daily.userSessions.entries()].sort(([a], [b]) => a.localeCompare(b)),
					),
					measurement: summarize(daily, collectionByDate?.[date]),
				};
			});
			return {
				users,
				dailyBreakdown,
				measurement,
				parseFailures: measurement.collection.invalidSnapshots + measurement.invalidDetailSnapshots,
				totalSnapshots,
			};
		},
	};
}

export function aggregateUserAnalytics(snapshots: SnapshotWithSessions[]): UserAnalyticsResult {
	const accumulator = createUserAnalyticsAccumulator();
	accumulator.addSnapshots(snapshots);
	return accumulator.getResult();
}
