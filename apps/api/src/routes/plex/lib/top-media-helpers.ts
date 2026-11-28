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
import {
	type ActivitySnapshotIdentity,
	readActivityIdentity,
	readActivityReceipt,
} from "./native-activity-identity.js";
import type { AggregationMeta } from "./user-analytics-helpers.js";

/** Normalized media type as stored in EnrichedSession.mediaType */
type SnapshotMediaType = "movie" | "series" | "music" | "other";

/** Snapshot row required for media aggregation */
export interface SnapshotForTopMedia extends ActivitySnapshotIdentity {
	capturedAt: Date;
	sessionsJson: string;
}

/** Session shape parsed out of sessionsJson — fields newer than 2026-04 are optional for backward compat */
interface ParsedSession {
	user?: string;
	title?: string;
	grandparentTitle?: string;
	mediaType?: SnapshotMediaType;
	[key: string]: unknown;
}

/** Internal aggregate row before sort/slice/projection to TopMediaItem */
interface AggregatedItem {
	title: string;
	mediaType: TopMediaType;
	playCount: number;
	distinctUsers: Set<string>;
	unattributedSessions: number;
	unidentifiedPlaybackSessions: number;
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
	const title =
		session.mediaType === "series" ? (session.grandparentTitle ?? session.title) : session.title;
	return typeof title === "string" && title.trim() ? title : null;
}

/** Project an internal aggregate row into the public TopMediaItem shape. */
function projectItem(item: AggregatedItem): TopMediaItem {
	return {
		title: item.title,
		mediaType: item.mediaType,
		playCount: item.playCount,
		distinctUserCount: item.distinctUsers.size,
		unattributedSessions: item.unattributedSessions,
		unidentifiedPlaybackSessions: item.unidentifiedPlaybackSessions,
		totalDurationMinutes: item.tickCount * SNAPSHOT_INTERVAL_MINUTES,
		lastWatchedAt: item.lastWatchedAt.toISOString(),
	};
}

export type TopMediaRanking = "top" | "popular" | "last-watched";

export interface TopMediaAccumulator {
	addBatch(snapshots: readonly SnapshotForTopMedia[]): void;
	getResult(ranking: TopMediaRanking, limit: number): TopMediaResponse & AggregationMeta;
}

/** Incremental title aggregates for stable reverse-chronological snapshot pages. */
export function createTopMediaAccumulator(mediaType: TopMediaType): TopMediaAccumulator {
	const itemMap = new Map<string, AggregatedItem>();
	const lastPlayAnchorByUserKey = new Map<string, number>();
	let parseFailures = 0;
	let totalSnapshots = 0;
	const failedPreviews: string[] = [];

	function addBatch(snapshots: readonly SnapshotForTopMedia[]): void {
		totalSnapshots += snapshots.length;
		for (const snap of snapshots) {
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

			const receipt = readActivityReceipt(snap, sessions.length);
			for (const value of sessions) {
				if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
				const session = value as ParsedSession;
				// Skip rows missing the new fields (snapshots written before 2026-04 enrichment)
				if (session.mediaType === undefined || session.mediaType !== mediaType) continue;

				const groupingTitle = deriveGroupingTitle(session);
				if (!groupingTitle) continue;

				const identity = readActivityIdentity(snap, session, receipt);
				const userKey = identity.playback;
				const tickTime = snap.capturedAt.getTime();

				const existingItem = itemMap.get(groupingTitle) ?? {
					title: groupingTitle,
					mediaType,
					playCount: 0,
					distinctUsers: new Set<string>(),
					unattributedSessions: 0,
					unidentifiedPlaybackSessions: 0,
					tickCount: 0,
					lastWatchedAt: snap.capturedAt,
				};

				existingItem.tickCount += 1;
				if (identity.actor) existingItem.distinctUsers.add(identity.actor);
				else existingItem.unattributedSessions++;
				if (!userKey) existingItem.unidentifiedPlaybackSessions++;
				if (snap.capturedAt > existingItem.lastWatchedAt) {
					existingItem.lastWatchedAt = snap.capturedAt;
				}

				const prevAnchor = userKey ? lastPlayAnchorByUserKey.get(userKey) : undefined;
				const isNewPlay = prevAnchor === undefined || prevAnchor - tickTime > DEDUP_WINDOW_MS;

				if (userKey && isNewPlay) {
					existingItem.playCount += 1;
				}
				// Either way, refresh the anchor so chained ticks keep collapsing
				if (userKey) lastPlayAnchorByUserKey.set(userKey, tickTime);

				itemMap.set(groupingTitle, existingItem);
			}
		}
	}

	function getResult(ranking: TopMediaRanking, limit: number): TopMediaResponse & AggregationMeta {
		const items = [...itemMap.values()];
		const sorted = items
			.sort((a, b) => {
				if (ranking === "top") {
					if (b.playCount !== a.playCount) return b.playCount - a.playCount;
					return b.tickCount - a.tickCount;
				}
				if (ranking === "popular") {
					const aUsers = a.distinctUsers.size;
					const bUsers = b.distinctUsers.size;
					if (bUsers !== aUsers) return bUsers - aUsers;
					return b.playCount - a.playCount;
				}
				return b.lastWatchedAt.getTime() - a.lastWatchedAt.getTime();
			})
			.slice(0, limit)
			.map(projectItem);

		return {
			items: sorted,
			parseFailures,
			totalSnapshots,
			failedPreviews,
		};
	}

	return { addBatch, getResult };
}

function withAllSnapshots(
	snapshots: SnapshotForTopMedia[],
	mediaType: TopMediaType,
	ranking: TopMediaRanking,
	limit: number,
): TopMediaResponse & AggregationMeta {
	const accumulator = createTopMediaAccumulator(mediaType);
	accumulator.addBatch(
		[...snapshots].sort((left, right) => right.capturedAt.getTime() - left.capturedAt.getTime()),
	);
	return accumulator.getResult(ranking, limit);
}

/** Top media by total play count; ties are broken by aggregate duration. */
export function aggregateTopMedia(
	snapshots: SnapshotForTopMedia[],
	opts: { mediaType: TopMediaType; limit: number },
): TopMediaResponse & AggregationMeta {
	return withAllSnapshots(snapshots, opts.mediaType, "top", opts.limit);
}

/** Popular media by distinct watcher count, with play count as the tie-breaker. */
export function aggregatePopularMedia(
	snapshots: SnapshotForTopMedia[],
	opts: { mediaType: TopMediaType; limit: number },
): TopMediaResponse & AggregationMeta {
	return withAllSnapshots(snapshots, opts.mediaType, "popular", opts.limit);
}

/** Recently watched titles deduped by title and sorted by latest activity. */
export function aggregateLastWatched(
	snapshots: SnapshotForTopMedia[],
	opts: { mediaType: TopMediaType; limit: number },
): TopMediaResponse & AggregationMeta {
	return withAllSnapshots(snapshots, opts.mediaType, "last-watched", opts.limit);
}
