import type { FastifyInstance } from "fastify";
import { registerRestoreBootstrapPlugin } from "../lib/backup/restore-runtime-bootstrap.js";
import autoTagSchedulerPlugin from "../plugins/auto-tag-scheduler.js";
import backupSchedulerPlugin from "../plugins/backup-scheduler.js";
import historyCollectionSchedulerPlugin from "../plugins/history-collection-scheduler.js";
import huntingSchedulerPlugin from "../plugins/hunting-scheduler.js";
import importOperationSchedulerPlugin from "../plugins/import-operation-scheduler.js";
import infoHashBackfillSchedulerPlugin from "../plugins/infohash-backfill-scheduler.js";
import insightsDigestSchedulerPlugin from "../plugins/insights-digest-scheduler.js";
import jellyfinCacheSchedulerPlugin from "../plugins/jellyfin-cache-scheduler.js";
import jellyfinEpisodeCacheSchedulerPlugin from "../plugins/jellyfin-episode-cache-scheduler.js";
import jellyfinPositiveWatchSchedulerPlugin from "../plugins/jellyfin-positive-watch-scheduler.js";
import labelSyncSchedulerPlugin from "../plugins/label-sync-scheduler.js";
import libraryCleanupSchedulerPlugin from "../plugins/library-cleanup-scheduler.js";
import librarySyncSchedulerPlugin from "../plugins/library-sync-scheduler.js";
import nativeInventorySchedulerPlugin from "../plugins/native-inventory-scheduler.js";
import plexCacheSchedulerPlugin from "../plugins/plex-cache-scheduler.js";
import plexEpisodeCacheSchedulerPlugin from "../plugins/plex-episode-cache-scheduler.js";
import queueCleanerSchedulerPlugin from "../plugins/queue-cleaner-scheduler.js";
import quiCachePrewarmPlugin from "../plugins/qui-cache-prewarm.js";
import quiTorrentStateSchedulerPlugin from "../plugins/qui-torrent-state-scheduler.js";
import seerrHealthSchedulerPlugin from "../plugins/seerr-health-scheduler.js";
import sessionCleanupPlugin from "../plugins/session-cleanup.js";
import sessionSnapshotSchedulerPlugin from "../plugins/session-snapshot-scheduler.js";
import tautulliCacheSchedulerPlugin from "../plugins/tautulli-cache-scheduler.js";
import tmdbListCacheSchedulerPlugin from "../plugins/tmdb-list-cache-scheduler.js";
import traktListCacheSchedulerPlugin from "../plugins/trakt-list-cache-scheduler.js";
import trashBackupCleanupPlugin from "../plugins/trash-backup-cleanup.js";
import trashSyncSchedulerPlugin from "../plugins/trash-sync-scheduler.js";
import trashUpdateSchedulerPlugin from "../plugins/trash-update-scheduler.js";

/**
 * Background scheduler plugins — registered after infrastructure so they can
 * rely on `app.prisma`, `app.notificationService`, etc.
 *
 * Grouped by domain below to make it easier to reason about which schedulers
 * belong together. Order within a group is not significant.
 */
export function registerSchedulers(app: FastifyInstance): void {
	// Backups + session lifecycle
	registerRestoreBootstrapPlugin(app, backupSchedulerPlugin, { readyPhase: "running" });
	registerRestoreBootstrapPlugin(app, sessionCleanupPlugin);
	registerRestoreBootstrapPlugin(app, sessionSnapshotSchedulerPlugin);

	// Library sync + automation (ARR side)
	registerRestoreBootstrapPlugin(app, librarySyncSchedulerPlugin);
	registerRestoreBootstrapPlugin(app, huntingSchedulerPlugin);
	registerRestoreBootstrapPlugin(app, queueCleanerSchedulerPlugin);
	registerRestoreBootstrapPlugin(app, importOperationSchedulerPlugin);
	registerRestoreBootstrapPlugin(app, libraryCleanupSchedulerPlugin, { readyPhase: "running" });
	registerRestoreBootstrapPlugin(app, labelSyncSchedulerPlugin);
	registerRestoreBootstrapPlugin(app, autoTagSchedulerPlugin);
	registerRestoreBootstrapPlugin(app, tmdbListCacheSchedulerPlugin);
	registerRestoreBootstrapPlugin(app, traktListCacheSchedulerPlugin);
	registerRestoreBootstrapPlugin(app, insightsDigestSchedulerPlugin);
	registerRestoreBootstrapPlugin(app, historyCollectionSchedulerPlugin);

	// TRaSH Guides sync + cleanup
	registerRestoreBootstrapPlugin(app, trashBackupCleanupPlugin);
	registerRestoreBootstrapPlugin(app, trashUpdateSchedulerPlugin);
	registerRestoreBootstrapPlugin(app, trashSyncSchedulerPlugin, { readyPhase: "running" });

	// Media server caches (Plex / Jellyfin / Tautulli)
	registerRestoreBootstrapPlugin(app, plexCacheSchedulerPlugin);
	registerRestoreBootstrapPlugin(app, plexEpisodeCacheSchedulerPlugin);
	registerRestoreBootstrapPlugin(app, jellyfinCacheSchedulerPlugin);
	registerRestoreBootstrapPlugin(app, jellyfinEpisodeCacheSchedulerPlugin);
	registerRestoreBootstrapPlugin(app, jellyfinPositiveWatchSchedulerPlugin);
	registerRestoreBootstrapPlugin(app, nativeInventorySchedulerPlugin);
	registerRestoreBootstrapPlugin(app, tautulliCacheSchedulerPlugin);

	// Seerr health monitoring
	registerRestoreBootstrapPlugin(app, seerrHealthSchedulerPlugin);

	// qui torrent-state snapshot (powers Library page filter + per-card badge)
	registerRestoreBootstrapPlugin(app, quiTorrentStateSchedulerPlugin);

	// qui torrent-list cache pre-warm (one-shot at boot+30s, sequential
	// per-instance, opt-out via DISABLE_QUI_CACHE_PREWARM). Eliminates the
	// "first user after restart pays ~3.5s" cliff on the /qui home page;
	// the SWR cache handles every subsequent request invisibly.
	registerRestoreBootstrapPlugin(app, quiCachePrewarmPlugin);

	// infoHash backfill (eager — fills LibraryCache.infoHash from *arr history
	// so the qui sync above has something to correlate against beyond items
	// the user has actively viewed in the modal)
	registerRestoreBootstrapPlugin(app, infoHashBackfillSchedulerPlugin);
}
