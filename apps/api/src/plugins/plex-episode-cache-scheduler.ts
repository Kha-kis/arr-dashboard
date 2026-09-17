/**
 * Plex Episode Cache Scheduler Plugin
 *
 * Periodically refreshes PlexEpisodeCache data from all enabled Plex instances.
 * Runs every 6 hours with a 45-second startup delay (after plex-cache-scheduler
 * at 30s, since episode refresher reads from PlexCache).
 */

import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { getPublishedEpisodeGenerationObservation } from "../lib/plex/plex-persisted-observation-repository.js";
import { refreshOwnedPlexEpisodeCache } from "../lib/plex/plex-refresh-orchestration.js";
import { JOB_ID } from "../lib/scheduler-registry/job-definitions.js";
import { ensureEpisodeRefreshScheduler } from "../lib/services/episode-refresh-scheduler-bridge.js";
import type { PlexCacheRefreshAttempt } from "../lib/services/provider-cache-status.js";

const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const STARTUP_DELAY_MS = 5 * 60_000; // 5 minutes — staggered well after plex-cache (30s) + tautulli (2min) to avoid overlapping memory peaks
const DEPENDENCY_RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000] as const;
const EXCEPTION_RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000] as const;

type RefreshErrorCategory =
	| "database-busy"
	| "serialization-conflict"
	| "transaction-error"
	| "unknown";

function classifyRefreshError(error: unknown): RefreshErrorCategory {
	if (typeof error !== "object" || error === null) return "unknown";
	let code: unknown;
	try {
		code = (error as { code?: unknown }).code;
	} catch {
		return "unknown";
	}
	if (typeof code !== "string") return "unknown";
	switch (code) {
		case "DB_BUSY":
		case "SQLITE_BUSY":
		case "SQLITE_BUSY_TIMEOUT":
			return "database-busy";
		case "P2034":
			return "serialization-conflict";
		case "P2028":
			return "transaction-error";
		default:
			return "unknown";
	}
}

export function plexEpisodeRefreshResultStatus(result: {
	errors: number;
	upserted: number;
	refreshedShows: number;
	capacityDegraded: boolean;
}): "success" | "partial" | "error" {
	if (result.errors > 0) {
		return result.upserted > 0 ? "partial" : "error";
	}
	return result.capacityDegraded ? "partial" : "success";
}

const plexEpisodeCacheSchedulerPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		let intervalHandle: ReturnType<typeof setInterval> | null = null;
		let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
		let isRunning = false;
		let closed = false;
		const runningInstances = new Set<string>();
		const pendingInstanceIds = new Set<string>();
		const continuationHandles = new Set<ReturnType<typeof setTimeout>>();
		const admittedPageTasks = new Set<Promise<void>>();
		const retainedAttempts = new Map<string, PlexCacheRefreshAttempt>();

		async function refreshInstance(
			instance: Awaited<ReturnType<typeof app.prisma.serviceInstance.findMany>>[number],
			resumeFailed: boolean,
			dependencyRetry = 0,
			exceptionRetry = 0,
		) {
			if (closed || runningInstances.has(instance.id) || pendingInstanceIds.has(instance.id))
				return;
			runningInstances.add(instance.id);
			let phase: "runner" | "retry-state-read" = "runner";
			try {
				const retainedAttempt = retainedAttempts.get(instance.id);
				const result = await refreshOwnedPlexEpisodeCache(
					{
						prisma: app.prisma,
						encryptor: app.encryptor,
						instance,
						log: app.log,
						resumeFailed,
					},
					retainedAttempt,
				);
				if (closed) return;
				if (result.continuationAttempt) {
					retainedAttempts.set(instance.id, result.continuationAttempt);
				} else {
					retainedAttempts.delete(instance.id);
				}
				app.log.info(
					{
						category: "plex-episode-cache-refresh-completed",
						upserted: result.upserted,
						errors: result.errors,
						refreshedShows: result.refreshedShows,
						complete: result.complete,
					},
					"Plex episode cache refresh completed",
				);
				if (result.superseded) return;
				if (result.retryCategory === "parent-refresh-in-progress") {
					scheduleContinuation(instance, DEPENDENCY_RETRY_DELAYS_MS[0], 0, exceptionRetry);
					return;
				}
				if (result.retryCategory) {
					const dependencyRetryDelay = DEPENDENCY_RETRY_DELAYS_MS[dependencyRetry];
					if (dependencyRetryDelay !== undefined) {
						scheduleContinuation(
							instance,
							dependencyRetryDelay,
							dependencyRetry + 1,
							exceptionRetry,
						);
					}
					return;
				}
				phase = "retry-state-read";
				const failedRun =
					result.errors > 0
						? await app.prisma.providerObservationRun.findFirst({
								where: {
									instanceId: instance.id,
									provider: "plex_episode",
									cacheType: "plex_episode",
									state: "failed",
								},
								select: { nextAttemptAt: true },
							})
						: null;
				const delay = failedRun?.nextAttemptAt
					? Math.max(0, failedRun.nextAttemptAt.getTime() - Date.now())
					: 30_000;
				if (closed) return;
				if (!result.complete && (result.errors === 0 || failedRun?.nextAttemptAt)) {
					scheduleContinuation(instance, delay, 0, exceptionRetry);
				}
			} catch (error) {
				const errorCategory = classifyRefreshError(error);
				const retryDelay = EXCEPTION_RETRY_DELAYS_MS[exceptionRetry];
				if (retryDelay === undefined) {
					app.log.error(
						{
							category: "plex-episode-cache-refresh-retry-exhausted",
							phase,
							errorCategory,
						},
						"Plex episode cache refresh exception retries exhausted",
					);
				} else {
					app.log.error(
						{
							category: "plex-episode-cache-refresh-failed",
							phase,
							errorCategory,
						},
						"Plex episode cache refresh failed",
					);
					if (!closed) {
						scheduleContinuation(instance, retryDelay, dependencyRetry, exceptionRetry + 1);
					}
				}
			} finally {
				runningInstances.delete(instance.id);
			}
		}

		function scheduleContinuation(
			instance: Awaited<ReturnType<typeof app.prisma.serviceInstance.findMany>>[number],
			delay: number,
			dependencyRetry = 0,
			exceptionRetry = 0,
		) {
			if (closed || pendingInstanceIds.has(instance.id)) return;
			pendingInstanceIds.add(instance.id);
			const handle = setTimeout(() => {
				continuationHandles.delete(handle);
				pendingInstanceIds.delete(instance.id);
				void admitRefreshInstance(instance, false, dependencyRetry, exceptionRetry);
			}, delay);
			continuationHandles.add(handle);
		}

		function admitRefreshInstance(
			instance: Awaited<ReturnType<typeof app.prisma.serviceInstance.findMany>>[number],
			resumeFailed: boolean,
			dependencyRetry = 0,
			exceptionRetry = 0,
		): Promise<void> {
			const pageTask = refreshInstance(
				instance,
				resumeFailed,
				dependencyRetry,
				exceptionRetry,
			).then(() => undefined);
			admittedPageTasks.add(pageTask);
			void pageTask.finally(() => admittedPageTasks.delete(pageTask)).catch(() => undefined);
			return pageTask;
		}

		async function refreshAllEpisodeCaches(resumeFailed: boolean) {
			if (closed) return;
			if (isRunning) {
				app.log.warn("Plex episode cache refresh already running, skipping");
				return;
			}
			isRunning = true;
			try {
				await app.schedulerRegistry.track(JOB_ID.plexEpisodeCache, async () => {
					const instances = await app.prisma.serviceInstance.findMany({
						where: { service: "PLEX", enabled: true },
					});

					if (instances.length === 0) {
						app.log.debug("Plex episode cache refresh: no enabled Plex instances, skipping");
						return;
					}

					app.log.info(
						{ count: instances.length },
						"Starting Plex episode cache refresh for all instances",
					);

					await Promise.all(
						instances.map(async (instance) => await admitRefreshInstance(instance, resumeFailed)),
					);
					if (closed) return;

					// Check for stale caches (>12h since last successful refresh)
					const staleThreshold = new Date(Date.now() - 12 * 60 * 60 * 1000);
					const publishedEntries = await app.prisma.cacheRefreshStatus.findMany({
						where: {
							cacheType: "plex_episode",
							instance: { enabled: true },
						},
						include: { instance: true },
					});
					const staleEntries = [];
					for (const entry of publishedEntries) {
						const evidence = await getPublishedEpisodeGenerationObservation(app.prisma, {
							userId: entry.instance.userId,
							instanceId: entry.instanceId,
							instance: entry.instance,
							maxAgeMs: 12 * 60 * 60 * 1000,
						});
						if (entry.lastRefreshedAt < staleThreshold || !evidence.available) {
							staleEntries.push(entry);
						}
					}
					if (staleEntries.length > 0) {
						const names = staleEntries
							.map((e) => e.instance.label.replace(/[<>&"']/g, "").slice(0, 50))
							.join(", ");
						app.log.warn(
							{ staleInstances: names },
							"Plex episode cache data is stale (>12h since last refresh)",
						);
						await app.notificationService
							.notify({
								eventType: "CACHE_REFRESH_STALE",
								title: "Plex episode cache data is stale",
								body: `Episode cache has not refreshed in over 12 hours for: ${names}`,
								url: "/settings",
							})
							.catch((notifyErr) => {
								app.log.warn({ err: notifyErr }, "Failed to send stale-cache notification");
							});
					}
				});
			} catch (err) {
				app.log.error({ err }, "Plex episode cache scheduler: failed to query instances");
			} finally {
				isRunning = false;
			}
		}

		const schedulerBridge = ensureEpisodeRefreshScheduler(app);
		const unregisterRetry = schedulerBridge.episodeRefreshScheduler.register(
			"plex_episode",
			async ({ userId, instanceId }) => {
				if (closed) return { status: "unavailable" };
				try {
					const instance = await app.prisma.serviceInstance.findFirst({
						where: { id: instanceId, userId, service: "PLEX", enabled: true },
					});
					if (!instance) return { status: "ineligible" };
					if (closed) return { status: "unavailable" };
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
			app.log.info("Plex episode cache scheduler initialized (6h interval, 5min startup delay)");

			// Initial refresh after startup delay
			timeoutHandle = setTimeout(() => {
				refreshAllEpisodeCaches(true).catch((err) => {
					app.log.error({ err }, "Failed during initial Plex episode cache refresh");
				});
				// Recurring refresh
				intervalHandle = setInterval(() => {
					refreshAllEpisodeCaches(false).catch((err) => {
						app.log.error({ err }, "Failed during scheduled Plex episode cache refresh");
					});
				}, INTERVAL_MS);
			}, STARTUP_DELAY_MS);
		});

		app.addHook("onClose", async () => {
			closed = true;
			unregisterRetry();
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (intervalHandle) clearInterval(intervalHandle);
			for (const handle of continuationHandles) clearTimeout(handle);
			continuationHandles.clear();
			retainedAttempts.clear();
			pendingInstanceIds.clear();
			await Promise.allSettled([...admittedPageTasks]);
			app.log.info("Plex episode cache scheduler stopped");
		});
	},
	{
		name: "plex-episode-cache-scheduler",
		dependencies: ["prisma", "security", "notification-service", "scheduler-registry"],
	},
);

export default plexEpisodeCacheSchedulerPlugin;
