import type { FastifyInstance } from "fastify";
import autoTagSchedulerPlugin from "../plugins/auto-tag-scheduler.js";
import backupSchedulerPlugin from "../plugins/backup-scheduler.js";
import huntingSchedulerPlugin from "../plugins/hunting-scheduler.js";
import infoHashBackfillSchedulerPlugin from "../plugins/infohash-backfill-scheduler.js";
import insightsDigestSchedulerPlugin from "../plugins/insights-digest-scheduler.js";
import jellyfinCacheSchedulerPlugin from "../plugins/jellyfin-cache-scheduler.js";
import jellyfinEpisodeCacheSchedulerPlugin from "../plugins/jellyfin-episode-cache-scheduler.js";
import labelSyncSchedulerPlugin from "../plugins/label-sync-scheduler.js";
import libraryCleanupSchedulerPlugin from "../plugins/library-cleanup-scheduler.js";
import librarySyncSchedulerPlugin from "../plugins/library-sync-scheduler.js";
import plexCacheSchedulerPlugin from "../plugins/plex-cache-scheduler.js";
import plexEpisodeCacheSchedulerPlugin from "../plugins/plex-episode-cache-scheduler.js";
import queueCleanerSchedulerPlugin from "../plugins/queue-cleaner-scheduler.js";
import quiCachePrewarmPlugin from "../plugins/qui-cache-prewarm.js";
import quiTorrentStateSchedulerPlugin from "../plugins/qui-torrent-state-scheduler.js";
import seerrHealthSchedulerPlugin from "../plugins/seerr-health-scheduler.js";
import sessionCleanupPlugin from "../plugins/session-cleanup.js";
import sessionSnapshotSchedulerPlugin from "../plugins/session-snapshot-scheduler.js";
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
	app.register(backupSchedulerPlugin);
	app.register(sessionCleanupPlugin);
	app.register(sessionSnapshotSchedulerPlugin);

	// Library sync + automation (ARR side)
	app.register(librarySyncSchedulerPlugin);
	app.register(huntingSchedulerPlugin);
	app.register(queueCleanerSchedulerPlugin);
	app.register(libraryCleanupSchedulerPlugin);
	app.register(labelSyncSchedulerPlugin);
	app.register(autoTagSchedulerPlugin);
	app.register(tmdbListCacheSchedulerPlugin);
	app.register(traktListCacheSchedulerPlugin);
	app.register(insightsDigestSchedulerPlugin);

	// TRaSH Guides sync + cleanup
	app.register(trashBackupCleanupPlugin);
	app.register(trashUpdateSchedulerPlugin);
	app.register(trashSyncSchedulerPlugin);

	// Media server caches (Plex / Jellyfin / Tautulli)
	app.register(plexCacheSchedulerPlugin);
	app.register(plexEpisodeCacheSchedulerPlugin);
	app.register(jellyfinCacheSchedulerPlugin);
	app.register(jellyfinEpisodeCacheSchedulerPlugin);

	// Seerr health monitoring
	app.register(seerrHealthSchedulerPlugin);

	// qui torrent-state snapshot (powers Library page filter + per-card badge)
	app.register(quiTorrentStateSchedulerPlugin);

	// qui torrent-list cache pre-warm (one-shot at boot+30s, sequential
	// per-instance, opt-out via DISABLE_QUI_CACHE_PREWARM). Eliminates the
	// "first user after restart pays ~3.5s" cliff on the /qui home page;
	// the SWR cache handles every subsequent request invisibly.
	app.register(quiCachePrewarmPlugin);

	// infoHash backfill (eager — fills LibraryCache.infoHash from *arr history
	// so the qui sync above has something to correlate against beyond items
	// the user has actively viewed in the modal)
	app.register(infoHashBackfillSchedulerPlugin);
}
