import type { FastifyInstance } from "fastify";

import backupSchedulerPlugin from "../plugins/backup-scheduler.js";
import huntingSchedulerPlugin from "../plugins/hunting-scheduler.js";
import insightsDigestSchedulerPlugin from "../plugins/insights-digest-scheduler.js";
import jellyfinCacheSchedulerPlugin from "../plugins/jellyfin-cache-scheduler.js";
import jellyfinEpisodeCacheSchedulerPlugin from "../plugins/jellyfin-episode-cache-scheduler.js";
import labelSyncSchedulerPlugin from "../plugins/label-sync-scheduler.js";
import libraryCleanupSchedulerPlugin from "../plugins/library-cleanup-scheduler.js";
import librarySyncSchedulerPlugin from "../plugins/library-sync-scheduler.js";
import plexCacheSchedulerPlugin from "../plugins/plex-cache-scheduler.js";
import plexEpisodeCacheSchedulerPlugin from "../plugins/plex-episode-cache-scheduler.js";
import queueCleanerSchedulerPlugin from "../plugins/queue-cleaner-scheduler.js";
import seerrHealthSchedulerPlugin from "../plugins/seerr-health-scheduler.js";
import sessionCleanupPlugin from "../plugins/session-cleanup.js";
import sessionSnapshotSchedulerPlugin from "../plugins/session-snapshot-scheduler.js";
import tautulliCacheSchedulerPlugin from "../plugins/tautulli-cache-scheduler.js";
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
	app.register(tautulliCacheSchedulerPlugin);

	// Seerr health monitoring
	app.register(seerrHealthSchedulerPlugin);
}
