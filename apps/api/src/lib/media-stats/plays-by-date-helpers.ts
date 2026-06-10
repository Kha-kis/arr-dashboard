/**
 * Plays By Date Helpers
 *
 * Aggregates SessionSnapshot rows into per-day play counts segmented by
 * media type. Replaces Tautulli's pre-aggregated `cmd=get_plays_by_date`.
 *
 * Output shape mirrors Tautulli's so PlexTab's existing sparkline rendering
 * can consume it without changes:
 *
 *   { categories: ["2026-04-01", ...],  // full date range, ascending
 *     series: [ { name: "Movies", data: [3, 5, ...] }, ... ] }
 *
 * Each "play" is a deduped user×title viewing session (10-min window),
 * attributed to the date of its first observed tick.
 */

import type { PlaysByDateResponse } from "@arr/shared";

type SnapshotMediaType = "movie" | "series" | "music" | "other";
type SeriesMediaType = "movie" | "series" | "music";

/** Snapshot row required for plays-by-date aggregation */
export interface SnapshotForPlaysByDate {
	capturedAt: Date;
	sessionsJson: string;
}

interface ParsedSession {
	user?: string;
	title?: string;
	grandparentTitle?: string;
	mediaType?: SnapshotMediaType;
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

function deriveGroupingTitle(session: ParsedSession): string | null {
	if (session.mediaType === "series") {
		return session.grandparentTitle ?? session.title ?? null;
	}
	return session.title ?? null;
}

export function aggregatePlaysByDate(
	snapshots: SnapshotForPlaysByDate[],
	opts: { days: number; now?: Date },
): PlaysByDateResponse {
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

	// Walk snapshots ASC so the dedup anchor moves forward in time
	const ordered = [...snapshots].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());

	for (const snap of ordered) {
		let sessions: unknown;
		try {
			sessions = JSON.parse(snap.sessionsJson);
		} catch {
			continue;
		}

		// Guard against valid-but-non-iterable JSON (null, {}, number, ...).
		// Without this a corrupt row throws TypeError on for-of and aborts
		// the entire snapshot walk silently.
		if (!Array.isArray(sessions)) continue;

		const idx = dateIndex.get(dateKey(snap.capturedAt));
		if (idx === undefined) continue; // outside the window

		for (const session of sessions as ParsedSession[]) {
			const mt = session.mediaType;
			if (mt !== "movie" && mt !== "series" && mt !== "music") continue;

			const groupingTitle = deriveGroupingTitle(session);
			if (!groupingTitle) continue;

			const userKey = `${groupingTitle}::${session.user ?? "Unknown"}`;
			const tickTime = snap.capturedAt.getTime();
			const prevAnchor = lastPlayAnchorByUserKey.get(userKey);
			const isNewPlay = prevAnchor === undefined || tickTime - prevAnchor > DEDUP_WINDOW_MS;

			if (isNewPlay) {
				counts[mt][idx] = (counts[mt][idx] ?? 0) + 1;
			}
			lastPlayAnchorByUserKey.set(userKey, tickTime);
		}
	}

	const series = (["movie", "series", "music"] as const).map((mt) => ({
		name: SERIES_NAME[mt],
		data: counts[mt],
	}));

	return { categories, series };
}
