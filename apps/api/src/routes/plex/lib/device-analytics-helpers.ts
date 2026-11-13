/**
 * Device Analytics Helpers
 *
 * Pure functions for aggregating platform and player distributions
 * from SessionSnapshot data.
 */

import type {
	DeviceAnalytics,
	DeviceAnalyticsMeasurementSummary,
	SnapshotCollectionCoverage,
} from "@arr/shared";
import { parseSessionSnapshotMeasurement } from "../../../plugins/lib/session-snapshot-measurements.js";

/** Snapshot row for device analysis */
export interface SnapshotForDevice {
	sessionsJson: string;
	concurrentStreams?: number;
	measurementJson?: string | null;
}

/**
 * Aggregate device/platform analytics from session snapshots.
 * Fields missing from pre-enrichment snapshots are counted as "unknown".
 */
export interface DeviceAggregationResult extends DeviceAnalytics {
	measurement: DeviceAnalyticsMeasurementSummary;
	parseFailures: number;
	totalSnapshots: number;
	failedPreviews: string[];
}

export interface DeviceAnalyticsAccumulator {
	addSnapshots(snapshots: readonly SnapshotForDevice[]): void;
	getResult(collection?: SnapshotCollectionCoverage): DeviceAggregationResult;
}

function label(value: unknown): string {
	if (typeof value !== "string" || /\p{Cc}/u.test(value)) return "unknown";
	const normalized = value.trim();
	return normalized.length > 0 && normalized.length <= 256 && normalized.toLowerCase() !== "unknown"
		? normalized
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

export function createDeviceAnalyticsAccumulator(): DeviceAnalyticsAccumulator {
	const platformMap = new Map<string, number>();
	const playerMap = new Map<string, { player: string; platform: string; sessions: number }>();
	let totalSessions = 0;
	let platformMeasuredSessions = 0;
	let playerMeasuredSessions = 0;
	let invalidDetailSnapshots = 0;
	let unverifiedPlatformSnapshots = 0;
	const axes = new Set<"platform" | "client">();
	const ownCollection: SnapshotCollectionCoverage = {
		activeSnapshots: 0,
		idleSnapshots: 0,
		failedSnapshots: 0,
		legacySnapshots: 0,
		invalidSnapshots: 0,
	};
	const add = (platform: string, player: string, count = 1) => {
		if (count === 0) return;
		platformMap.set(platform, (platformMap.get(platform) ?? 0) + count);
		const key = JSON.stringify([player, platform]);
		const entry = playerMap.get(key) ?? { player, platform, sessions: 0 };
		entry.sessions += count;
		playerMap.set(key, entry);
	};

	return {
		addSnapshots(snapshots) {
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
				const sessions = parseRows(snap.sessionsJson);
				if (parsed.status === "legacy") {
					const count = snap.concurrentStreams ?? sessions?.length;
					if (count === undefined) {
						ownCollection.invalidSnapshots++;
						continue;
					}
					ownCollection.legacySnapshots++;
					totalSessions += count;
					add("unknown", "unknown", count);
					if (sessions === null || sessions.length !== count) invalidDetailSnapshots++;
					continue;
				}
				const receipt = parsed.measurement;
				axes.add(receipt.provider === "PLEX" ? "platform" : "client");
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
				const platformVerified =
					receipt.provider === "PLEX" || receipt.deviceLabelAxis === "client";
				if (!platformVerified) unverifiedPlatformSnapshots++;
				if (sessions === null || sessions.length !== receipt.observedSessions) {
					invalidDetailSnapshots++;
					add("unknown", "unknown", receipt.observedSessions);
					continue;
				}
				let invalidDetail = false;
				for (const row of sessions) {
					const session =
						row !== null && typeof row === "object" && !Array.isArray(row)
							? (row as Record<string, unknown>)
							: null;
					if (session === null) invalidDetail = true;
					const platform = platformVerified ? label(session?.platform) : "unknown";
					const player = label(session?.player);
					add(platform, player);
					if (platform !== "unknown") platformMeasuredSessions++;
					if (player !== "unknown") playerMeasuredSessions++;
				}
				if (invalidDetail) invalidDetailSnapshots++;
			}
		},
		getResult(collection = ownCollection) {
			const platforms = [...platformMap.entries()]
				.map(([platform, sessions]) => ({
					platform,
					sessions,
					percent: totalSessions > 0 ? Math.round((sessions / totalSessions) * 1000) / 10 : 0,
				}))
				.sort((a, b) => b.sessions - a.sessions);

			const players = [...playerMap.values()]
				.map((data) => ({ ...data }))
				.sort((a, b) => b.sessions - a.sessions);

			return {
				platforms,
				players,
				totalSessions,
				measurement: {
					version: 1,
					status:
						platformMeasuredSessions + playerMeasuredSessions === 0
							? "unavailable"
							: platformMeasuredSessions === totalSessions &&
									playerMeasuredSessions === totalSessions &&
									invalidDetailSnapshots === 0 &&
									unverifiedPlatformSnapshots === 0 &&
									collection.failedSnapshots === 0 &&
									collection.legacySnapshots === 0 &&
									collection.invalidSnapshots === 0
								? "complete"
								: "partial",
					observedSessions: totalSessions,
					platformMeasuredSessions,
					playerMeasuredSessions,
					platformAxis: axes.size > 1 ? "mixed" : (axes.values().next().value ?? "unverified"),
					invalidDetailSnapshots,
					unverifiedPlatformSnapshots,
					collection: { ...collection },
				},
				parseFailures: collection.invalidSnapshots + invalidDetailSnapshots,
				totalSnapshots: Object.values(collection).reduce((sum, count) => sum + count, 0),
				failedPreviews: [],
			};
		},
	};
}

export function aggregateDeviceAnalytics(snapshots: SnapshotForDevice[]): DeviceAggregationResult {
	const accumulator = createDeviceAnalyticsAccumulator();
	accumulator.addSnapshots(snapshots);
	return accumulator.getResult();
}
