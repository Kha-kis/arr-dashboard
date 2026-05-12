/**
 * Library Sync Scheduler
 *
 * Manages background polling to keep the library cache synchronized
 * with ARR instances.
 */

import { LIBRARY_SERVICES_UPPER } from "@arr/shared";
import type { FastifyInstance } from "fastify";
import { createLogger } from "../logger.js";
import {
	passthroughTickWrapper,
	type TickWrapper,
} from "../scheduler-registry/scheduler-registry.js";
import { type SyncResult, syncInstance } from "./sync-executor.js";

const log = createLogger("library-sync");

// ============================================================================
// Constants
// ============================================================================

/** How often to check for instances needing sync (in ms) */
const SCHEDULER_TICK_INTERVAL_MS = 60_000; // 1 minute

/**
 * Delay before the FIRST tick fires after start().
 *
 * Issue #427 follow-up: container startup has half a dozen schedulers
 * firing in the first ~5 minutes (seerr-health at 20s, plex-cache at 30s,
 * jellyfin-cache at 45s, session-snapshot at 60s, tmdb-list at 60s,
 * trakt-list at 90s, tautulli-cache at 2min, plex-episode-cache at 5min).
 * Library-sync previously fired AT 0s — every fresh container with a
 * large Lidarr would co-spike its 50k-artist fetch alongside the Plex /
 * Tautulli warm-ups.
 *
 * 60s pushes library-sync's first tick out past the Plex/Jellyfin cache
 * warmup window, giving the heap time to settle from container startup
 * before the heaviest catalog fetches begin.
 */
const FIRST_TICK_DELAY_MS = 60_000;

/**
 * Maximum concurrent syncs to prevent overwhelming the system.
 *
 * Used as the default cap. Adaptive logic in tick() lowers this to 1 when
 * the next sync candidate's last-known itemCount exceeds LARGE_LIBRARY_THRESHOLD
 * — prevents two big libraries (e.g. Sonarr + Lidarr) from co-syncing and
 * busting the heap on large-collection users.
 */
const MAX_CONCURRENT_SYNCS = 2;

/**
 * Item-count cutoff above which an instance counts as "large" for concurrency
 * purposes. Tuned roughly to the size where a single sync allocates ~50 MB
 * of slim records during streaming, so two of them would push past 100 MB
 * concurrent — comfortable on the 768 MB heap cap when combined with
 * everything else firing in the same window.
 */
const LARGE_LIBRARY_THRESHOLD = 10_000;

/** Minimum interval between syncs for any instance (in minutes) */
const MIN_SYNC_INTERVAL_MINS = 5;

// ============================================================================
// Scheduler Class
// ============================================================================

export class LibrarySyncScheduler {
	private app: FastifyInstance | null = null;
	private running = false;
	private intervalId: NodeJS.Timeout | null = null;
	private firstTickTimeoutId: NodeJS.Timeout | null = null;
	private activeSyncs: Set<string> = new Set();
	private trackTick: TickWrapper = passthroughTickWrapper;

	/**
	 * Initialize the scheduler with the app instance
	 */
	initialize(app: FastifyInstance): void {
		this.app = app;
	}

	/**
	 * Wire an optional tick wrapper (used by the plugin to route ticks
	 * through the SchedulerRegistry). Safe to call multiple times.
	 */
	setTrackTick(trackTick: TickWrapper): void {
		this.trackTick = trackTick;
	}

	/**
	 * Start the scheduler (begins polling for instances needing sync)
	 */
	start(app: FastifyInstance): void {
		if (this.running) {
			log.warn("Library sync scheduler already running");
			return;
		}

		if (!this.app) {
			this.app = app;
		}

		this.running = true;
		log.info(
			{ firstTickDelayMs: FIRST_TICK_DELAY_MS, intervalMs: SCHEDULER_TICK_INTERVAL_MS },
			"Starting library sync scheduler (first tick delayed to avoid startup co-spike)",
		);

		// Delay the first tick — see FIRST_TICK_DELAY_MS comment for why.
		this.firstTickTimeoutId = setTimeout(() => {
			this.firstTickTimeoutId = null;
			// Guard against stop() racing with the timeout firing. Without
			// this check: stop() runs (sets `this.running = false` and clears
			// `firstTickTimeoutId` which is already null here, so its
			// clearTimeout is a no-op), then this callback continues and
			// installs an interval that escapes shutdown cleanup. The interval
			// would then pin the event loop open during graceful shutdown.
			if (!this.running) {
				log.debug("First-tick callback fired after stop() — skipping interval install");
				return;
			}
			this.trackTick(() => this.tick()).catch((error) => {
				log.error({ err: error }, "Initial scheduler tick failed");
			});

			// Then check periodically
			this.intervalId = setInterval(() => {
				this.trackTick(() => this.tick()).catch((error) => {
					log.error({ err: error }, "Scheduler tick failed");
				});
			}, SCHEDULER_TICK_INTERVAL_MS);
		}, FIRST_TICK_DELAY_MS);
	}

