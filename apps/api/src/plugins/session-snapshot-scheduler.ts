/**
 * Session Snapshot Scheduler Plugin
 *
 * Periodically captures Plex session data (concurrent streams, bandwidth,
 * transcode decisions) into SessionSnapshot for trend analytics.
 * Runs every 5 minutes with a 60-second startup delay.
 * Retains 90 days of data, cleaning up daily.
 *
 * NOTE: Unlike cache schedulers (plex, tautulli, plex-episode), this plugin
 * intentionally does NOT track CacheRefreshStatus. Session snapshots are
 * high-frequency telemetry (5min), not cache refreshes (6h). Skipped ticks
 * (no active sessions) are normal — tracking them would create 288+ upserts/day
 * per instance and the 12h stale-check would false-positive whenever nobody
 * watches Plex for half a day.
 */

import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { createJellyfinClient } from "../lib/jellyfin/jellyfin-client.js";
import { createPlexClient } from "../lib/plex/plex-client.js";
import { JOB_ID } from "../lib/scheduler-registry/job-definitions.js";
import { normalizeJellyfinMediaType, toEnrichedSessions } from "./lib/session-enrichment-helpers.js";
import {
	classifySessionDecisions,
	computeLanWanAttribution,
} from "./lib/session-snapshot-helpers.js";

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

		// Cache known platforms to avoid fetching 10K+ snapshots every 5-min tick
		let cachedKnownPlatforms: Set<string> | null = null;
		let platformCacheBuiltAt = 0;
		const PLATFORM_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // Rebuild every 6 hours

		/**
		 * Check smart notification thresholds after each snapshot capture.
		 * Fires PLEX_CONCURRENT_PEAK, PLEX_TRANSCODE_HEAVY, PLEX_NEW_DEVICE events.
		 */
		async function checkPlexNotifications(
			totalConcurrent: number,
			totalTranscode: number,
			totalSessions: number,
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
						body: `${totalConcurrent} concurrent streams active (threshold: ${CONCURRENT_PEAK_THRESHOLD}).`,
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
			if (totalSessions > 0 && totalTranscode / totalSessions > TRANSCODE_HEAVY_RATIO) {
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
			if (isRunning) {
				app.log.warn("Session snapshot capture already running, skipping");
				return;
			}
			isRunning = true;

			try {
				const instances = await app.prisma.serviceInstance.findMany({
					where: { service: "PLEX", enabled: true },
				});

				if (instances.length === 0) {
					app.log.debug("Session snapshot: no enabled Plex instances, skipping");
					return;
				}

				// LAN/WAN bandwidth split was Tautulli-sourced; removed in 3.0
				// (ADR-0007). lanBandwidth/wanBandwidth persist as null until the
				// Tracearr-era analytics rewrite (charter C2) re-sources them.

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
						app.log.warn({ err }, "Session snapshot: failed to rebuild known-platforms cache");
						if (!cachedKnownPlatforms) cachedKnownPlatforms = new Set();
					}
				}
				const knownPlatforms = cachedKnownPlatforms;

				// Track totals across all instances for notification checks
				let tickTotalConcurrent = 0;
				let tickTotalTranscode = 0;
				let tickTotalSessions = 0;
				const tickPlatforms = new Set<string>();

				for (const instance of instances) {
					try {
						const client = createPlexClient(app.encryptor, instance, app.log);
						const sessions = await client.getSessions();

						// Skip snapshot if no active sessions
						if (sessions.length === 0) continue;

						const { totalBandwidth, directPlayCount, transcodeCount, directStreamCount } =
							classifySessionDecisions(sessions);

						const enrichedSessions = toEnrichedSessions(sessions);

						// Collect platforms for new-device notification
						for (const es of enrichedSessions) {
							if (es.platform) tickPlatforms.add(es.platform);
						}

						await app.prisma.sessionSnapshot.create({
							data: {
								instanceId: instance.id,
								concurrentStreams: sessions.length,
								totalBandwidth,
								// lanBandwidth/wanBandwidth omitted — Tautulli-sourced split
								// removed in 3.0 (ADR-0007); columns stay NULL until the
								// Tracearr-era analytics rewrite re-sources them (charter C2).
								directPlayCount,
								transcodeCount,
								directStreamCount,
								sessionsJson: JSON.stringify(enrichedSessions),
							},
						});

						tickTotalConcurrent += sessions.length;
						tickTotalTranscode += transcodeCount;
						tickTotalSessions += sessions.length;
					} catch (err) {
						app.log.warn(
							{ err, instanceId: instance.id, label: instance.label },
							"Session snapshot capture failed for instance",
						);
					}
				}

				// Fire smart notifications (non-fatal)
				if (tickTotalSessions > 0) {
					checkPlexNotifications(
						tickTotalConcurrent,
						tickTotalTranscode,
						tickTotalSessions,
						tickPlatforms,
						knownPlatforms,
					).catch((err) => app.log.warn({ err }, "Session snapshot: notification check failed"));

					// Merge current tick's platforms into cache to prevent repeat new-device notifications
					if (cachedKnownPlatforms) {
						for (const p of tickPlatforms) {
							cachedKnownPlatforms.add(p);
						}
					}
				}
			} catch (err) {
				app.log.error({ err }, "Session snapshot scheduler: failed to query instances");
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
			platforms: Set<string>,
			knownPlatforms: Set<string>,
		) {
			if (!app.notificationService) return;

			if (totalConcurrent >= CONCURRENT_PEAK_THRESHOLD) {
				await app.notificationService
					.notify({
						eventType: "JELLYFIN_CONCURRENT_PEAK",
						title: "High concurrent media server streams",
						body: `${totalConcurrent} concurrent streams active (threshold: ${CONCURRENT_PEAK_THRESHOLD}).`,
						url: "/statistics",
					})
					.catch((err) =>
						app.log.warn(
							{ err, eventType: "JELLYFIN_CONCURRENT_PEAK" },
							"Non-fatal: notification delivery failed",
						),
					);
			}

			if (totalSessions > 0 && totalTranscode / totalSessions > TRANSCODE_HEAVY_RATIO) {
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
		 * Jellyfin provides all codec/platform data natively (no Tautulli enrichment needed).
		 */
		async function captureJellyfinSnapshots() {
			try {
				const instances = await app.prisma.serviceInstance.findMany({
					where: { service: { in: ["JELLYFIN", "EMBY"] }, enabled: true },
				});

				if (instances.length === 0) return;

				let tickTotalConcurrent = 0;
				let tickTotalTranscode = 0;
				let tickTotalSessions = 0;
				const tickPlatforms = new Set<string>();

				for (const instance of instances) {
					try {
						const client = createJellyfinClient(app.encryptor, instance, app.log);
						const sessions = await client.getSessions();

						if (sessions.length === 0) continue;

						// Classify sessions
						let totalBandwidth = 0;
						let directPlayCount = 0;
						let transcodeCount = 0;
						let directStreamCount = 0;

						const enrichedSessions = sessions.map((s) => {
							const bw = s.transcodingInfo?.bitrate
								? Math.round(s.transcodingInfo.bitrate / 1000)
								: 0;
							totalBandwidth += bw;

							const method = s.playMethod?.toLowerCase() ?? "directplay";
							if (method === "transcode") {
								transcodeCount++;
							} else if (method === "directstream") {
								directStreamCount++;
							} else {
								directPlayCount++;
							}

							const platform = s.client ?? s.deviceName ?? null;
							if (platform) tickPlatforms.add(platform);

							return {
								user: s.userName ?? "Unknown",
								title: s.nowPlayingItem?.name ?? "Unknown",
								grandparentTitle: s.nowPlayingItem?.seriesName,
								mediaType: normalizeJellyfinMediaType(s.nowPlayingItem?.type),
								videoDecision:
									s.transcodingInfo && !s.transcodingInfo.isVideoDirect
										? "transcode"
										: (s.playMethod ?? "direct play"),
								bandwidth: bw,
								state: s.isPaused ? "paused" : "playing",
								audioDecision:
									s.transcodingInfo && !s.transcodingInfo.isAudioDirect ? "transcode" : "direct",
								videoCodec: s.transcodingInfo?.videoCodec ?? null,
								audioCodec: s.transcodingInfo?.audioCodec ?? null,
								videoResolution:
									s.transcodingInfo?.width && s.transcodingInfo?.height
										? `${s.transcodingInfo.width}x${s.transcodingInfo.height}`
										: null,
								platform,
								player: s.deviceName ?? null,
							};
						});

						await app.prisma.sessionSnapshot.create({
							data: {
								instanceId: instance.id,
								concurrentStreams: sessions.length,
								totalBandwidth,
								lanBandwidth: 0,
								wanBandwidth: 0,
								directPlayCount,
								transcodeCount,
								directStreamCount,
								sessionsJson: JSON.stringify(enrichedSessions),
							},
						});

						tickTotalConcurrent += sessions.length;
						tickTotalTranscode += transcodeCount;
						tickTotalSessions += sessions.length;
					} catch (err) {
						app.log.warn(
							{ err, instanceId: instance.id, label: instance.label },
							"Jellyfin session snapshot capture failed for instance",
						);
					}
				}

				// Fire Jellyfin notifications
				if (tickTotalSessions > 0) {
					checkJellyfinNotifications(
						tickTotalConcurrent,
						tickTotalTranscode,
						tickTotalSessions,
						tickPlatforms,
						cachedKnownPlatforms ?? new Set(),
					).catch((err) =>
						app.log.warn({ err }, "Jellyfin session snapshot: notification check failed"),
					);

					// Merge current platforms into known cache
					if (cachedKnownPlatforms) {
						for (const p of tickPlatforms) cachedKnownPlatforms.add(p);
					}
				}
			} catch (err) {
				app.log.error({ err }, "Jellyfin session snapshot capture failed");
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
			app.schedulerRegistry.track(JOB_ID.sessionSnapshot, async () => {
				const results = await Promise.allSettled([captureSnapshots(), captureJellyfinSnapshots()]);
				const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
				if (failures.length > 0) {
					throw new AggregateError(
						failures.map((f) => f.reason),
						"session snapshot tick: one or more captures failed",
					);
				}
			});

		app.addHook("onReady", async () => {
			app.log.info("Session snapshot scheduler initialized (5m interval, 60s startup delay)");

			timeoutHandle = setTimeout(() => {
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
					cleanupOldSnapshots().catch((err) => {
						app.log.error({ err }, "Failed during session snapshot cleanup");
					});
				}, CLEANUP_INTERVAL_MS);
			}, STARTUP_DELAY_MS);
		});

		app.addHook("onClose", async () => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (snapshotIntervalHandle) clearInterval(snapshotIntervalHandle);
			if (cleanupIntervalHandle) clearInterval(cleanupIntervalHandle);
			app.log.info("Session snapshot scheduler stopped");
		});
	},
	{
		name: "session-snapshot-scheduler",
		dependencies: ["prisma", "security", "scheduler-registry"],
	},
);

export default sessionSnapshotSchedulerPlugin;
