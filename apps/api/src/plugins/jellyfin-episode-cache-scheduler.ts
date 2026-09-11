/**
 * Jellyfin Episode Cache Scheduler Plugin
 *
 * Periodically refreshes JellyfinEpisodeCache for recently-watched series.
 * Runs every 6 hours with a 6-minute startup delay (after jellyfin-cache at 45s).
 */

import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { runJellyfinCacheRefreshSingleFlight } from "../lib/jellyfin/jellyfin-cache-singleflight.js";
import { refreshOwnedJellyfinEpisodeCache } from "../lib/jellyfin/jellyfin-episode-cache-refresher.js";
import { JELLYFIN_EPISODE_SUCCESSFUL_PROGRESS_CONTINUATION_DELAY_MS } from "../lib/jellyfin/jellyfin-episode-refresh-policy.js";
import type { ServiceInstance } from "../lib/prisma.js";
import type { AutomaticObservationRenewalMode } from "../lib/provider-observation/observation-run-repository.js";
import { JOB_ID } from "../lib/scheduler-registry/job-definitions.js";
import { ensureEpisodeRefreshScheduler } from "../lib/services/episode-refresh-scheduler-bridge.js";
import { createProviderPublicationAuthority } from "../lib/services/provider-identity-guard.js";

const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const STARTUP_DELAY_MS = 6 * 60 * 1000; // 6 minutes (after jellyfin-cache populates)
const TRANSIENT_IDENTITY_RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;
const MAX_CATALOG_REPLANS_PER_CHAIN = 1;

export async function refreshScheduledJellyfinEpisodeCacheInstance(
	app: Pick<FastifyInstance, "encryptor" | "prisma" | "log">,
	instance: ServiceInstance,
	resumeFailed = true,
	automaticRenewal: AutomaticObservationRenewalMode | "none" = "none",
): Promise<Awaited<ReturnType<typeof refreshOwnedJellyfinEpisodeCache>> | null> {
	try {
		const authority = createProviderPublicationAuthority(instance);
		const result = await runJellyfinCacheRefreshSingleFlight(
			authority,
			"jellyfin_episode",
			async () =>
				await refreshOwnedJellyfinEpisodeCache({
					prisma: app.prisma,
					encryptor: app.encryptor,
					instance,
					log: app.log,
					resumeFailed,
					...(automaticRenewal !== "none" ? { automaticRenewal } : {}),
				}),
		);
		app.log.info(
			{
				instanceId: instance.id,
				complete: result.complete,
				upserted: result.upserted,
				errors: result.errors,
			},
			"Jellyfin episode cache refresh completed",
		);
		return result;
	} catch {
		app.log.error(
			{ instanceId: instance.id, category: "refresh-failed" },
			"Jellyfin episode cache refresh failed for instance",
		);
		return null;
	}
}

const jellyfinEpisodeCacheSchedulerPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		let intervalHandle: ReturnType<typeof setInterval> | null = null;
		let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
		let isRunning = false;
		let closing = false;
		const runningInstances = new Set<string>();
		const pendingInstanceIds = new Set<string>();
		const continuationHandles = new Set<ReturnType<typeof setTimeout>>();
		const admittedPageTasks = new Set<Promise<void>>();

		async function refreshInstance(
			instance: ServiceInstance,
			resumeFailed: boolean,
			transientIdentityRetry = 0,
			catalogReplans = 0,
			automaticRenewal: AutomaticObservationRenewalMode | "none" = "none",
		) {
			if (closing || runningInstances.has(instance.id) || pendingInstanceIds.has(instance.id))
				return;
			runningInstances.add(instance.id);
			try {
				const result = await refreshScheduledJellyfinEpisodeCacheInstance(
					app,
					instance,
					resumeFailed,
					automaticRenewal,
				);
				if (closing || !result || result.complete || result.superseded || result.renewalDeferred)
					return;
				const activeRun =
					result.errors > 0
						? await app.prisma.providerObservationRun.findFirst({
								where: {
									instanceId: instance.id,
									provider: "jellyfin_episode",
									cacheType: "jellyfin_episode",
									state: { in: ["running", "failed"] },
									activeSlotKey: { not: null },
								},
								select: { state: true, nextAttemptAt: true },
							})
						: null;
				if (closing) return;
				let nextTransientIdentityRetry = 0;
				let nextCatalogReplans = catalogReplans;
				let delay = result.progressed
					? JELLYFIN_EPISODE_SUCCESSFUL_PROGRESS_CONTINUATION_DELAY_MS
					: 30_000;
				if (result.errors > 0) {
					if (result.replanRequired) {
						// A settled invalid plan has no active run. Never take over a
						// replacement worker, or reset this budget after a successful page.
						if (activeRun || catalogReplans >= MAX_CATALOG_REPLANS_PER_CHAIN) return;
						delay = 30_000;
						nextCatalogReplans += 1;
					} else if (!activeRun) return;
					else if (activeRun.state === "failed") {
						if (!activeRun.nextAttemptAt) return;
						delay = Math.max(0, activeRun.nextAttemptAt.getTime() - Date.now());
					} else {
						const transientDelay = TRANSIENT_IDENTITY_RETRY_DELAYS_MS[transientIdentityRetry];
						if (transientDelay === undefined) return;
						delay = transientDelay;
						nextTransientIdentityRetry = transientIdentityRetry + 1;
					}
				}
				scheduleContinuation(instance, delay, nextTransientIdentityRetry, nextCatalogReplans);
			} catch {
				app.log.error(
					{ category: "episode-continuation-state-failed" },
					"Jellyfin episode cache continuation state unavailable",
				);
			} finally {
				runningInstances.delete(instance.id);
			}
		}

		function scheduleContinuation(
			instance: ServiceInstance,
			delay: number,
			transientIdentityRetry: number,
			catalogReplans: number,
		) {
			if (closing || pendingInstanceIds.has(instance.id)) return;
			pendingInstanceIds.add(instance.id);
			const handle = setTimeout(() => {
				continuationHandles.delete(handle);
				pendingInstanceIds.delete(instance.id);
				void admitRefreshInstance(instance, false, transientIdentityRetry, catalogReplans);
			}, delay);
			continuationHandles.add(handle);
		}

		function admitRefreshInstance(
			instance: ServiceInstance,
			resumeFailed: boolean,
			transientIdentityRetry = 0,
			catalogReplans = 0,
			automaticRenewal: AutomaticObservationRenewalMode | "none" = "none",
		): Promise<void> {
			const pageTask = refreshInstance(
				instance,
				resumeFailed,
				transientIdentityRetry,
				catalogReplans,
				automaticRenewal,
			).then(() => undefined);
			admittedPageTasks.add(pageTask);
			void pageTask.finally(() => admittedPageTasks.delete(pageTask)).catch(() => undefined);
			return pageTask;
		}

		async function refreshAllEpisodeCaches(
			resumeFailed: boolean,
			automaticRenewal: AutomaticObservationRenewalMode | "none" = "none",
		) {
			if (closing) return;
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

					await Promise.all(
						instances.map(
							async (instance) =>
								await admitRefreshInstance(instance, resumeFailed, 0, 0, automaticRenewal),
						),
					);
				});
			} finally {
				isRunning = false;
			}
		}

		const schedulerBridge = ensureEpisodeRefreshScheduler(app);
		const unregisterRetry = schedulerBridge.episodeRefreshScheduler.register(
			"jellyfin_episode",
			async ({ userId, instanceId }) => {
				if (closing) return { status: "unavailable" };
				try {
					const instance = await app.prisma.serviceInstance.findFirst({
						where: {
							id: instanceId,
							userId,
							service: { in: ["JELLYFIN", "EMBY"] },
							enabled: true,
						},
					});
					if (!instance) return { status: "ineligible" };
					if (closing) return { status: "unavailable" };
					if (runningInstances.has(instance.id) || pendingInstanceIds.has(instance.id)) {
						return { status: "accepted" };
					}
					const backgroundTask = admitRefreshInstance(instance, true);
					return { status: "accepted", backgroundTask };
				} catch {
					return { status: "unavailable" };
				}
			},
		);

		app.addHook("onReady", async () => {
			timeoutHandle = setTimeout(() => {
				if (closing) return;
				refreshAllEpisodeCaches(true).catch(() =>
					app.log.error(
						{ category: "initial-refresh-failed" },
						"Jellyfin episode cache initial refresh failed",
					),
				);
				intervalHandle = setInterval(() => {
					refreshAllEpisodeCaches(false, "provider-unavailable-cooldown").catch(() =>
						app.log.error(
							{ category: "scheduled-refresh-failed" },
							"Jellyfin episode cache scheduled refresh failed",
						),
					);
				}, INTERVAL_MS);
			}, STARTUP_DELAY_MS);
		});

		app.addHook("onClose", async () => {
			closing = true;
			unregisterRetry();
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (intervalHandle) clearInterval(intervalHandle);
			for (const handle of continuationHandles) clearTimeout(handle);
			continuationHandles.clear();
			pendingInstanceIds.clear();
			await Promise.allSettled([...admittedPageTasks]);
		});

		app.log.info(
			{ intervalMs: INTERVAL_MS, startupDelayMs: STARTUP_DELAY_MS },
			"Jellyfin episode cache scheduler initialized",
		);
	},
	{
		name: "jellyfin-episode-cache-scheduler",
		dependencies: ["prisma", "security", "scheduler-registry"],
	},
);

export default jellyfinEpisodeCacheSchedulerPlugin;