	/**
	 * Stop the scheduler
	 */
	stop(): void {
		if (!this.running) {
			return;
		}

		log.info("Stopping library sync scheduler");

		// Cancel a pending first-tick if stop() fires inside FIRST_TICK_DELAY_MS
		// (e.g., onClose during graceful shutdown immediately after start()).
		if (this.firstTickTimeoutId) {
			clearTimeout(this.firstTickTimeoutId);
			this.firstTickTimeoutId = null;
		}

		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}

		this.running = false;
	}

	/**
	 * Check if the scheduler is running
	 */
	isRunning(): boolean {
		return this.running;
	}

	/**
	 * Trigger a manual sync for a specific instance
	 */
	async triggerSync(instanceId: string): Promise<SyncResult | null> {
		if (!this.app) {
			log.error("Scheduler not initialized");
			return null;
		}

		// Check if already syncing
		if (this.activeSyncs.has(instanceId)) {
			log.warn({ instanceId }, "Sync already in progress for instance");
			return null;
		}

		// Get instance + its sync status (so adaptive concurrency in
		// concurrent tick()s sees this manual sync's known size).
		const instance = await this.app.prisma.serviceInstance.findUnique({
			where: { id: instanceId },
			include: { librarySyncStatus: true },
		});

		if (!instance) {
			log.error({ instanceId }, "Instance not found");
			return null;
		}

		// Skip if not a library service (only Prowlarr has no library)
		if (!(LIBRARY_SERVICES_UPPER as readonly string[]).includes(instance.service)) {
			log.debug({ instanceId, service: instance.service }, "Skipping non-library instance");
			return null;
		}

		// Mirror tick()'s pre-runSync bookkeeping so adaptive concurrency works
		// even when a manual trigger races with a scheduled tick. Cold-start
		// instances (no lastFullSync yet) are treated as ≥ threshold so they
		// don't accidentally co-spike with another large sync.
		const status = instance.librarySyncStatus;
		const knownItemCount = status?.lastFullSync ? (status.itemCount ?? 0) : LARGE_LIBRARY_THRESHOLD;
		this.activeSyncItemCounts.set(instance.id, knownItemCount);
		return this.runSync(instance);
	}

	/**
	 * Track each active sync's last-known itemCount so the tick can apply the
	 * adaptive concurrency rule without re-querying the DB. Populated when a
	 * sync is launched, cleared in runSync's finally.
	 */
	private activeSyncItemCounts: Map<string, number> = new Map();

	/**
	 * Decide the effective max-concurrent-syncs for this tick. If any active
	 * sync OR any candidate at the head of the list is "large" (issue #427:
	 * large libraries are the catalog-fetch + Map-build memory peak), cap at
	 * 1 so two big syncs don't co-spike the heap.
	 *
	 * `candidateItemCount` is the next instance we're considering starting.
	 */
	private effectiveMaxConcurrent(candidateItemCount: number): number {
		const largeActive = Array.from(this.activeSyncItemCounts.values()).some(
			(n) => n >= LARGE_LIBRARY_THRESHOLD,
		);
		const largeCandidate = candidateItemCount >= LARGE_LIBRARY_THRESHOLD;
		if (largeActive || largeCandidate) return 1;
		return MAX_CONCURRENT_SYNCS;
	}

	/**
	 * Main scheduler tick - runs every minute
	 */
	private async tick(): Promise<void> {
		if (!this.app) {
			return;
		}

		// Don't start new syncs if we're at the absolute cap (covers the
		// default-2 ceiling). Adaptive lowering happens per-candidate below.
		if (this.activeSyncs.size >= MAX_CONCURRENT_SYNCS) {
			log.debug(
				{ activeCount: this.activeSyncs.size },
				"Max concurrent syncs reached, skipping tick",
			);
			return;
		}

		try {
			// Find instances due for sync
			const now = new Date();
			const minIntervalMs = MIN_SYNC_INTERVAL_MINS * 60 * 1000;

			// Get all library-capable instances with their sync status
			const instances = await this.app.prisma.serviceInstance.findMany({
				where: {
					enabled: true,
					service: { in: [...LIBRARY_SERVICES_UPPER] },
				},
				include: {
					librarySyncStatus: true,
				},
			});

			for (const instance of instances) {
				// Check sync status
				const status = instance.librarySyncStatus;

				// Apply adaptive concurrency cap based on the candidate's last-known
				// size + currently-active syncs. Done BEFORE the "skip if already
				// syncing" check so a large candidate gates additional starts even
				// when this iteration's instance is already running.
				//
				// Cold start: when `lastFullSync` is null (never synced) we have
				// no size info at all. Treating an unknown instance as "small"
				// (itemCount=0) was the bug from #427 review — it let two big
				// libraries co-sync on the very first tick of a fresh container,
				// exactly the case this cap is supposed to prevent. Be
				// conservative: assume unknown ≥ threshold so cold-start sync
				// runs solo. After the first successful sync, itemCount is
				// persisted and subsequent ticks use the real value.
				const candidateItemCount = status?.lastFullSync
					? (status.itemCount ?? 0)
					: LARGE_LIBRARY_THRESHOLD;
				const effectiveCap = this.effectiveMaxConcurrent(candidateItemCount);
				if (this.activeSyncs.size >= effectiveCap) {
					if (effectiveCap < MAX_CONCURRENT_SYNCS) {
						log.debug(
							{
								activeCount: this.activeSyncs.size,
								effectiveCap,
								candidateItemCount,
								instanceId: instance.id,
							},
							"Adaptive concurrency cap reached (large library) — deferring sync",
						);
					}
					break;
				}

				// Skip if already syncing
				if (this.activeSyncs.has(instance.id)) {
					continue;
				}

				// Skip if sync is in progress (from previous interrupted run)
				if (status?.syncInProgress) {
					// Check if it's been stuck for too long (> 30 minutes)
					const lastUpdate = status.updatedAt;
					const stuckThreshold = 30 * 60 * 1000; // 30 minutes
					if (now.getTime() - lastUpdate.getTime() > stuckThreshold) {
						// Reset stuck sync
						await this.app.prisma.librarySyncStatus.update({
							where: { instanceId: instance.id },
							data: { syncInProgress: false },
						});
						log.warn({ instanceId: instance.id }, "Reset stuck sync status");
					} else {
						continue;
					}
				}

				// Skip if polling is disabled
				if (status && !status.pollingEnabled) {
					continue;
				}

				// Check if enough time has passed since last sync
				const intervalMins = status?.pollingIntervalMins ?? 15;
				const intervalMs = intervalMins * 60 * 1000;
				const lastSync = status?.lastFullSync;

				// Never synced, or interval has passed
				const needsSync =
					!lastSync || now.getTime() - lastSync.getTime() >= Math.max(intervalMs, minIntervalMs);

				if (needsSync) {
					// Record the candidate's last-known size so other instances
					// evaluated later in this tick see it as an active large sync.
					// Cleared in runSync's finally.
					this.activeSyncItemCounts.set(instance.id, candidateItemCount);
					// Run sync in background (don't await to allow parallel processing)
					this.runSync(instance).catch((error) => {
						log.error({ err: error, instanceId: instance.id }, "Background sync failed");
					});
				}
			}
		} catch (error) {
			log.error({ err: error }, "Error during scheduler tick");
		}
	}

	/**
	 * Run a sync for a specific instance
	 */
	private async runSync(instance: {
		id: string;
		label: string;
		service: string;
		baseUrl: string;
		encryptedApiKey: string;
		encryptionIv: string;
	}): Promise<SyncResult> {
		if (!this.app) {
			throw new Error("Scheduler not initialized");
		}

		this.activeSyncs.add(instance.id);

		try {
			log.info({ instanceId: instance.id, instanceName: instance.label }, "Starting library sync");

			const result = await syncInstance(
				{
					prisma: this.app.prisma,
					arrClientFactory: this.app.arrClientFactory,
					encryptor: this.app.encryptor,
					log: this.app.log,
				},
				instance as Parameters<typeof syncInstance>[1],
			);

			log.info(
				{ instanceId: instance.id, instanceLabel: instance.label, success: result.success },
				"Library sync completed",
			);

			// Notify about newly downloaded content (hasFile: false → true transitions)
			if (result.success && result.newDownloads.length > 0) {
				const titles = result.newDownloads.slice(0, 5).map((d) => d.title);
				const remaining = result.newDownloads.length - titles.length;

				this.app.notificationService
					?.notify({
						eventType: "LIBRARY_NEW_CONTENT",
						title: `${result.newDownloads.length} new download(s) on ${instance.label}`,
						body: remaining > 0 ? `${titles.join(", ")} and ${remaining} more` : titles.join(", "),
						url: "/library",
						metadata: {
							instance: instance.label,
							service: instance.service,
							itemCount: result.newDownloads.length,
							items: titles,
						},
					})
					.catch((err) => {
						log.warn(
							{ err, instanceLabel: instance.label },
							"New content notification dispatch failed",
						);
					});
			}

			return result;
		} finally {
			this.activeSyncs.delete(instance.id);
			this.activeSyncItemCounts.delete(instance.id);
		}
	}

	/**
	 * Get the number of active syncs
	 */
	getActiveSyncCount(): number {
		return this.activeSyncs.size;
	}

	/**
	 * Check if a specific instance is currently syncing
	 */
	isInstanceSyncing(instanceId: string): boolean {
		return this.activeSyncs.has(instanceId);
	}
}

// ============================================================================
// Singleton Export
// ============================================================================

let scheduler: LibrarySyncScheduler | null = null;

/**
 * Get the singleton LibrarySyncScheduler instance
 */
export function getLibrarySyncScheduler(): LibrarySyncScheduler {
	if (!scheduler) {
		scheduler = new LibrarySyncScheduler();
	}
	return scheduler;
}
