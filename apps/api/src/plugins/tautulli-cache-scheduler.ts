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
import { refreshTautulliCache } from "../lib/tautulli/tautulli-cache-refresher.js";
import { createTautulliClient } from "../lib/tautulli/tautulli-client.js";

const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const STARTUP_DELAY_MS = 30_000; // 30 seconds

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
				const instances = await app.prisma.serviceInstance.findMany({
					where: { service: "TAUTULLI", enabled: true },
				});

				if (instances.length === 0) return;

				app.log.info(
					{ count: instances.length },
					"Starting Tautulli cache refresh for all instances",
				);

				for (const instance of instances) {
					try {
						const client = createTautulliClient(app.encryptor, instance, app.log);
						const result = await refreshTautulliCache(
							client,
							app.prisma,
							instance.id,
							app.log,
						);
						app.log.info(
							{ instanceId: instance.id, label: instance.label, ...result },
							"Tautulli cache refresh completed for instance",
						);
					} catch (err) {
						app.log.error(
							{ err, instanceId: instance.id, label: instance.label },
							"Tautulli cache refresh failed for instance",
						);
					}
				}
			} catch (err) {
				app.log.error({ err }, "Tautulli cache scheduler: failed to query instances");
			} finally {
				isRunning = false;
			}
		}

		app.addHook("onReady", async () => {
			app.log.info("Tautulli cache scheduler initialized (6h interval, 30s startup delay)");

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
		dependencies: ["prisma", "security"],
	},
);

export default tautulliCacheSchedulerPlugin;
