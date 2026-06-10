/**
 * Central catalog of background jobs the API process runs.
 *
 * Each entry below is the authoritative metadata for one scheduler. This file
 * is the single source of truth for job ids — constants are exported so that
 * scheduler plugins (and `registry.track()` call sites) reference the same
 * string, eliminating the class of bugs where the registry and the telemetry
 * surface drift apart.
 *
 * Concurrency notes belong in the `description` field and summarize the lock
 * model the plugin enforces today. The registry itself only enforces `serial`;
 * the other values are informational for operator UIs.
 */

import type { JobDefinition } from "./scheduler-registry.js";

// Stable ids — reference these from plugins and tests instead of bare strings.
export const JOB_ID = {
	backup: "backup",
	sessionCleanup: "session-cleanup",
	sessionSnapshot: "session-snapshot",
	librarySync: "library-sync",
	hunting: "hunting",
	queueCleaner: "queue-cleaner",
	libraryCleanup: "library-cleanup",
	insightsDigest: "insights-digest",
	trashBackupCleanup: "trash-backup-cleanup",
	trashUpdate: "trash-update",
	trashSync: "trash-sync",
	plexCache: "plex-cache",
	plexEpisodeCache: "plex-episode-cache",
	jellyfinCache: "jellyfin-cache",
	jellyfinEpisodeCache: "jellyfin-episode-cache",
	seerrHealth: "seerr-health",
	labelSync: "label-sync",
	autoTag: "auto-tag",
	tmdbListCache: "tmdb-list-cache",
	traktListCache: "trakt-list-cache",
	quiTorrentStateSync: "qui-torrent-state-sync",
	infoHashBackfill: "infohash-backfill",
} as const;

