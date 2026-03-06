/**
 * Plex Cache Scheduler Plugin
 *
 * Periodically refreshes PlexCache data from all enabled Plex instances.
 * Runs every 6 hours with an initial 30-second startup delay.
 */

import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { refreshPlexCache } from "../lib/plex/plex-cache-refresher.js";
import { createPlexClient } from "../lib/plex/plex-client.js";
import { getErrorMessage } from "../lib/utils/error-message.js";

const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const STARTUP_DELAY_MS = 30_000; // 30 seconds

const plexCacheSchedulerPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		let intervalHandle: ReturnType<typeof setInterval> | null = null;
		let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
		let isRunning = false;

		async function refreshAllPlexCaches() {
			if (isRunning) {
				app.log.warn("Plex cache refresh already running, skipping");
				return;
			}
			isRunning = true;
			try {
				const instances = await app.prisma.serviceInstance.findMany({
					where: { service: "PLEX", enabled: true },
				});

				if (instances.length === 0) {
					app.log.debug("Plex cache refresh: no enabled Plex instances, skipping");
					return;
				}

				app.log.info(
					{ count: instances.length },
					"Starting Plex cache refresh for all instances",
				);

				for (const instance of instances) {
					try {
						const client = createPlexClient(app.encryptor, instance, app.log);
						const result = await refreshPlexCache(
							client,
							app.prisma,
							instance.id,
							app.log,
						);
						app.log.info(
							{ instanceId: instance.id, label: instance.label, ...result },
							"Plex cache refresh completed for instance",
						);

						// Track refresh status — separate try so a DB failure
						// doesn't masquerade as a refresh failure in the outer catch
						try {
							await app.prisma.cacheRefreshStatus.upsert({
								where: { instanceId_cacheType: { instanceId: instance.id, cacheType: "plex" } },
								create: {
									instanceId: instance.id,
									cacheType: "plex",
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
								"Plex cache refreshed successfully but failed to record status",
							);
						}
					} catch (err) {
						app.log.error(
							{ err, instanceId: instance.id, label: instance.label },
							"Plex cache refresh failed for instance",
						);

						// Track failure
						await app.prisma.cacheRefreshStatus.upsert({
							where: { instanceId_cacheType: { instanceId: instance.id, cacheType: "plex" } },
							create: {
								instanceId: instance.id,
								cacheType: "plex",
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
							app.log.warn({ err: trackErr, originalErr: getErrorMessage(err, "Unknown error"), instanceId: instance.id }, "Failed to record cache refresh failure status");
						});
					}
				}

				// Check for stale caches (>12h since last successful refresh)
				const staleThreshold = new Date(Date.now() - 12 * 60 * 60 * 1000);
				const staleEntries = await app.prisma.cacheRefreshStatus.findMany({
					where: {
						cacheType: "plex",
						lastRefreshedAt: { lt: staleThreshold },
					},
					include: { instance: { select: { label: true } } },
				});
				if (staleEntries.length > 0) {
					const names = staleEntries.map((e) => e.instance.label.replace(/[<>&"']/g, "").slice(0, 50)).join(", ");
					app.log.warn(
						{ staleInstances: names },
						"Plex cache data is stale (>12h since last refresh)",
					);
					await app.notificationService.notify({
						eventType: "CACHE_REFRESH_STALE",
						title: "Plex cache data is stale",
						body: `Cache has not refreshed in over 12 hours for: ${names}`,
						url: "/settings",
					}).catch((notifyErr) => {
						app.log.warn({ err: notifyErr }, "Failed to send stale-cache notification");
					});
				}
			} catch (err) {
				app.log.error({ err }, "Plex cache scheduler: failed to query instances");
			} finally {
				isRunning = false;
			}
		}

		app.addHook("onReady", async () => {
			app.log.info("Plex cache scheduler initialized (6h interval, 30s startup delay)");

			// Initial refresh after startup delay
			timeoutHandle = setTimeout(() => {
				refreshAllPlexCaches().catch((err) => {
					app.log.error({ err }, "Failed during initial Plex cache refresh");
				});
				// Recurring refresh
				intervalHandle = setInterval(() => {
					refreshAllPlexCaches().catch((err) => {
						app.log.error({ err }, "Failed during scheduled Plex cache refresh");
					});
				}, INTERVAL_MS);
			}, STARTUP_DELAY_MS);
		});

		app.addHook("onClose", async () => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (intervalHandle) clearInterval(intervalHandle);
			app.log.info("Plex cache scheduler stopped");
		});
	},
	{
		name: "plex-cache-scheduler",
		dependencies: ["prisma", "security", "notification-service"],
	},
);

export default plexCacheSchedulerPlugin;
