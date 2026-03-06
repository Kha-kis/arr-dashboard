/**
 * Device Analytics Helpers
 *
 * Pure functions for aggregating platform and player distributions
 * from SessionSnapshot data.
 */

import type { DeviceAnalytics } from "@arr/shared";

/** Parsed session entry with platform/player fields */
interface SessionEntry {
	platform?: string | null;
	player?: string | null;
}

/** Snapshot row for device analysis */
export interface SnapshotForDevice {
	sessionsJson: string;
}

/**
 * Aggregate device/platform analytics from session snapshots.
 * Fields missing from pre-enrichment snapshots are counted as "unknown".
 */
export interface DeviceAggregationResult extends DeviceAnalytics {
	parseFailures: number;
	totalSnapshots: number;
	failedPreviews: string[];
}

export function aggregateDeviceAnalytics(snapshots: SnapshotForDevice[]): DeviceAggregationResult {
	const platformMap = new Map<string, number>();
	const playerMap = new Map<string, { platform: string; sessions: number }>();
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

			const platform = session.platform || "unknown";
			platformMap.set(platform, (platformMap.get(platform) ?? 0) + 1);

			const player = session.player || "unknown";
			const playerKey = `${player}::${platform}`;
			const existing = playerMap.get(playerKey) ?? { platform, sessions: 0 };
			existing.sessions++;
			playerMap.set(playerKey, existing);
		}
	}

	const platforms = [...platformMap.entries()]
		.map(([platform, sessions]) => ({
			platform,
			sessions,
			percent: totalSessions > 0 ? Math.round((sessions / totalSessions) * 1000) / 10 : 0,
		}))
		.sort((a, b) => b.sessions - a.sessions);

	const playersFixed = [...playerMap.entries()]
		.map(([key, data]) => ({
			player: key.split("::")[0]!,
			platform: data.platform,
			sessions: data.sessions,
		}))
		.sort((a, b) => b.sessions - a.sessions);

	return { platforms, players: playersFixed, totalSessions, parseFailures, totalSnapshots: snapshots.length, failedPreviews };
}
