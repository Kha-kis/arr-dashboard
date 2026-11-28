/**
 * Plays By Date Helpers
 *
 * Aggregates SessionSnapshot rows into per-day play counts segmented by
 * media type. Replaces Tautulli's pre-aggregated `cmd=get_plays_by_date`.
 *
 * The read API exposes daily categories; no native daily chart currently
 * consumes this response in the Plex/Jellyfin statistics tabs:
 *
 *   { categories: ["2026-04-01", ...],  // full date range, ascending
 *     series: [ { name: "Movies", data: [3, 5, ...] }, ... ] }
 *
 * Each known play uses source-scoped native actor/item/session coordinates
 * (10-min sampling window), attributed to its first observed tick's date.
 * A missing display title does not invalidate independent playback evidence.
 */

import type { PlaysByDateResponse } from "@arr/shared";
import {
	type ActivitySnapshotIdentity,
	readActivityIdentity,
	readActivityReceipt,
} from "./native-activity-identity.js";

type SnapshotMediaType = "movie" | "series" | "music" | "other";
type SeriesMediaType = "movie" | "series" | "music";

/** Snapshot row required for plays-by-date aggregation */
export interface SnapshotForPlaysByDate extends ActivitySnapshotIdentity {
	capturedAt: Date;
	sessionsJson: string;
}

interface ParsedSession {
	user?: string;
	title?: string;
	grandparentTitle?: string;
	mediaType?: SnapshotMediaType;
	[key: string]: unknown;
}

const DEDUP_WINDOW_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const SERIES_NAME: Record<SeriesMediaType, string> = {
	movie: "Movies",
	series: "TV",
	music: "Music",
};

/** Format a Date as YYYY-MM-DD (UTC). Same convention as user-analytics-helpers. */
function dateKey(d: Date): string {
	return d.toISOString().split("T")[0]!;
}

export function createPlaysByDateAccumulator(opts: { days: number; now?: Date }) {
	const now = opts.now ?? new Date();
	const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	const start = new Date(today.getTime() - (opts.days - 1) * DAY_MS);

	// Build the full date range (cutoff..today, inclusive)
	const categories: string[] = [];
	for (let t = start.getTime(); t <= today.getTime(); t += DAY_MS) {
		categories.push(dateKey(new Date(t)));
	}
	const dateIndex = new Map(categories.map((d, i) => [d, i]));

	// counts[mediaType][dateIndex] = play count
	const counts: Record<SeriesMediaType, number[]> = {
		movie: new Array(categories.length).fill(0),
		series: new Array(categories.length).fill(0),
		music: new Array(categories.length).fill(0),
	};

	const lastPlayAnchorByUserKey = new Map<string, number>();
	const unidentifiedPlaybackSessions: number[] = new Array(categories.length).fill(0);
	const invalidDetailSnapshots: number[] = new Array(categories.length).fill(0);

	// Batches arrive in stable ASC order from readSessionSnapshotPages.
	function addBatch(snapshots: readonly SnapshotForPlaysByDate[]): void {
		for (const snap of snapshots) {
			const idx = dateIndex.get(dateKey(snap.capturedAt));
			if (idx === undefined) continue;
			let sessions: unknown;
			try {
				sessions = JSON.parse(snap.sessionsJson);
			} catch {
				invalidDetailSnapshots[idx]! += 1;
				continue;
			}

			// Guard against valid-but-non-iterable JSON (null, {}, number, ...).
			// Without this a corrupt row throws TypeError on for-of and aborts
			// the entire snapshot walk silently.
			if (!Array.isArray(sessions)) {
				invalidDetailSnapshots[idx]! += 1;
				continue;
			}

			const receipt = readActivityReceipt(snap, sessions.length);
			let invalidDetail =
				snap.concurrentStreams !== undefined && snap.concurrentStreams !== sessions.length;
			for (const value of sessions) {
				if (value === null || typeof value !== "object" || Array.isArray(value)) {
					invalidDetail = true;
					continue;
				}
				const session = value as ParsedSession;
				const mt = session.mediaType;
				// Explicit other media is outside these three categories; an absent
				// or invalid category cannot establish that any category was idle.
				if (mt === "other") continue;
				if (mt !== "movie" && mt !== "series" && mt !== "music") {
					invalidDetail = true;
					continue;
				}

				const userKey = readActivityIdentity(snap, session, receipt).playback;
				if (!userKey) {
					unidentifiedPlaybackSessions[idx]! += 1;
					continue;
				}
				const tickTime = snap.capturedAt.getTime();
				const prevAnchor = lastPlayAnchorByUserKey.get(userKey);
				const isNewPlay = prevAnchor === undefined || tickTime - prevAnchor > DEDUP_WINDOW_MS;

				if (isNewPlay) {
					counts[mt][idx] = (counts[mt][idx] ?? 0) + 1;
				}
				lastPlayAnchorByUserKey.set(userKey, tickTime);
			}
			if (invalidDetail) invalidDetailSnapshots[idx]! += 1;
		}
	}

	function getResult(): PlaysByDateResponse {
		const series = (["movie", "series", "music"] as const).map((mt) => ({
			name: SERIES_NAME[mt],
			data: counts[mt],
		}));

		return { categories, series, unidentifiedPlaybackSessions, invalidDetailSnapshots };
	}

	return { addBatch, getResult };
}

export function aggregatePlaysByDate(
	snapshots: SnapshotForPlaysByDate[],
	opts: { days: number; now?: Date },
): PlaysByDateResponse {
	const accumulator = createPlaysByDateAccumulator(opts);
	// Keep the public array helper tolerant of unsorted callers as before.
	accumulator.addBatch(
		[...snapshots].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime()),
	);
	return accumulator.getResult();
}