export const KNOWN_JOBS: readonly JobDefinition[] = [
	{
		id: JOB_ID.backup,
		label: "Backup scheduler",
		description:
			"Runs configured automatic backups (database + secrets). Ticks are serialized by BackupScheduler — a new tick cannot start while one is in flight.",
		concurrency: "singleton",
	},
	{
		id: JOB_ID.sessionCleanup,
		label: "Session cleanup",
		description:
			"Deletes expired session rows every hour. Safe to run concurrently with request-time cleanup because SQL DELETE is idempotent.",
		concurrency: "singleton",
		intervalMs: 60 * 60 * 1000,
	},
	{
		id: JOB_ID.sessionSnapshot,
		label: "Session snapshot",
		description:
			"Captures Plex/Jellyfin stream telemetry every 5 minutes. Guarded by an in-plugin `isRunning` flag so ticks never overlap per-process.",
		concurrency: "singleton",
		intervalMs: 5 * 60 * 1000,
	},
	{
		id: JOB_ID.librarySync,
		label: "Library sync",
		description:
			"Syncs ARR library metadata on a per-instance cadence. Different ARR instances run independently; each instance is serial against itself.",
		concurrency: "per-instance",
	},
	{
		id: JOB_ID.hunting,
		label: "Hunting scheduler",
		description:
			"Scans ARR instances for missing episodes/movies and optional upgrades. Per-instance scheduling with internal serialization to avoid hammering an ARR instance.",
		concurrency: "per-instance",
	},
	{
		id: JOB_ID.queueCleaner,
		label: "Queue cleaner",
		description:
			"Applies configured queue cleanup rules (stalled, slow, rejected imports, …) per instance on a schedule. Per-instance serial.",
		concurrency: "per-instance",
	},
	{
		id: JOB_ID.libraryCleanup,
		label: "Library cleanup",
		description:
			"Performs scheduled library hygiene (unmonitoring, deletions) per instance based on operator rules.",
		concurrency: "per-instance",
	},
	{
		id: JOB_ID.insightsDigest,
		label: "Insights digest",
		description:
			"Aggregates dashboard insights and emits digest notifications on the configured cadence. Singleton.",
		concurrency: "singleton",
	},
	{
		id: JOB_ID.trashBackupCleanup,
		label: "TRaSH backup cleanup",
		description: "Prunes old TRaSH Guides ARR-config backups to keep the retention window tidy.",
		concurrency: "singleton",
	},
	{
		id: JOB_ID.trashUpdate,
		label: "TRaSH Guides update",
		description: "Refreshes the upstream TRaSH Guides data the app builds recommendations from.",
		concurrency: "singleton",
	},
	{
		id: JOB_ID.trashSync,
		label: "TRaSH Guides sync",
		description:
			"Applies enabled TRaSH Guides templates to target ARR instances on the configured interval.",
		concurrency: "per-instance",
	},
	{
		id: JOB_ID.plexCache,
		label: "Plex library cache",
		description:
			"Refreshes Plex library metadata cache per Plex instance. Per-instance serial with `CacheRefreshStatus` row as the durable witness.",
		concurrency: "per-instance",
	},
	{
		id: JOB_ID.plexEpisodeCache,
		label: "Plex episode cache",
		description: "Refreshes Plex episode metadata used by session views. Per-instance serial.",
		concurrency: "per-instance",
	},
	{
		id: JOB_ID.jellyfinCache,
		label: "Jellyfin library cache",
		description:
			"Refreshes Jellyfin/Emby library metadata cache per instance. Per-instance serial.",
		concurrency: "per-instance",
	},
	{
		id: JOB_ID.jellyfinEpisodeCache,
		label: "Jellyfin episode cache",
		description:
			"Refreshes Jellyfin/Emby episode metadata cache per instance. Per-instance serial.",
		concurrency: "per-instance",
	},
	{
		id: JOB_ID.seerrHealth,
		label: "Seerr health",
		description:
			"Pings configured Seerr (Jellyseerr/Overseerr) instances every 5 minutes. Guarded by an in-plugin `isRunning` flag.",
		concurrency: "singleton",
		intervalMs: 5 * 60 * 1000,
	},
	{
		id: JOB_ID.labelSync,
		label: "Label sync",
		description:
			"Walks enabled LabelSyncRule rows once per hour and applies the configured destination label to source items carrying the matching tag. Per-rule cooldown skips rules that ran in the last hour, so on-demand runs and scheduled ticks don't double-fire.",
		concurrency: "singleton",
		intervalMs: 5 * 60 * 1000,
	},
	{
		id: JOB_ID.autoTag,
		label: "Auto-tag",
		description:
			"Walks enabled AutoTagRule rows once per hour, evaluates each rule's criteria DSL against LibraryCache items, and applies the configured tag to matches via the source *arr's tag-write API. Per-rule cooldown skips rules that ran in the last hour.",
		concurrency: "singleton",
		intervalMs: 5 * 60 * 1000,
	},
	{
		id: JOB_ID.tmdbListCache,
		label: "TMDb list cache",
		description:
			"Refreshes cached membership of TMDb lists referenced by enabled tmdb_list_member auto-tag rules. Scoped to lists actually in use; orphaned cache rows are GC'd at the end of each tick.",
		concurrency: "singleton",
		intervalMs: 4 * 60 * 60 * 1000,
	},
	{
		id: JOB_ID.traktListCache,
		label: "Trakt list cache",
		description:
			"Refreshes cached membership of Trakt lists referenced by enabled trakt_list_member auto-tag rules. Requires a per-user Trakt PAT + an app-level TRAKT_CLIENT_ID env var; no-op when either is missing.",
		concurrency: "singleton",
		intervalMs: 4 * 60 * 60 * 1000,
	},
	{
		id: JOB_ID.quiTorrentStateSync,
		label: "qui torrent-state sync",
		description:
			"Snapshots torrent state (seeding/stalled_dl/etc.) + ratio from every enabled qui instance into LibraryCache. Powers the per-card health badge and the Torrent State filter on the Library page. No-op when no qui instance is configured.",
		concurrency: "singleton",
		intervalMs: 10 * 60 * 1000,
	},
	{
		id: JOB_ID.infoHashBackfill,
		label: "infoHash backfill",
		description:
			"Walks LibraryCache rows missing infoHash for users with qui configured, queries *arr history to populate the hash. Required for qui torrent-state coverage; without it, only items grabbed since PR #416 (2026-05-04) get correlated. Two-phase: a startup catch-up loop drains existing backlogs in batches (capped at 10k rows / ~17min worst-case), then transitions to a 6h steady-state cadence to capture newly-landed items.",
		concurrency: "singleton",
		intervalMs: 6 * 60 * 60 * 1000,
	},
] as const;
