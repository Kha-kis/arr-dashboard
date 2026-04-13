/**
 * Jellyfin Cache Scheduler Plugin
 *
 * Periodically refreshes JellyfinCache data from all enabled Jellyfin instances.
 * Runs every 6 hours with an initial 45-second startup delay (staggered with Plex at 30s).
 */

import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { refreshJellyfinCache } from "../lib/jellyfin/jellyfin-cache-refresher.js";
import { createJellyfinClient } from "../lib/jellyfin/jellyfin-client.js";
import { JOB_ID } from "../lib/scheduler-registry/job-definitions.js";

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
							const result = await refreshJellyfinCache(client, app.prisma, instance.id, app.log);
							app.log.info(
								{ instanceId: instance.id, label: instance.label, ...result },
								"Jellyfin cache refresh completed for instance",
							);

							// Track refresh status
							try {
								await app.prisma.cacheRefreshStatus.upsert({
									where: {
										instanceId_cacheType: { instanceId: instance.id, cacheType: "jellyfin" },
									},
									create: {
										instanceId: instance.id,
										cacheType: "jellyfin",
										lastRefreshedAt: new Date(),
										lastResult: result.errors > 0 ? "error" : "success",
										lastErrorMessage: result.errorMessages.join("; ").slice(0, 500) || null,
										itemCount: result.upserted,
									},
									update: {
										lastRefreshedAt: new Date(),
										lastResult: result.errors > 0 ? "error" : "success",
										lastErrorMessage: result.errorMessages.join("; ").slice(0, 500) || null,
										itemCount: result.upserted,
									},
								});
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
