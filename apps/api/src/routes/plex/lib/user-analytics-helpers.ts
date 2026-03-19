/**
 * User Analytics Helpers
 *
 * Pure functions for aggregating per-user analytics from SessionSnapshot data.
 */

import type { UserAnalytics } from "@arr/shared";

/** Parsed session entry from sessionsJson */
interface SessionEntry {
	user: string;
	title: string;
	bandwidth: number;
	state: string;
	videoDecision?: string | null;
	platform?: string | null;
}

/** Snapshot row with parsed sessions */
export interface SnapshotWithSessions {
	capturedAt: Date;
	sessionsJson: string;
}

const SNAPSHOT_INTERVAL_MINUTES = 5;

/**
 * Aggregate user analytics from session snapshots.
 * Each snapshot represents a 5-minute tick, so session count approximates watch time.
 */
export interface AggregationMeta {
	parseFailures: number;
	totalSnapshots: number;
	failedPreviews: string[];
}

export function aggregateUserAnalytics(
	snapshots: SnapshotWithSessions[],
): UserAnalytics & AggregationMeta {
	const userMap = new Map<
		string,
		{
			totalSessions: number;
			totalBandwidth: number;
			mostRecentActivity: Date;
		}
	>();

	const dailyMap = new Map<string, Map<string, number>>();
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

		const dateKey = snap.capturedAt.toISOString().split("T")[0]!;

		for (const session of sessions) {
			const username = session.user || "Unknown";

			// Per-user aggregation
			const existing = userMap.get(username) ?? {
				totalSessions: 0,
				totalBandwidth: 0,
				mostRecentActivity: new Date(0),
			};
			existing.totalSessions++;
			existing.totalBandwidth += session.bandwidth ?? 0;
			if (snap.capturedAt > existing.mostRecentActivity) {
				existing.mostRecentActivity = snap.capturedAt;
			}
			userMap.set(username, existing);

			// Daily breakdown
			if (!dailyMap.has(dateKey)) dailyMap.set(dateKey, new Map());
			const dayUsers = dailyMap.get(dateKey)!;
			dayUsers.set(username, (dayUsers.get(username) ?? 0) + 1);
		}
	}

	const users = [...userMap.entries()]
		.map(([username, data]) => ({
			username,
			totalSessions: data.totalSessions,
			totalBandwidth: data.totalBandwidth,
			estimatedWatchTimeMinutes: data.totalSessions * SNAPSHOT_INTERVAL_MINUTES,
			mostRecentActivity: data.mostRecentActivity.toISOString(),
		}))
		.sort((a, b) => b.totalSessions - a.totalSessions);

	const dailyBreakdown = [...dailyMap.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([date, userSessions]) => ({
			date,
			userSessions: Object.fromEntries(userSessions),
		}));

	return { users, dailyBreakdown, parseFailures, totalSnapshots: snapshots.length, failedPreviews };
}
