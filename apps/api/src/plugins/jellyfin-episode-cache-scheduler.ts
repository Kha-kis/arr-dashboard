/**
 * Jellyfin Episode Cache Scheduler Plugin
 *
 * Periodically refreshes JellyfinEpisodeCache for recently-watched series.
 * Runs every 6 hours with a 6-minute startup delay (after jellyfin-cache at 45s).
 */

import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { refreshJellyfinEpisodeCache } from "../lib/jellyfin/jellyfin-episode-cache-refresher.js";
import { createJellyfinClient } from "../lib/jellyfin/jellyfin-client.js";

const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const STARTUP_DELAY_MS = 6 * 60 * 1000; // 6 minutes (after jellyfin-cache populates)

const jellyfinEpisodeCacheSchedulerPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		let intervalHandle: ReturnType<typeof setInterval> | null = null;
		let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
		let isRunning = false;

		async function refreshAllEpisodeCaches() {
			if (isRunning) {
				app.log.warn("Jellyfin episode cache refresh already running, skipping");
				return;
			}
			isRunning = true;
			try {
				const instances = await app.prisma.serviceInstance.findMany({
					where: { service: "JELLYFIN", enabled: true },
				});

				if (instances.length === 0) return;

				for (const instance of instances) {
					try {
						const client = createJellyfinClient(app.encryptor, instance, app.log);
						const result = await refreshJellyfinEpisodeCache(
							client,
							app.prisma,
							instance.id,
							app.log,
						);
						app.log.info(
							{ instanceId: instance.id, label: instance.label, ...result },
							"Jellyfin episode cache refresh completed",
						);

						try {
							await app.prisma.cacheRefreshStatus.upsert({
								where: {
									instanceId_cacheType: {
										instanceId: instance.id,
										cacheType: "jellyfin_episode",
									},
								},
								create: {
									instanceId: instance.id,
									cacheType: "jellyfin_episode",
									lastRefreshedAt: new Date(),
									lastResult: result.errors > 0 ? "error" : "success",
									lastErrorMessage: null,
									itemCount: result.upserted,
								},
								update: {
									lastRefreshedAt: new Date(),
									lastResult: result.errors > 0 ? "error" : "success",
									lastErrorMessage: null,
									itemCount: result.upserted,
								},
							});
						} catch (statusErr) {
							app.log.warn(
								{ err: statusErr, instanceId: instance.id },
								"Failed to update Jellyfin episode cache refresh status",
							);
						}
					} catch (err) {
						app.log.error(
							{ err, instanceId: instance.id, label: instance.label },
							"Jellyfin episode cache refresh failed for instance",
						);
					}
				}
			} finally {
				isRunning = false;
			}
		}

		timeoutHandle = setTimeout(() => {
			refreshAllEpisodeCaches().catch((err) =>
				app.log.error({ err }, "Jellyfin episode cache initial refresh failed"),
			);
			intervalHandle = setInterval(() => {
				refreshAllEpisodeCaches().catch((err) =>
					app.log.error({ err }, "Jellyfin episode cache scheduled refresh failed"),
				);
			}, INTERVAL_MS);
		}, STARTUP_DELAY_MS);

		app.addHook("onClose", () => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (intervalHandle) clearInterval(intervalHandle);
		});

		app.log.info(
			{ intervalMs: INTERVAL_MS, startupDelayMs: STARTUP_DELAY_MS },
			"Jellyfin episode cache scheduler initialized",
		);
	},
	{ name: "jellyfin-episode-cache-scheduler" },
);

export default jellyfinEpisodeCacheSchedulerPlugin;
