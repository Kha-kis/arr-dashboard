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

				if (instances.length === 0) return;

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
					} catch (err) {
						app.log.error(
							{ err, instanceId: instance.id, label: instance.label },
							"Plex cache refresh failed for instance",
						);
					}
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
		dependencies: ["prisma", "security"],
	},
);

export default plexCacheSchedulerPlugin;
