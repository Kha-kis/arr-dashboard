/**
 * Top Media + Popular Media Helpers
 *
 * Aggregates SessionSnapshot rows into leaderboards of most-watched titles,
 * bucketed by media type. Replaces Tautulli's pre-aggregated home-stats:
 *
 *   - aggregateTopMedia    → cmd=get_home_stats top_movies / top_tv / top_music
 *                            (sorted by total play count)
 *   - aggregatePopularMedia → cmd=get_home_stats popular_movies / popular_tv / popular_music
 *                            (sorted by distinct watcher count)
 *
 * Both helpers share the same internal aggregator — they only differ in
 * sort order, so adding new metrics (e.g. "longest watched" by total minutes)
 * is a one-liner.
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

/** Snapshot row required for media aggregation */
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

/** Internal aggregate row before sort/slice/projection to TopMediaItem */
interface AggregatedItem {
	title: string;
	mediaType: TopMediaType;
	playCount: number;
	distinctUsers: Set<string>;
	tickCount: number;
	lastWatchedAt: Date;
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

/** Project an internal aggregate row into the public TopMediaItem shape. */
function projectItem(item: AggregatedItem): TopMediaItem {
	return {
		title: item.title,
		mediaType: item.mediaType,
		playCount: item.playCount,
		distinctUserCount: item.distinctUsers.size,
		totalDurationMinutes: item.tickCount * SNAPSHOT_INTERVAL_MINUTES,
		lastWatchedAt: item.lastWatchedAt.toISOString(),
	};
}

/**
 * Walk snapshots once and build a Map<groupingTitle, AggregatedItem>. Both
 * aggregateTopMedia and aggregatePopularMedia consume this output and only
 * differ in how they sort the resulting items.
 */
function buildMediaAggregate(
	snapshots: SnapshotForTopMedia[],
	mediaType: TopMediaType,
): { items: AggregatedItem[]; meta: AggregationMeta } {
	const itemMap = new Map<string, AggregatedItem>();
	const lastPlayAnchorByUserKey = new Map<string, number>();
	let parseFailures = 0;
	const failedPreviews: string[] = [];

	// Sort snapshots descending so dedup walks "newest first" (matches watch-history pattern)
	const ordered = [...snapshots].sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime());

	for (const snap of ordered) {
		let sessions: unknown;
		try {
			sessions = JSON.parse(snap.sessionsJson);
		} catch {
			parseFailures++;
			continue;
		}

		// JSON.parse can return any valid JSON value (null, object, number, ...)
		// — guard against non-iterable shapes so a corrupt row doesn't TypeError
		// and abort the whole snapshot walk silently.
		if (!Array.isArray(sessions)) {
			parseFailures++;
			continue;
		}

		for (const session of sessions as ParsedSession[]) {
			// Skip rows missing the new fields (snapshots written before 2026-04 enrichment)
			if (session.mediaType === undefined || session.mediaType !== mediaType) continue;

			const groupingTitle = deriveGroupingTitle(session);
			if (!groupingTitle) continue;

			const user = session.user ?? "Unknown";
			const userKey = `${groupingTitle}::${user}`;
			const tickTime = snap.capturedAt.getTime();

			const existingItem = itemMap.get(groupingTitle) ?? {
				title: groupingTitle,
				mediaType,
				playCount: 0,
				distinctUsers: new Set<string>(),
				tickCount: 0,
				lastWatchedAt: snap.capturedAt,
			};

			existingItem.tickCount += 1;
			existingItem.distinctUsers.add(user);
			if (snap.capturedAt > existingItem.lastWatchedAt) {
				existingItem.lastWatchedAt = snap.capturedAt;
			}

			const prevAnchor = lastPlayAnchorByUserKey.get(userKey);
			const isNewPlay = prevAnchor === undefined || prevAnchor - tickTime > DEDUP_WINDOW_MS;

			if (isNewPlay) {
				existingItem.playCount += 1;
			}
			// Either way, refresh the anchor so chained ticks keep collapsing
			lastPlayAnchorByUserKey.set(userKey, tickTime);

			itemMap.set(groupingTitle, existingItem);
		}
	}

	return {
		items: [...itemMap.values()],
		meta: { parseFailures, totalSnapshots: snapshots.length, failedPreviews },
	};
}

/**
 * Top media by total play count. Ties broken by total duration so a title
 * watched longer in aggregate ranks above an equally-played but shorter one.
 */
export function aggregateTopMedia(
	snapshots: SnapshotForTopMedia[],
	opts: { mediaType: TopMediaType; limit: number },
): TopMediaResponse & AggregationMeta {
	const { items, meta } = buildMediaAggregate(snapshots, opts.mediaType);
	const sorted = items
		.sort((a, b) => {
			if (b.playCount !== a.playCount) return b.playCount - a.playCount;
			return b.tickCount - a.tickCount;
		})
		.slice(0, opts.limit)
		.map(projectItem);

	return { items: sorted, ...meta };
}

/**
 * Popular media by distinct watcher count. Ties broken by play count so
 * a title with the same audience size but more rewatching ranks higher.
 */
export function aggregatePopularMedia(
	snapshots: SnapshotForTopMedia[],
	opts: { mediaType: TopMediaType; limit: number },
): TopMediaResponse & AggregationMeta {
	const { items, meta } = buildMediaAggregate(snapshots, opts.mediaType);
	const sorted = items
		.sort((a, b) => {
			const aUsers = a.distinctUsers.size;
			const bUsers = b.distinctUsers.size;
			if (bUsers !== aUsers) return bUsers - aUsers;
			return b.playCount - a.playCount;
		})
		.slice(0, opts.limit)
		.map(projectItem);

	return { items: sorted, ...meta };
}

/**
 * Most recently watched media (deduped by title). Mirrors Tautulli's
 * `last_watched` home stat — answers "what did anyone watch most recently?"
 * Distinct from WatchHistoryResponse, which is event-level (per user×title).
 */
export function aggregateLastWatched(
	snapshots: SnapshotForTopMedia[],
	opts: { mediaType: TopMediaType; limit: number },
): TopMediaResponse & AggregationMeta {
	const { items, meta } = buildMediaAggregate(snapshots, opts.mediaType);
	const sorted = items
		.sort((a, b) => b.lastWatchedAt.getTime() - a.lastWatchedAt.getTime())
		.slice(0, opts.limit)
		.map(projectItem);

	return { items: sorted, ...meta };
}
