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
import type { ServiceInstance } from "../lib/prisma.js";
import { JOB_ID } from "../lib/scheduler-registry/job-definitions.js";
import { recordWatchProviderCacheRefreshFailure } from "../lib/services/provider-cache-status.js";
import {
	createProviderPublicationAuthority,
	type ProviderPublicationAuthority,
} from "../lib/services/provider-identity-guard.js";
import {
	createOwnedTautulliPublicationSnapshot,
	refreshTautulliCache,
	summarizeTautulliRefreshResultForLog,
} from "../lib/tautulli/tautulli-cache-refresher.js";

const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const STARTUP_DELAY_MS = 2 * 60_000; // 2 minutes — staggered after plex-cache (30s) to reduce peak memory

export async function refreshScheduledTautulliCacheInstance(
	app: Pick<FastifyInstance, "encryptor" | "prisma" | "log">,
	instance: ServiceInstance,
): Promise<void> {
	const authority = createProviderPublicationAuthority(instance);
	let publicationInstance: ReturnType<typeof createOwnedTautulliPublicationSnapshot> | undefined;
	try {
		publicationInstance = createOwnedTautulliPublicationSnapshot(app.encryptor, instance);
		const result = await refreshTautulliCache({
			prisma: app.prisma,
			instance: publicationInstance,
			log: app.log,
		});
		app.log.info(
			{ instanceId: instance.id, ...summarizeTautulliRefreshResultForLog(result) },
			"Tautulli cache refresh completed for instance",
		);
	} catch {
		app.log.error(
			{
				instanceId: instance.id,
				reasonCode: publicationInstance
					? "unexpected_refresh_rejection"
					: "credentials_unavailable",
			},
			"Tautulli cache refresh failed for instance",
		);
		if (!publicationInstance) {
			await recordScheduledTautulliFailure(
				app,
				authority,
				"Provider credentials could not be decrypted.",
			);
		}
	}
}

async function recordScheduledTautulliFailure(
	app: Pick<FastifyInstance, "prisma" | "log">,
	publicationInstance: ProviderPublicationAuthority,
	message: string,
): Promise<void> {
	try {
		await recordWatchProviderCacheRefreshFailure(
			app.prisma,
			"tautulli",
			message,
			publicationInstance,
			{
				warn: () =>
					app.log.warn(
						{ instanceId: publicationInstance.id, reasonCode: "status_record_failed" },
						"Tautulli cache refresh failed to record status",
					),
			} as Pick<typeof app.log, "warn">,
		);
	} catch {
		app.log.warn(
			{ instanceId: publicationInstance.id, reasonCode: "status_record_failed" },
			"Tautulli cache refresh failed to record status",
		);
	}
}

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
						await refreshScheduledTautulliCacheInstance(app, instance);
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
