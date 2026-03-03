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
import type { TautulliSessionItem } from "../lib/tautulli/tautulli-client.js";
import { createPlexClient } from "../lib/plex/plex-client.js";
import { createTautulliClient } from "../lib/tautulli/tautulli-client.js";
import { classifySessionDecisions, computeLanWanAttribution } from "./lib/session-snapshot-helpers.js";
import { buildTautulliSessionMap, enrichSessionsWithTautulli } from "./lib/session-enrichment-helpers.js";

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
				await app.notificationService.notify({
					eventType: "PLEX_CONCURRENT_PEAK",
					title: "High concurrent streams detected",
					body: `${totalConcurrent} concurrent streams active (threshold: ${CONCURRENT_PEAK_THRESHOLD}).`,
					url: "/statistics",
				}).catch((err) => app.log.warn({ err, eventType: "PLEX_CONCURRENT_PEAK" }, "Non-fatal: notification delivery failed"));
			}

			// PLEX_TRANSCODE_HEAVY: transcode ratio exceeds threshold
			if (totalSessions > 0 && totalTranscode / totalSessions > TRANSCODE_HEAVY_RATIO) {
				const pct = Math.round((totalTranscode / totalSessions) * 100);
				await app.notificationService.notify({
					eventType: "PLEX_TRANSCODE_HEAVY",
					title: "Heavy transcoding detected",
					body: `${pct}% of active streams are transcoding (${totalTranscode}/${totalSessions}).`,
					url: "/statistics",
				}).catch((err) => app.log.warn({ err, eventType: "PLEX_TRANSCODE_HEAVY" }, "Non-fatal: notification delivery failed"));
			}

			// PLEX_NEW_DEVICE: platform not seen in recent snapshots
			for (const platform of enrichedPlatforms) {
				if (!knownPlatforms.has(platform)) {
					const safePlatform = platform.replace(/[<>&"']/g, "").slice(0, 50);
					await app.notificationService.notify({
						eventType: "PLEX_NEW_DEVICE",
						title: "New device detected",
						body: `A new platform "${safePlatform}" was seen streaming for the first time in ${NEW_DEVICE_LOOKBACK_DAYS} days.`,
						url: "/statistics",
					}).catch((err) => app.log.warn({ err, eventType: "PLEX_NEW_DEVICE" }, "Non-fatal: notification delivery failed"));
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

				// Aggregate LAN/WAN bandwidth from all enabled Tautulli instances
				const tautulliInstances = await app.prisma.serviceInstance.findMany({
					where: { service: "TAUTULLI", enabled: true },
				});
				let aggLanBandwidth = 0;
				let aggWanBandwidth = 0;
				let tautulliFetchFailures = 0;
				const allTautulliSessions: TautulliSessionItem[] = [];
				for (const ti of tautulliInstances) {
					try {
						const tc = createTautulliClient(app.encryptor, ti, app.log);
						const activity = await tc.getActivity();
						aggLanBandwidth += activity.lan_bandwidth || 0;
						aggWanBandwidth += activity.wan_bandwidth || 0;
						allTautulliSessions.push(...activity.sessions);
					} catch (err) {
						tautulliFetchFailures++;
						app.log.warn({ err, instanceId: ti.id }, "Failed to fetch Tautulli activity for LAN/WAN");
					}
				}

				// Build Tautulli session lookup for enriching sessionsJson with codec/resolution/platform
				const tautulliSessionMap = buildTautulliSessionMap(allTautulliSessions);

				// Only trust LAN/WAN data when all Tautulli instances responded successfully
				const hasCompleteTautulliData = tautulliInstances.length > 0 && tautulliFetchFailures === 0;

				if (tautulliFetchFailures > 0 && tautulliInstances.length > tautulliFetchFailures) {
					app.log.warn(
						{ failed: tautulliFetchFailures, total: tautulliInstances.length },
						"Partial Tautulli failure: discarding LAN/WAN data to avoid incomplete aggregation",
					);
				}

				// Track whether LAN/WAN has been attributed for this capture tick
				// to avoid double-counting across multiple Plex instances
				let lanWanAttributed = false;

				// Pre-fetch known platforms BEFORE writing new snapshots,
				// so the new-device check isn't polluted by this tick's data
				const knownPlatforms = new Set<string>();
				try {
					const platformCutoff = new Date(Date.now() - NEW_DEVICE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
					const recentSnapshots = await app.prisma.sessionSnapshot.findMany({
						where: { capturedAt: { gte: platformCutoff } },
						select: { sessionsJson: true },
						orderBy: { capturedAt: "desc" },
						take: 10000,
					});

					let platformParseFailures = 0;
					for (const snap of recentSnapshots) {
						try {
							const sessions: Array<{ platform?: string }> = JSON.parse(snap.sessionsJson);
							for (const s of sessions) {
								if (s.platform) knownPlatforms.add(s.platform);
							}
						} catch {
							platformParseFailures++;
						}
					}
					if (platformParseFailures > 0) {
						app.log.warn(
							{ parseFailures: platformParseFailures, totalSnapshots: recentSnapshots.length },
							"Failed to parse sessionsJson for new-device check — possible data corruption",
						);
					}
				} catch (err) {
					app.log.warn({ err }, "Session snapshot: failed to query known platforms for new-device check");
				}

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

						// Attribute LAN/WAN to only one snapshot per tick to prevent
						// double-counting when analytics routes aggregate across instances
						const lanWan = computeLanWanAttribution(
							hasCompleteTautulliData, lanWanAttributed, aggLanBandwidth, aggWanBandwidth,
						);
						// Mark attribution BEFORE the DB write to prevent
						// double-counting if the write fails and the next instance retries
						if (lanWan.attributed) lanWanAttributed = true;

						// Enrich Plex sessions with Tautulli codec/resolution/platform data
						const enrichedSessions = enrichSessionsWithTautulli(sessions, tautulliSessionMap);

						// Collect platforms for new-device notification
						for (const es of enrichedSessions) {
							if (es.platform) tickPlatforms.add(es.platform);
						}

						await app.prisma.sessionSnapshot.create({
							data: {
								instanceId: instance.id,
								concurrentStreams: sessions.length,
								totalBandwidth,
								lanBandwidth: lanWan.lanBandwidth,
								wanBandwidth: lanWan.wanBandwidth,
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
					checkPlexNotifications(tickTotalConcurrent, tickTotalTranscode, tickTotalSessions, tickPlatforms, knownPlatforms)
						.catch((err) => app.log.warn({ err }, "Session snapshot: notification check failed"));
				}
			} catch (err) {
				app.log.error({ err }, "Session snapshot scheduler: failed to query instances");
			} finally {
				isRunning = false;
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

		app.addHook("onReady", async () => {
			app.log.info("Session snapshot scheduler initialized (5m interval, 60s startup delay)");

			timeoutHandle = setTimeout(() => {
				captureSnapshots().catch((err) => {
					app.log.error({ err }, "Failed during initial session snapshot capture");
				});

				snapshotIntervalHandle = setInterval(() => {
					captureSnapshots().catch((err) => {
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
		dependencies: ["prisma", "security"],
	},
);

export default sessionSnapshotSchedulerPlugin;
