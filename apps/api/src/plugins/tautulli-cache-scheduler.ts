/**
 * Tautulli Cache Scheduler Plugin
 *
 * Periodically refreshes TautulliCache data from all enabled Tautulli instances.
 * Runs every 6 hours with an initial 30-second startup delay.
 *
 * BUG FIX: The refreshTautulliCache() function existed but was never called,
 * meaning Tautulli cleanup rules silently matched nothing. This scheduler
 * wires it up to actually populate the cache.
 */

import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { JOB_ID } from "../lib/scheduler-registry/job-definitions.js";
import { recordProviderCacheRefreshFailure } from "../lib/services/provider-cache-status.js";
import { providerConnectionIdentity } from "../lib/services/provider-connection-guard.js";
import { refreshTautulliCache } from "../lib/tautulli/tautulli-cache-refresher.js";
import { createTautulliClient } from "../lib/tautulli/tautulli-client.js";
import { getErrorMessage } from "../lib/utils/error-message.js";

const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const STARTUP_DELAY_MS = 2 * 60_000; // 2 minutes — staggered after plex-cache (30s) to reduce peak memory

const tautulliCacheSchedulerPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		let intervalHandle: ReturnType<typeof setInterval> | null = null;
		let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
		let isRunning = false;

		async function refreshAllTautulliCaches() {
			if (isRunning) {
				app.log.warn("Tautulli cache refresh already running, skipping");
				return;
			}
			isRunning = true;
			try {
				await app.schedulerRegistry.track(JOB_ID.tautulliCache, async () => {
					const instances = await app.prisma.serviceInstance.findMany({
						where: { service: "TAUTULLI", enabled: true },
					});

					if (instances.length === 0) {
						app.log.debug("Tautulli cache refresh: no enabled Tautulli instances, skipping");
						return;
					}

					app.log.info(
						{ count: instances.length },
						"Starting Tautulli cache refresh for all instances",
					);

					for (const instance of instances) {
						const expectedConnection = providerConnectionIdentity(instance);
						try {
							const client = createTautulliClient(app.encryptor, instance, app.log);
							const result = await refreshTautulliCache(
								client,
								app.prisma,
								instance.id,
								app.log,
								expectedConnection,
							);
							app.log.info(
								{ instanceId: instance.id, label: instance.label, ...result },
								"Tautulli cache refresh completed for instance",
							);

							try {
								if (!result.complete || !result.completedAt) {
									await recordProviderCacheRefreshFailure(
										app.prisma,
										instance.id,
										"tautulli",
										result.errorMessages.slice(0, 3).join("; ").slice(0, 200) ||
											"Tautulli refresh did not produce a complete generation",
										expectedConnection,
										app.log,
									);
								}
							} catch (trackErr) {
								app.log.warn(
									{ err: trackErr, instanceId: instance.id },
									"Tautulli cache refreshed successfully but failed to record status",
								);
							}
						} catch (err) {
							app.log.error(
								{ err, instanceId: instance.id, label: instance.label },
								"Tautulli cache refresh failed for instance",
							);

							// Track failure
							await recordProviderCacheRefreshFailure(
								app.prisma,
								instance.id,
								"tautulli",
								getErrorMessage(err, "Unknown error"),
								expectedConnection,
								app.log,
							);
						}
					}

					// Check for stale caches (>12h since last successful refresh)
					const staleThreshold = new Date(Date.now() - 12 * 60 * 60 * 1000);
					const staleEntries = await app.prisma.cacheRefreshStatus.findMany({
						where: {
							cacheType: "tautulli",
							lastRefreshedAt: { lt: staleThreshold },
						},
						include: { instance: { select: { label: true } } },
					});
					if (staleEntries.length > 0) {
						const names = staleEntries
							.map((e) => e.instance.label.replace(/[<>&"']/g, "").slice(0, 50))
							.join(", ");
						app.log.warn(
							{ staleInstances: names },
							"Tautulli cache data is stale (>12h since last refresh)",
						);
						await app.notificationService
							.notify({
								eventType: "CACHE_REFRESH_STALE",
								title: "Tautulli cache data is stale",
								body: `Cache has not refreshed in over 12 hours for: ${names}`,
								url: "/settings",
							})
							.catch((notifyErr) => {
								app.log.warn({ err: notifyErr }, "Failed to send stale-cache notification");
							});
					}
				});
			} catch (err) {
				app.log.error({ err }, "Tautulli cache scheduler: failed to query instances");
			} finally {
				isRunning = false;
			}
		}

		app.addHook("onReady", async () => {
			app.log.info("Tautulli cache scheduler initialized (6h interval, 2min startup delay)");

			// Initial refresh after startup delay
			timeoutHandle = setTimeout(() => {
				refreshAllTautulliCaches().catch((err) => {
					app.log.error({ err }, "Failed during initial Tautulli cache refresh");
				});
				// Recurring refresh
				intervalHandle = setInterval(() => {
					refreshAllTautulliCaches().catch((err) => {
						app.log.error({ err }, "Failed during scheduled Tautulli cache refresh");
					});
				}, INTERVAL_MS);
			}, STARTUP_DELAY_MS);
		});

		app.addHook("onClose", async () => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (intervalHandle) clearInterval(intervalHandle);
			app.log.info("Tautulli cache scheduler stopped");
		});
	},
	{
		name: "tautulli-cache-scheduler",
		dependencies: ["prisma", "security", "notification-service", "scheduler-registry"],
	},
);

export default tautulliCacheSchedulerPlugin;
