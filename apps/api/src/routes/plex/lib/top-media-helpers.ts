/**
 * Top Media Helpers
 *
 * Aggregates SessionSnapshot rows into a leaderboard of most-watched titles,
 * bucketed by media type. Replaces Tautulli's pre-aggregated `cmd=get_home_stats`
 * top_* values, so this surface works with or without Tautulli configured.
 *
 * "Play count" semantics match Tautulli: each user×title viewing session
 * counts as one play. Consecutive 5-minute snapshot ticks within a 10-minute
 * window are collapsed into a single play (per the same dedup pattern as
 * watch-history-helpers.ts).
 */

import type { TopMediaItem, TopMediaResponse, TopMediaType } from "@arr/shared";
import type { AggregationMeta } from "./user-analytics-helpers.js";

/** Normalized media type as stored in EnrichedSession.mediaType */
type SnapshotMediaType = "movie" | "series" | "music" | "other";

/** Snapshot row required for top-media aggregation */
export interface SnapshotForTopMedia {
	capturedAt: Date;
	sessionsJson: string;
}

/** Session shape parsed out of sessionsJson — fields newer than 2026-04 are optional for backward compat */
interface ParsedSession {
	user?: string;
	title?: string;
	grandparentTitle?: string;
	mediaType?: SnapshotMediaType;
}

/** Snapshot interval in minutes — used to estimate watch duration from tick count */
const SNAPSHOT_INTERVAL_MINUTES = 5;

/** Dedup window: consecutive ticks for same user+title within this window are one play */
const DEDUP_WINDOW_MS = 10 * 60 * 1000;

/**
 * Pick the title to group by:
 * - For TV episodes: use grandparentTitle (show name) so all episodes of a show aggregate together
 * - For movies/music/other: use title directly
 */
function deriveGroupingTitle(session: ParsedSession): string | null {
	if (session.mediaType === "series") {
		return session.grandparentTitle ?? session.title ?? null;
	}
	return session.title ?? null;
}

export function aggregateTopMedia(
	snapshots: SnapshotForTopMedia[],
	opts: { mediaType: TopMediaType; limit: number },
): TopMediaResponse & AggregationMeta {
	const { mediaType, limit } = opts;

	// Per-key aggregation: groupKey = `${mediaType}|${groupingTitle}`
	const itemMap = new Map<
		string,
		{
			title: string;
			mediaType: TopMediaType;
			playCount: number;
			tickCount: number;
			lastWatchedAt: Date;
		}
	>();

	// Per (key, user) dedup state — anchors the most recent emitted timestamp so
	// chained ticks within the dedup window collapse into one play.
	const lastPlayAnchorByUserKey = new Map<string, number>();

	let parseFailures = 0;
	const failedPreviews: string[] = [];

	// Sort snapshots descending so dedup walks "newest first" (matches watch-history pattern)
	const ordered = [...snapshots].sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime());

	for (const snap of ordered) {
		let sessions: ParsedSession[];
		try {
			sessions = JSON.parse(snap.sessionsJson);
		} catch {
			parseFailures++;
			if (failedPreviews.length < 5) failedPreviews.push(snap.sessionsJson.slice(0, 100));
			continue;
		}

		for (const session of sessions) {
			// Skip rows missing the new fields (snapshots written before 2026-04 enrichment)
			if (session.mediaType === undefined || session.mediaType !== mediaType) continue;

			const groupingTitle = deriveGroupingTitle(session);
			if (!groupingTitle) continue;

			const user = session.user ?? "Unknown";
			const groupKey = groupingTitle; // mediaType already filtered above
			const userKey = `${groupKey}::${user}`;
			const tickTime = snap.capturedAt.getTime();

			const existingItem = itemMap.get(groupKey) ?? {
				title: groupingTitle,
				mediaType,
				playCount: 0,
				tickCount: 0,
				lastWatchedAt: snap.capturedAt,
			};

			// Always increment tick count (used for duration estimate)
			existingItem.tickCount += 1;
			if (snap.capturedAt > existingItem.lastWatchedAt) {
				existingItem.lastWatchedAt = snap.capturedAt;
			}

			// Determine whether this tick starts a new play for this user
			const prevAnchor = lastPlayAnchorByUserKey.get(userKey);
			const isNewPlay = prevAnchor === undefined || prevAnchor - tickTime > DEDUP_WINDOW_MS;

			if (isNewPlay) {
				existingItem.playCount += 1;
				lastPlayAnchorByUserKey.set(userKey, tickTime);
			} else {
				// Within dedup window — extend the anchor backward so chained ticks keep collapsing
				lastPlayAnchorByUserKey.set(userKey, tickTime);
			}

			itemMap.set(groupKey, existingItem);
		}
	}

	const items: TopMediaItem[] = [...itemMap.values()]
		.sort((a, b) => {
			if (b.playCount !== a.playCount) return b.playCount - a.playCount;
			return b.tickCount - a.tickCount;
		})
		.slice(0, limit)
		.map((item) => ({
			title: item.title,
			mediaType: item.mediaType,
			playCount: item.playCount,
			totalDurationMinutes: item.tickCount * SNAPSHOT_INTERVAL_MINUTES,
			lastWatchedAt: item.lastWatchedAt.toISOString(),
		}));

	return {
		items,
		parseFailures,
		totalSnapshots: snapshots.length,
		failedPreviews,
	};
}
