/**
 * Plex Episode Cache Scheduler Plugin
 *
 * Periodically refreshes PlexEpisodeCache data from all enabled Plex instances.
 * Runs every 6 hours with a 45-second startup delay (after plex-cache-scheduler
 * at 30s, since episode refresher reads from PlexCache).
 */

import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { refreshPlexEpisodeCache } from "../lib/plex/plex-episode-cache-refresher.js";
import { createPlexClient } from "../lib/plex/plex-client.js";
import { getErrorMessage } from "../lib/utils/error-message.js";

const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const STARTUP_DELAY_MS = 45_000; // 45 seconds

const plexEpisodeCacheSchedulerPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		let intervalHandle: ReturnType<typeof setInterval> | null = null;
		let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
		let isRunning = false;

		async function refreshAllEpisodeCaches() {
			if (isRunning) {
				app.log.warn("Plex episode cache refresh already running, skipping");
				return;
			}
			isRunning = true;
			try {
				const instances = await app.prisma.serviceInstance.findMany({
					where: { service: "PLEX", enabled: true },
				});

				if (instances.length === 0) {
					app.log.debug("Plex episode cache refresh: no enabled Plex instances, skipping");
					return;
				}

				app.log.info(
					{ count: instances.length },
					"Starting Plex episode cache refresh for all instances",
				);

				for (const instance of instances) {
					try {
						const client = createPlexClient(app.encryptor, instance, app.log);
						const result = await refreshPlexEpisodeCache(
							client,
							app.prisma,
							instance.id,
							app.log,
						);
						app.log.info(
							{ instanceId: instance.id, label: instance.label, ...result },
							"Plex episode cache refresh completed for instance",
						);

						// Track refresh status — separate try so a DB failure
						// doesn't masquerade as a refresh failure in the outer catch
						try {
							await app.prisma.cacheRefreshStatus.upsert({
								where: { instanceId_cacheType: { instanceId: instance.id, cacheType: "plex_episode" } },
								create: {
									instanceId: instance.id,
									cacheType: "plex_episode",
									lastRefreshedAt: new Date(),
									lastResult: result.errors > 0 ? "error" : "success",
									lastErrorMessage: result.errors > 0 ? `${result.errors} item errors` : null,
									itemCount: result.upserted,
								},
								update: {
									lastRefreshedAt: new Date(),
									lastResult: result.errors > 0 ? "error" : "success",
									lastErrorMessage: result.errors > 0 ? `${result.errors} item errors` : null,
									itemCount: result.upserted,
								},
							});
						} catch (trackErr) {
							app.log.warn(
								{ err: trackErr, instanceId: instance.id },
								"Episode cache refreshed successfully but failed to record status",
							);
						}
					} catch (err) {
						app.log.error(
							{ err, instanceId: instance.id, label: instance.label },
							"Plex episode cache refresh failed for instance",
						);

						// Track failure
						await app.prisma.cacheRefreshStatus.upsert({
							where: { instanceId_cacheType: { instanceId: instance.id, cacheType: "plex_episode" } },
							create: {
								instanceId: instance.id,
								cacheType: "plex_episode",
								lastRefreshedAt: new Date(),
								lastResult: "error",
								lastErrorMessage: getErrorMessage(err, "Unknown error"),
								itemCount: 0,
							},
							update: {
								lastRefreshedAt: new Date(),
								lastResult: "error",
								lastErrorMessage: getErrorMessage(err, "Unknown error"),
							},
						}).catch((trackErr) => {
							app.log.warn({ err: trackErr, originalErr: getErrorMessage(err, "Unknown error"), instanceId: instance.id }, "Failed to record episode cache refresh failure status");
						});
					}
				}

				// Check for stale caches (>12h since last successful refresh)
				const staleThreshold = new Date(Date.now() - 12 * 60 * 60 * 1000);
				const staleEntries = await app.prisma.cacheRefreshStatus.findMany({
					where: {
						cacheType: "plex_episode",
						lastRefreshedAt: { lt: staleThreshold },
					},
					include: { instance: { select: { label: true } } },
				});
				if (staleEntries.length > 0) {
					const names = staleEntries.map((e) => e.instance.label.replace(/[<>&"']/g, "").slice(0, 50)).join(", ");
					app.log.warn(
						{ staleInstances: names },
						"Plex episode cache data is stale (>12h since last refresh)",
					);
					await app.notificationService.notify({
						eventType: "CACHE_REFRESH_STALE",
						title: "Plex episode cache data is stale",
						body: `Episode cache has not refreshed in over 12 hours for: ${names}`,
						url: "/settings",
					}).catch((notifyErr) => {
						app.log.warn({ err: notifyErr }, "Failed to send stale-cache notification");
					});
				}
			} catch (err) {
				app.log.error({ err }, "Plex episode cache scheduler: failed to query instances");
			} finally {
				isRunning = false;
			}
		}

		app.addHook("onReady", async () => {
			app.log.info("Plex episode cache scheduler initialized (6h interval, 45s startup delay)");

			// Initial refresh after startup delay
			timeoutHandle = setTimeout(() => {
				refreshAllEpisodeCaches().catch((err) => {
					app.log.error({ err }, "Failed during initial Plex episode cache refresh");
				});
				// Recurring refresh
				intervalHandle = setInterval(() => {
					refreshAllEpisodeCaches().catch((err) => {
						app.log.error({ err }, "Failed during scheduled Plex episode cache refresh");
					});
				}, INTERVAL_MS);
			}, STARTUP_DELAY_MS);
		});

		app.addHook("onClose", async () => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (intervalHandle) clearInterval(intervalHandle);
			app.log.info("Plex episode cache scheduler stopped");
		});
	},
	{
		name: "plex-episode-cache-scheduler",
		dependencies: ["prisma", "security", "notification-service"],
	},
);

export default plexEpisodeCacheSchedulerPlugin;
