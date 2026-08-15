/**
 * Jellyfin Cache Scheduler Plugin
 *
 * Periodically refreshes JellyfinCache data from all enabled Jellyfin instances.
 * Runs every 6 hours with an initial 45-second startup delay (staggered with Plex at 30s).
 */

import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import {
	createOwnedJellyfinPublicationSnapshot,
	refreshJellyfinCache,
} from "../lib/jellyfin/jellyfin-cache-refresher.js";
import { runJellyfinCacheRefreshSingleFlight } from "../lib/jellyfin/jellyfin-cache-singleflight.js";
import type { ServiceInstance } from "../lib/prisma.js";
import { JOB_ID } from "../lib/scheduler-registry/job-definitions.js";
import { recordWatchProviderCacheRefreshFailure } from "../lib/services/provider-cache-status.js";
import { createProviderPublicationAuthority } from "../lib/services/provider-identity-guard.js";

const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const STARTUP_DELAY_MS = 45_000; // 45 seconds

export async function refreshScheduledJellyfinCacheInstance(
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
			"Jellyfin cache refresh failed for instance",
		);
		await recordWatchProviderCacheRefreshFailure(
			app.prisma,
			"jellyfin",
			"Provider credentials could not be decrypted.",
			authority,
			app.log,
		);
		return;
	}

	try {
		const result = await runJellyfinCacheRefreshSingleFlight(
			publicationInstance,
			async () =>
				await refreshJellyfinCache({
					prisma: app.prisma,
					instance: publicationInstance,
					log: app.log,
				}),
			{ prisma: app.prisma, log: app.log },
		);
		app.log.info(
			{ instanceId: instance.id, label: instance.label, ...result },
			"Jellyfin cache refresh completed for instance",
		);
	} catch (err) {
		app.log.error(
			{ err, instanceId: instance.id, label: instance.label },
			"Jellyfin cache refresh failed for instance",
		);
	}
}

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
						await refreshScheduledJellyfinCacheInstance(app, instance);
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
