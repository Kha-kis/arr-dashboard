/**
 * Jellyfin Episode Cache Scheduler Plugin
 *
 * Periodically refreshes JellyfinEpisodeCache for recently-watched series.
 * Runs every 6 hours with a 6-minute startup delay (after jellyfin-cache at 45s).
 */

import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { createOwnedJellyfinPublicationSnapshot } from "../lib/jellyfin/jellyfin-cache-refresher.js";
import { refreshJellyfinEpisodeCache } from "../lib/jellyfin/jellyfin-episode-cache-refresher.js";
import type { ServiceInstance } from "../lib/prisma.js";
import { JOB_ID } from "../lib/scheduler-registry/job-definitions.js";
import { recordWatchProviderCacheRefreshFailure } from "../lib/services/provider-cache-status.js";
import { createProviderPublicationAuthority } from "../lib/services/provider-identity-guard.js";

const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const STARTUP_DELAY_MS = 6 * 60 * 1000; // 6 minutes (after jellyfin-cache populates)

export async function refreshScheduledJellyfinEpisodeCacheInstance(
	app: Pick<FastifyInstance, "encryptor" | "prisma" | "log">,
	instance: ServiceInstance,
): Promise<void> {
	const authority = createProviderPublicationAuthority(instance);
	let publicationInstance: ReturnType<typeof createOwnedJellyfinPublicationSnapshot>;
	try {
		publicationInstance = createOwnedJellyfinPublicationSnapshot(app.encryptor, instance);
	} catch (err) {
		app.log.error(
			{ err, instanceId: instance.id, label: instance.label },
			"Jellyfin episode cache refresh failed for instance",
		);
		await recordWatchProviderCacheRefreshFailure(
			app.prisma,
			"jellyfin_episode",
			"Provider credentials could not be decrypted.",
			authority,
			app.log,
		);
		return;
	}
	try {
		const result = await refreshJellyfinEpisodeCache({
			prisma: app.prisma,
			instance: publicationInstance,
			log: app.log,
		});
		app.log.info(
			{ instanceId: instance.id, label: instance.label, ...result },
			"Jellyfin episode cache refresh completed",
		);
	} catch (err) {
		app.log.error(
			{ err, instanceId: instance.id, label: instance.label },
			"Jellyfin episode cache refresh failed for instance",
		);
	}
}

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
				await app.schedulerRegistry.track(JOB_ID.jellyfinEpisodeCache, async () => {
					const instances = await app.prisma.serviceInstance.findMany({
						where: { service: { in: ["JELLYFIN", "EMBY"] }, enabled: true },
					});

					if (instances.length === 0) return;

					for (const instance of instances) {
						await refreshScheduledJellyfinEpisodeCacheInstance(app, instance);
					}
				});
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
	{ name: "jellyfin-episode-cache-scheduler", dependencies: ["scheduler-registry"] },
);

export default jellyfinEpisodeCacheSchedulerPlugin;
