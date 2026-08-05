/**
 * Jellyfin Cache Scheduler Plugin
 *
 * Periodically refreshes JellyfinCache data from all enabled Jellyfin instances.
 * Runs every 6 hours with an initial 45-second startup delay (staggered with Plex at 30s).
 */

import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { recordCacheRefreshFailure } from "../lib/cache-refresh-status.js";
import { refreshJellyfinCache } from "../lib/jellyfin/jellyfin-cache-refresher.js";
import { runJellyfinCacheRefreshSingleFlight } from "../lib/jellyfin/jellyfin-cache-singleflight.js";
import { createJellyfinClient } from "../lib/jellyfin/jellyfin-client.js";
import { JOB_ID } from "../lib/scheduler-registry/job-definitions.js";
import { getErrorMessage } from "../lib/utils/error-message.js";

const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const STARTUP_DELAY_MS = 45_000; // 45 seconds

const jellyfinCacheSchedulerPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		let intervalHandle: ReturnType<typeof setInterval> | null = null;
		let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
		let isRunning = false;

		async function refreshAllJellyfinCaches() {
			if (isRunning) {
				app.log.warn("Jellyfin cache refresh already running, skipping");
				return;
			}
			isRunning = true;
			try {
				await app.schedulerRegistry.track(JOB_ID.jellyfinCache, async () => {
					const instances = await app.prisma.serviceInstance.findMany({
						where: { service: { in: ["JELLYFIN", "EMBY"] }, enabled: true },
					});

					if (instances.length === 0) {
						app.log.debug("Jellyfin cache refresh: no enabled Jellyfin instances, skipping");
						return;
					}

					app.log.info(
						{ count: instances.length },
						"Starting Jellyfin cache refresh for all instances",
					);

					for (const instance of instances) {
						try {
							const client = createJellyfinClient(app.encryptor, instance, app.log);
							const result = await runJellyfinCacheRefreshSingleFlight(instance.id, () =>
								refreshJellyfinCache(client, app.prisma, instance.id, app.log),
							);
							app.log.info(
								{ instanceId: instance.id, label: instance.label, ...result },
								"Jellyfin cache refresh completed for instance",
							);

							try {
								if (!result.complete || !result.completedAt) {
									await recordCacheRefreshFailure(
										app.prisma,
										instance.id,
										"jellyfin",
										result.errorMessages.join("; ").slice(0, 500) ||
											"Jellyfin refresh did not produce a complete generation",
									);
								}
							} catch (statusErr) {
								app.log.warn(
									{ err: statusErr, instanceId: instance.id },
									"Failed to update Jellyfin cache refresh status",
								);
							}
						} catch (err) {
							app.log.error(
								{ err, instanceId: instance.id, label: instance.label },
								"Jellyfin cache refresh failed for instance",
							);
							await recordCacheRefreshFailure(
								app.prisma,
								instance.id,
								"jellyfin",
								getErrorMessage(err, "Unknown error"),
							).catch((statusErr) => {
								app.log.warn(
									{ err: statusErr, instanceId: instance.id },
									"Failed to record Jellyfin cache refresh failure status",
								);
							});
						}
					}
				});
			} finally {
				isRunning = false;
			}
		}

		// Stagger startup, then run on interval
		timeoutHandle = setTimeout(() => {
			refreshAllJellyfinCaches().catch((err) =>
				app.log.error({ err }, "Jellyfin cache initial refresh failed"),
			);
			intervalHandle = setInterval(() => {
				refreshAllJellyfinCaches().catch((err) =>
					app.log.error({ err }, "Jellyfin cache scheduled refresh failed"),
				);
			}, INTERVAL_MS);
		}, STARTUP_DELAY_MS);

		app.addHook("onClose", () => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (intervalHandle) clearInterval(intervalHandle);
		});

		app.log.info(
			{ intervalMs: INTERVAL_MS, startupDelayMs: STARTUP_DELAY_MS },
			"Jellyfin cache scheduler initialized",
		);
	},
	{ name: "jellyfin-cache-scheduler", dependencies: ["scheduler-registry"] },
);

export default jellyfinCacheSchedulerPlugin;
