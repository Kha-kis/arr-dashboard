/**
 * Quality Score Helpers
 *
 * Pure functions for computing a "stream quality score" (0-100) based on
 * direct play rate, resolution distribution, and transcode percentage.
 */

import type { QualityScoreAnalytics } from "@arr/shared";

/** Parsed session entry for quality scoring */
interface SessionEntry {
	user: string;
	videoDecision?: string | null;
	videoResolution?: string | null;
}

/** Snapshot row for quality scoring */
export interface SnapshotForQuality {
	capturedAt: Date;
	sessionsJson: string;
}

// Resolution → score mapping (higher resolution = better score)
const RESOLUTION_SCORES: Record<string, number> = {
	"4k": 100,
	"2160": 100,
	"1080": 75,
	"720": 50,
	"576": 35,
	"480": 25,
	sd: 25,
};

function getResolutionScore(resolution: string | null | undefined): number {
	if (!resolution) return 25;
	const key = resolution.toLowerCase().replace("p", "");
	return RESOLUTION_SCORES[key] ?? 25;
}

function isDirectPlay(videoDecision: string | null | undefined): boolean {
	if (!videoDecision) return false;
	const d = videoDecision.toLowerCase();
	return d === "direct play" || d === "directplay";
}

function isTranscode(videoDecision: string | null | undefined): boolean {
	return videoDecision?.toLowerCase() === "transcode";
}

/**
 * Compute quality score analytics from session snapshots.
 *
 * Overall score = weighted average of:
 *   - Direct play % (weight 40%)
 *   - Average resolution score (weight 30%)
 *   - Inverse transcode % (weight 30%)
 */
export interface QualityScoreResult extends QualityScoreAnalytics {
	parseFailures: number;
	totalSnapshots: number;
	failedPreviews: string[];
}

export function computeQualityScore(snapshots: SnapshotForQuality[]): QualityScoreResult {
	let totalDirectPlay = 0;
	let totalTranscode = 0;
	let totalSessions = 0;
	let totalResolutionScore = 0;
	let parseFailures = 0;
	const failedPreviews: string[] = [];

	const dailyMap = new Map<string, { dp: number; tc: number; resScore: number; count: number }>();
	const userMap = new Map<string, { dp: number; tc: number; resScore: number; count: number }>();

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
			totalSessions++;
			const resScore = getResolutionScore(session.videoResolution);
			totalResolutionScore += resScore;

			if (isDirectPlay(session.videoDecision)) totalDirectPlay++;
			if (isTranscode(session.videoDecision)) totalTranscode++;

			// Daily
			const day = dailyMap.get(dateKey) ?? { dp: 0, tc: 0, resScore: 0, count: 0 };
			if (isDirectPlay(session.videoDecision)) day.dp++;
			if (isTranscode(session.videoDecision)) day.tc++;
			day.resScore += resScore;
			day.count++;
			dailyMap.set(dateKey, day);

			// Per-user
			const username = session.user || "Unknown";
			const u = userMap.get(username) ?? { dp: 0, tc: 0, resScore: 0, count: 0 };
			if (isDirectPlay(session.videoDecision)) u.dp++;
			if (isTranscode(session.videoDecision)) u.tc++;
			u.resScore += resScore;
			u.count++;
			userMap.set(username, u);
		}
	}

	if (totalSessions === 0) {
		return {
			overallScore: 0,
			breakdown: { directPlayScore: 0, resolutionScore: 0, transcodeScore: 0 },
			trend: [],
			perUser: [],
			parseFailures,
			totalSnapshots: snapshots.length,
			failedPreviews,
		};
	}

	const directPlayScore = Math.round((totalDirectPlay / totalSessions) * 100);
	const resolutionScore = Math.round(totalResolutionScore / totalSessions);
	const transcodeScore = Math.round((1 - totalTranscode / totalSessions) * 100);
	const overallScore = Math.round(
		directPlayScore * 0.4 + resolutionScore * 0.3 + transcodeScore * 0.3,
	);

	function computeScore(dp: number, tc: number, resScore: number, count: number): number {
		if (count === 0) return 0;
		const dpS = (dp / count) * 100;
		const resS = resScore / count;
		const tcS = (1 - tc / count) * 100;
		return Math.round(dpS * 0.4 + resS * 0.3 + tcS * 0.3);
	}

	const trend = [...dailyMap.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([date, d]) => ({
			date,
			score: computeScore(d.dp, d.tc, d.resScore, d.count),
		}));

	const perUser = [...userMap.entries()]
		.map(([username, u]) => ({
			username,
			score: computeScore(u.dp, u.tc, u.resScore, u.count),
			sessions: u.count,
		}))
		.sort((a, b) => b.sessions - a.sessions);

	return {
		overallScore,
		breakdown: { directPlayScore, resolutionScore, transcodeScore },
		trend,
		perUser,
		parseFailures,
		totalSnapshots: snapshots.length,
		failedPreviews,
	};
}
