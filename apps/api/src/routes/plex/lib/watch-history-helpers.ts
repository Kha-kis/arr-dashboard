/**
 * Watch History Helpers
 *
 * Pure functions for deduplicating consecutive session entries into
 * discrete watch events from SessionSnapshot data.
 */

import type { WatchHistoryEvent } from "@arr/shared";

/** Raw session entry parsed from sessionsJson, with a timestamp from the snapshot */
export interface RawWatchEvent {
	user: string;
	title: string;
	timestamp: Date;
	platform: string | null;
	videoDecision: string | null;
}

/** Snapshot row for watch history extraction */
export interface SnapshotForHistory {
	capturedAt: Date;
	sessionsJson: string;
}

/**
 * Extract and deduplicate watch events from session snapshots.
 *
 * Consecutive 5-minute ticks for the same user+title are collapsed into
 * a single event (the most recent timestamp), since they represent one
 * continuous viewing session rather than separate plays.
 */
export interface WatchHistoryResult {
	events: WatchHistoryEvent[];
	parseFailures: number;
	totalSnapshots: number;
	failedPreviews: string[];
}

export function deduplicateWatchEvents(
	snapshots: SnapshotForHistory[],
	limit: number,
): WatchHistoryResult {
	// Flatten all snapshots into raw events, ordered by time DESC
	const rawEvents: RawWatchEvent[] = [];
	let parseFailures = 0;
	const failedPreviews: string[] = [];

	for (const snap of snapshots) {
		let sessions: Array<{
			user: string;
			title: string;
			platform?: string | null;
			videoDecision?: string | null;
		}>;
		try {
			sessions = JSON.parse(snap.sessionsJson);
		} catch {
			parseFailures++;
			if (failedPreviews.length < 5) failedPreviews.push(snap.sessionsJson.slice(0, 100));
			continue;
		}

		for (const session of sessions) {
			rawEvents.push({
				user: session.user || "Unknown",
				title: session.title || "Unknown",
				timestamp: snap.capturedAt,
				platform: session.platform ?? null,
				videoDecision: session.videoDecision ?? null,
			});
		}
	}

	// Sort by timestamp DESC (most recent first)
	rawEvents.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

	// Deduplicate: collapse consecutive entries for same user+title
	// "Consecutive" = within 10 minutes (2x the 5-minute interval, to handle jitter)
	const DEDUP_WINDOW_MS = 10 * 60 * 1000;
	const deduped: WatchHistoryEvent[] = [];
	const lastSeen = new Map<string, number>(); // key → last timestamp

	for (const event of rawEvents) {
		const key = `${event.user}::${event.title}`;
		const prevTime = lastSeen.get(key);
		const eventTime = event.timestamp.getTime();

		if (prevTime !== undefined && prevTime - eventTime <= DEDUP_WINDOW_MS) {
			// Within dedup window — keep anchor at the most recent emitted event
			// so the window chains correctly across multiple ticks
			continue;
		}

		lastSeen.set(key, eventTime);
		deduped.push({
			user: event.user,
			title: event.title,
			timestamp: event.timestamp.toISOString(),
			platform: event.platform,
			videoDecision: event.videoDecision,
		});

		if (deduped.length >= limit) break;
	}

	return { events: deduped, parseFailures, totalSnapshots: snapshots.length, failedPreviews };
}
