/**
 * Library Sync Scheduler
 *
 * Manages background polling to keep the library cache synchronized
 * with ARR instances.
 */

import type { FastifyInstance } from "fastify";
import { syncInstance, type SyncResult } from "./sync-executor.js";
import { createLogger } from "../logger.js";

const log = createLogger("library-sync");

// ============================================================================
// Constants
// ============================================================================

/** How often to check for instances needing sync (in ms) */
const SCHEDULER_TICK_INTERVAL_MS = 60_000; // 1 minute

/** Maximum concurrent syncs to prevent overwhelming the system */
const MAX_CONCURRENT_SYNCS = 2;

/** Minimum interval between syncs for any instance (in minutes) */
const MIN_SYNC_INTERVAL_MINS = 5;

// ============================================================================
// Scheduler Class
// ============================================================================

class LibrarySyncScheduler {
	private app: FastifyInstance | null = null;
	private running = false;
	private intervalId: NodeJS.Timeout | null = null;
	private activeSyncs: Set<string> = new Set();

	/**
	 * Initialize the scheduler with the app instance
	 */
	initialize(app: FastifyInstance): void {
		this.app = app;
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
		log.info("Starting library sync scheduler");

		// Check immediately on start
		this.tick().catch((error) => {
			log.error({ err: error }, "Initial scheduler tick failed");
		});

		// Then check periodically
		this.intervalId = setInterval(() => {
			this.tick().catch((error) => {
				log.error({ err: error }, "Scheduler tick failed");
			});
		}, SCHEDULER_TICK_INTERVAL_MS);
	}

	/**
	 * Stop the scheduler
	 */
	stop(): void {
		if (!this.running) {
			return;
		}

		log.info("Stopping library sync scheduler");

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

		// Get instance
		const instance = await this.app.prisma.serviceInstance.findUnique({
			where: { id: instanceId },
		});

		if (!instance) {
			log.error({ instanceId }, "Instance not found");
			return null;
		}

		// Skip if not Sonarr or Radarr
		if (instance.service !== "SONARR" && instance.service !== "RADARR") {
			log.debug({ instanceId, service: instance.service }, "Skipping non-library instance");
			return null;
		}

		return this.runSync(instance);
	}

	/**
	 * Main scheduler tick - runs every minute
	 */
	private async tick(): Promise<void> {
		if (!this.app) {
			return;
		}

		// Don't start new syncs if we're at capacity
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

			// Get all Sonarr/Radarr instances with their sync status
			const instances = await this.app.prisma.serviceInstance.findMany({
				where: {
					enabled: true,
					service: { in: ["SONARR", "RADARR"] },
				},
				include: {
					librarySyncStatus: true,
				},
			});

			for (const instance of instances) {
				// Check if we're at capacity
				if (this.activeSyncs.size >= MAX_CONCURRENT_SYNCS) {
					break;
				}

				// Skip if already syncing
				if (this.activeSyncs.has(instance.id)) {
					continue;
				}

				// Check sync status
				const status = instance.librarySyncStatus;

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
	private async runSync(
		instance: { id: string; label: string; service: string; baseUrl: string; encryptedApiKey: string; encryptionIv: string },
	): Promise<SyncResult> {
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
					log: this.app.log,
				},
				instance as Parameters<typeof syncInstance>[1],
			);

			return result;
		} finally {
			this.activeSyncs.delete(instance.id);
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
