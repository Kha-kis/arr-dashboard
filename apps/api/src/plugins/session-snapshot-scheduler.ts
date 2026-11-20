/**
 * Session Snapshot Scheduler Plugin
 *
 * Periodically captures native media-server session data (concurrent streams, bandwidth,
 * transcode decisions) into SessionSnapshot for trend analytics.
 * Runs every 5 minutes with a 60-second startup delay.
 * Retains 90 days of data, cleaning up daily.
 *
 * NOTE: Unlike cache schedulers (plex, tautulli, plex-episode), this plugin
 * intentionally does NOT track CacheRefreshStatus. Session snapshots are
 * high-frequency telemetry (5min), not cache refreshes (6h). Each native read
 * records active, idle or failed collection separately from cache freshness.
 * Historical rows without a measurement receipt remain legacy/unverified.
 */

import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { createJellyfinClient, type JellyfinSession } from "../lib/jellyfin/jellyfin-client.js";
import {
	CleanupMaintenanceConflictError,
	withIndependentCleanupOperationGuard,
} from "../lib/library-cleanup/cleanup-maintenance-gate.js";
import { createPlexClient, type PlexSessionItem } from "../lib/plex/plex-client.js";
import { JOB_ID } from "../lib/scheduler-registry/job-definitions.js";
import type {
	SessionSnapshotProvider,
	SessionSnapshotSourceScope,
} from "./lib/session-snapshot-measurements.js";
import {
	buildFailedSessionSnapshot,
	buildJellyfinSessionSnapshot,
	buildPlexSessionSnapshot,
} from "./lib/session-snapshot-measurements.js";

const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const STARTUP_DELAY_MS = 60_000; // 60 seconds
const RETENTION_DAYS = 90;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // Daily

// Smart notification thresholds
const CONCURRENT_PEAK_THRESHOLD = 5;
const TRANSCODE_HEAVY_RATIO = 0.7;
const NEW_DEVICE_LOOKBACK_DAYS = 30;

const sessionSnapshotSchedulerPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		let snapshotIntervalHandle: ReturnType<typeof setInterval> | null = null;
		let cleanupIntervalHandle: ReturnType<typeof setInterval> | null = null;
		let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
		let isRunning = false;
		let admissionClosed = false;
		const readCancellation = new AbortController();
		const pendingWork = new Set<Promise<void>>();

		const closeAdmission = () => {
			admissionClosed = true;
			// Cancel only provider reads. Accepted writes, notifications and cleanup
			// remain in pendingWork and are physically joined by onClose.
			readCancellation.abort();
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (snapshotIntervalHandle) clearInterval(snapshotIntervalHandle);
			if (cleanupIntervalHandle) clearInterval(cleanupIntervalHandle);
			timeoutHandle = null;
			snapshotIntervalHandle = null;
			cleanupIntervalHandle = null;
		};

		const runAccepted = async (operation: () => Promise<void>) => {
			if (admissionClosed) return;
			// Register before invoking the operation, including its first awaited read.
			let settle!: () => void;
			const completion = new Promise<void>((resolve) => {
				settle = resolve;
			});
			pendingWork.add(completion);
			try {
				await operation();
			} catch (error) {
				if (error instanceof CleanupMaintenanceConflictError) {
					app.log.debug("Session snapshot work paused for database maintenance");
					return;
				}
				throw error;
			} finally {
				pendingWork.delete(completion);
				settle();
			}
		};

		// Cache known platforms to avoid fetching 10K+ snapshots every 5-min tick
		let cachedKnownPlatforms: Set<string> | null = null;
		let platformCacheBuiltAt = 0;
		const PLATFORM_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // Rebuild every 6 hours

		async function recordFailedRead(
			instanceId: string,
			provider: SessionSnapshotProvider,
			sourceScope: SessionSnapshotSourceScope,
		) {
			await app.prisma.sessionSnapshot.create({
				data: { instanceId, ...buildFailedSessionSnapshot(provider, sourceScope) },
			});
		}

		/**
		 * Check smart notification thresholds after each snapshot capture.
		 * Fires PLEX_CONCURRENT_PEAK, PLEX_TRANSCODE_HEAVY, PLEX_NEW_DEVICE events.
		 */
		async function checkPlexNotifications(
			totalConcurrent: number,
			totalTranscode: number,
			totalSessions: number,
			methodCoverageComplete: boolean,
			enrichedPlatforms: Set<string>,
			knownPlatforms: Set<string>,
		) {
			if (!app.notificationService) return;

			// PLEX_CONCURRENT_PEAK: concurrent streams exceed threshold
			if (totalConcurrent >= CONCURRENT_PEAK_THRESHOLD) {
				await app.notificationService
					.notify({
						eventType: "PLEX_CONCURRENT_PEAK",
						title: "High concurrent streams detected",
						body: `${totalConcurrent} concurrent streams observed (threshold: ${CONCURRENT_PEAK_THRESHOLD}).`,
						url: "/statistics",
					})
					.catch((err) =>
						app.log.warn(
							{ err, eventType: "PLEX_CONCURRENT_PEAK" },
							"Non-fatal: notification delivery failed",
						),
					);
			}

			// PLEX_TRANSCODE_HEAVY: transcode ratio exceeds threshold
			if (
				methodCoverageComplete &&
				totalSessions > 0 &&
				totalTranscode / totalSessions > TRANSCODE_HEAVY_RATIO
			) {
				const pct = Math.round((totalTranscode / totalSessions) * 100);
				await app.notificationService
					.notify({
						eventType: "PLEX_TRANSCODE_HEAVY",
						title: "Heavy transcoding detected",
						body: `${pct}% of active streams are transcoding (${totalTranscode}/${totalSessions}).`,
						url: "/statistics",
					})
					.catch((err) =>
						app.log.warn(
							{ err, eventType: "PLEX_TRANSCODE_HEAVY" },
							"Non-fatal: notification delivery failed",
						),
					);
			}

			// PLEX_NEW_DEVICE: platform not seen in recent snapshots
			for (const platform of enrichedPlatforms) {
				if (!knownPlatforms.has(platform)) {
					const safePlatform = platform.replace(/[<>&"']/g, "").slice(0, 50);
					await app.notificationService
						.notify({
							eventType: "PLEX_NEW_DEVICE",
							title: "New device detected",
							body: `A new platform "${safePlatform}" was seen streaming for the first time in ${NEW_DEVICE_LOOKBACK_DAYS} days.`,
							url: "/statistics",
						})
						.catch((err) =>
							app.log.warn(
								{ err, eventType: "PLEX_NEW_DEVICE" },
								"Non-fatal: notification delivery failed",
							),
						);
				}
			}
		}

		async function captureSnapshots() {
			if (admissionClosed) return;
			if (isRunning) {
				app.log.warn("Session snapshot capture already running, skipping");
				return;
			}
			isRunning = true;
			const captureErrors: unknown[] = [];

			try {
				const instances = await app.prisma.serviceInstance.findMany({
					where: { service: "PLEX", enabled: true },
				});
				if (admissionClosed) return;

				if (instances.length === 0) {
					app.log.debug("Session snapshot: no enabled Plex instances, skipping");
					return;
				}

				// Use cached known platforms (rebuilt every 6 hours instead of every 5-min tick)
				if (!cachedKnownPlatforms || Date.now() - platformCacheBuiltAt > PLATFORM_CACHE_TTL_MS) {
					try {
						const platformCutoff = new Date(
							Date.now() - NEW_DEVICE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
						);

						// Paginate through snapshots in batches to avoid loading
						// thousands of JSON strings into memory at once (#239)
						const PLATFORM_BATCH_SIZE = 500;
						const platforms = new Set<string>();
						let platformParseFailures = 0;
						let cursor: string | undefined;
						let batchCount = 0;

						for (;;) {
							const batch = await app.prisma.sessionSnapshot.findMany({
								where: { capturedAt: { gte: platformCutoff } },
								select: { id: true, sessionsJson: true },
								orderBy: { id: "asc" },
								take: PLATFORM_BATCH_SIZE,
								...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
							});
							if (admissionClosed) return;

							if (batch.length === 0) break;

							for (const snap of batch) {
								try {
									const sessions: Array<{ platform?: string }> = JSON.parse(snap.sessionsJson);
									for (const s of sessions) {
										if (s.platform) platforms.add(s.platform);
									}
								} catch {
									platformParseFailures++;
								}
							}

							cursor = batch[batch.length - 1]!.id;
							batchCount++;

							// Safety cap: stop after 20 batches (10K records) to match prior behavior
							if (batchCount >= 20) break;
						}

						if (platformParseFailures > 0) {
							app.log.warn(
								{ parseFailures: platformParseFailures },
								"Failed to parse sessionsJson during platform cache rebuild — possible data corruption",
							);
						}
						cachedKnownPlatforms = platforms;
						platformCacheBuiltAt = Date.now();
						app.log.debug({ platformCount: platforms.size }, "Rebuilt known-platforms cache");
					} catch (err) {
						if (admissionClosed) return;
						app.log.warn({ err }, "Session snapshot: failed to rebuild known-platforms cache");
						if (!cachedKnownPlatforms) cachedKnownPlatforms = new Set();
					}
				}
				const knownPlatforms = cachedKnownPlatforms;

				// Track totals across all instances for notification checks
				let tickTotalConcurrent = 0;
				let tickTotalTranscode = 0;
				let tickTotalSessions = 0;
				let methodCoverageComplete = true;
				const tickPlatforms = new Set<string>();

				for (const instance of instances) {
					if (admissionClosed) break;
					const sourceScope = {
						connectionGeneration: instance.connectionGeneration,
						identityGeneration: instance.identityGeneration,
					};
					let sessions: PlexSessionItem[];
					try {
						const client = createPlexClient(
							app.encryptor,
							instance,
							app.log,
							readCancellation.signal,
						);
						sessions = await client.getSessions();
					} catch (err) {
						if (admissionClosed) break;
						captureErrors.push(err);
						methodCoverageComplete = false;
						app.log.warn(
							{ err, instanceId: instance.id, category: "provider-unavailable" },
							"Native session read failed",
						);
						try {
							await recordFailedRead(instance.id, "PLEX", sourceScope);
						} catch (writeError) {
							captureErrors.push(writeError);
							app.log.warn(
								{ err: writeError, category: "persistence-failed" },
								"Failed to persist session collection status",
							);
						}
						continue;
					}
					if (admissionClosed) break;
					try {
						const snapshot = buildPlexSessionSnapshot(sessions, sourceScope);
						await app.prisma.sessionSnapshot.create({
							data: { instanceId: instance.id, ...snapshot },
						});
						for (const session of sessions) {
							if (session.player.platform) tickPlatforms.add(session.player.platform);
						}
						tickTotalConcurrent += sessions.length;
						tickTotalTranscode += snapshot.transcodeCount;
						tickTotalSessions += sessions.length;
						if (
							snapshot.directPlayCount + snapshot.directStreamCount + snapshot.transcodeCount !==
							sessions.length
						)
							methodCoverageComplete = false;
					} catch (err) {
						captureErrors.push(err);
						methodCoverageComplete = false;
						app.log.warn(
							{ err, instanceId: instance.id, category: "persistence-failed" },
							"Native session snapshot persistence failed",
						);
					}
				}

				// Fire smart notifications (non-fatal)
				if (!admissionClosed && tickTotalSessions > 0) {
					const notification = checkPlexNotifications(
						tickTotalConcurrent,
						tickTotalTranscode,
						tickTotalSessions,
						methodCoverageComplete,
						tickPlatforms,
						knownPlatforms,
					).catch((err) => app.log.warn({ err }, "Session snapshot: notification check failed"));

					// Merge current tick's platforms into cache to prevent repeat new-device notifications
					if (cachedKnownPlatforms) {
						for (const p of tickPlatforms) {
							cachedKnownPlatforms.add(p);
						}
					}
					// Release capture's guard in finally, but retain notification completion
					// in the outer tick. A slow alert must not suppress the next snapshot.
					return notification.then(() => {
						if (captureErrors.length > 0)
							throw new AggregateError(captureErrors, "Native session capture incomplete");
					});
				}
				if (captureErrors.length > 0)
					throw new AggregateError(captureErrors, "Native session capture incomplete");
			} catch (err) {
				if (admissionClosed && captureErrors.length === 0) return;
				app.log.error({ err }, "Session snapshot scheduler: failed to query instances");
				throw err;
			} finally {
				isRunning = false;
			}
		}

		/**
		 * Check Jellyfin notification thresholds (mirrors Plex logic).
		 */
		async function checkJellyfinNotifications(
			totalConcurrent: number,
			totalTranscode: number,
			totalSessions: number,
			methodCoverageComplete: boolean,
			platforms: Set<string>,
			knownPlatforms: Set<string>,
		) {
			if (!app.notificationService) return;

			if (totalConcurrent >= CONCURRENT_PEAK_THRESHOLD) {
				await app.notificationService
					.notify({
						eventType: "JELLYFIN_CONCURRENT_PEAK",
						title: "High concurrent media server streams",
						body: `${totalConcurrent} concurrent streams observed (threshold: ${CONCURRENT_PEAK_THRESHOLD}).`,
						url: "/statistics",
					})
					.catch((err) =>
						app.log.warn(
							{ err, eventType: "JELLYFIN_CONCURRENT_PEAK" },
							"Non-fatal: notification delivery failed",
						),
					);
			}

			if (
				methodCoverageComplete &&
				totalSessions > 0 &&
				totalTranscode / totalSessions > TRANSCODE_HEAVY_RATIO
			) {
				const pct = Math.round((totalTranscode / totalSessions) * 100);
				await app.notificationService
					.notify({
						eventType: "JELLYFIN_TRANSCODE_HEAVY",
						title: "Heavy media server transcoding",
						body: `${pct}% of active streams are transcoding (${totalTranscode}/${totalSessions}).`,
						url: "/statistics",
					})
					.catch((err) =>
						app.log.warn(
							{ err, eventType: "JELLYFIN_TRANSCODE_HEAVY" },
							"Non-fatal: notification delivery failed",
						),
					);
			}

			for (const platform of platforms) {
				if (!knownPlatforms.has(platform)) {
					const safePlatform = platform.replace(/[<>&"']/g, "").slice(0, 50);
					await app.notificationService
						.notify({
							eventType: "JELLYFIN_NEW_DEVICE",
							title: "New media server device detected",
							body: `A new client "${safePlatform}" was seen streaming for the first time in ${NEW_DEVICE_LOOKBACK_DAYS} days.`,
							url: "/statistics",
						})
						.catch((err) =>
							app.log.warn(
								{ err, eventType: "JELLYFIN_NEW_DEVICE" },
								"Non-fatal: notification delivery failed",
							),
						);
				}
			}
		}

		/**
		 * Capture Jellyfin session snapshots into the shared SessionSnapshot table.
		 * Only explicit native measurements are persisted; absent fields remain unknown.
		 */
		async function captureJellyfinSnapshots() {
			if (admissionClosed) return;
			const captureErrors: unknown[] = [];
			try {
				const instances = await app.prisma.serviceInstance.findMany({
					where: { service: { in: ["JELLYFIN", "EMBY"] }, enabled: true },
				});
				if (admissionClosed) return;

				if (instances.length === 0) return;

				let tickTotalConcurrent = 0;
				let tickTotalTranscode = 0;
				let tickTotalSessions = 0;
				let methodCoverageComplete = true;
				const tickPlatforms = new Set<string>();

				for (const instance of instances) {
					if (admissionClosed) break;
					const sourceScope = {
						connectionGeneration: instance.connectionGeneration,
						identityGeneration: instance.identityGeneration,
					};
					const provider = instance.service === "EMBY" ? "EMBY" : "JELLYFIN";
					let sessions: JellyfinSession[];
					try {
						const client = createJellyfinClient(
							app.encryptor,
							instance,
							app.log,
							readCancellation.signal,
						);
						sessions = await client.getSessions();
					} catch (err) {
						if (admissionClosed) break;
						captureErrors.push(err);
						methodCoverageComplete = false;
						app.log.warn(
							{ err, instanceId: instance.id, category: "provider-unavailable" },
							"Native session read failed",
						);
						try {
							await recordFailedRead(instance.id, provider, sourceScope);
						} catch (writeError) {
							captureErrors.push(writeError);
							app.log.warn(
								{ err: writeError, category: "persistence-failed" },
								"Failed to persist session collection status",
							);
						}
						continue;
					}
					if (admissionClosed) break;
					try {
						const snapshot = buildJellyfinSessionSnapshot(sessions, provider, sourceScope);
						await app.prisma.sessionSnapshot.create({
							data: { instanceId: instance.id, ...snapshot },
						});
						for (const session of sessions) {
							const platform = session.client?.trim() || session.deviceName?.trim();
							if (platform) tickPlatforms.add(platform);
						}
						tickTotalConcurrent += sessions.length;
						tickTotalTranscode += snapshot.transcodeCount;
						tickTotalSessions += sessions.length;
						if (
							snapshot.directPlayCount + snapshot.directStreamCount + snapshot.transcodeCount !==
							sessions.length
						)
							methodCoverageComplete = false;
					} catch (err) {
						captureErrors.push(err);
						methodCoverageComplete = false;
						app.log.warn(
							{ err, instanceId: instance.id, category: "persistence-failed" },
							"Native session snapshot persistence failed",
						);
					}
				}

				// Fire Jellyfin notifications
				if (!admissionClosed && tickTotalSessions > 0) {
					const notification = checkJellyfinNotifications(
						tickTotalConcurrent,
						tickTotalTranscode,
						tickTotalSessions,
						methodCoverageComplete,
						tickPlatforms,
						cachedKnownPlatforms ?? new Set(),
					).catch((err) =>
						app.log.warn({ err }, "Jellyfin session snapshot: notification check failed"),
					);

					// Merge current platforms into known cache
					if (cachedKnownPlatforms) {
						for (const p of tickPlatforms) cachedKnownPlatforms.add(p);
					}
					return notification.then(() => {
						if (captureErrors.length > 0)
							throw new AggregateError(captureErrors, "Native session capture incomplete");
					});
				}
				if (captureErrors.length > 0)
					throw new AggregateError(captureErrors, "Native session capture incomplete");
			} catch (err) {
				if (admissionClosed && captureErrors.length === 0) return;
				app.log.error({ err }, "Jellyfin session snapshot capture failed");
				throw err;
			}
		}

		async function cleanupOldSnapshots() {
			try {
				const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
				const result = await app.prisma.sessionSnapshot.deleteMany({
					where: { capturedAt: { lt: cutoff } },
				});
				if (result.count > 0) {
					app.log.info({ deleted: result.count }, "Session snapshots: cleaned up old entries");
				}
			} catch (err) {
				app.log.error({ err }, "Session snapshot cleanup failed");
			}
		}

		// Combined tick: both Plex and Jellyfin captures form one scheduler tick
		// from the operator's perspective. The registry sees one run per interval.
		//
		// Behavior preservation: the prior implementation fired the two captures
		// independently (`captureSnapshots().catch(...); captureJellyfinSnapshots().catch(...)`)
		// so a Plex failure never prevented the Jellyfin capture from running.
		// We keep that "both always run" semantic by using Promise.allSettled, then
		// re-throw an aggregate error if either side rejected so the registry still
		// observes a failed tick.
		const runSnapshotTick = () =>
			runAccepted(() =>
				app.notificationService.runProducer(() =>
					app.schedulerRegistry.track(JOB_ID.sessionSnapshot, async () => {
						const results = await Promise.allSettled([
							captureSnapshots(),
							captureJellyfinSnapshots(),
						]);
						const failures = results.filter(
							(r): r is PromiseRejectedResult => r.status === "rejected",
						);
						if (failures.length > 0) {
							throw new AggregateError(
								failures.map((f) => f.reason),
								"session snapshot tick: one or more captures failed",
							);
						}
					}),
				),
			);

		const runCleanupTick = () =>
			runAccepted(() => withIndependentCleanupOperationGuard(cleanupOldSnapshots));

		app.addHook("onReady", async () => {
			if (admissionClosed) return;
			app.log.info("Session snapshot scheduler initialized (5m interval, 60s startup delay)");

			timeoutHandle = setTimeout(() => {
				if (admissionClosed) return;
				runSnapshotTick().catch((err) => {
					app.log.error({ err }, "Failed during initial session snapshot capture");
				});

				snapshotIntervalHandle = setInterval(() => {
					runSnapshotTick().catch((err) => {
						app.log.error({ err }, "Failed during scheduled session snapshot capture");
					});
				}, INTERVAL_MS);

				// Daily cleanup
				cleanupIntervalHandle = setInterval(() => {
					runCleanupTick().catch((err) => {
						app.log.error({ err }, "Failed during session snapshot cleanup");
					});
				}, CLEANUP_INTERVAL_MS);
			}, STARTUP_DELAY_MS);
		});

		app.addHook("preClose", async () => {
			closeAdmission();
		});

		app.addHook("onClose", async () => {
			closeAdmission();
			while (pendingWork.size > 0) {
				await Promise.all(pendingWork);
			}
			app.log.info("Session snapshot scheduler stopped");
		});
	},
	{
		name: "session-snapshot-scheduler",
		dependencies: ["prisma", "security", "scheduler-registry", "notification-service"],
	},
);

export default sessionSnapshotSchedulerPlugin;
