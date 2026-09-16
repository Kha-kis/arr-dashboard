/**
 * Jellyfin Cache Scheduler Plugin
 *
 * Periodically refreshes JellyfinCache data from all enabled Jellyfin instances.
 * Runs every 6 hours with an initial 45-second startup delay (staggered with Plex at 30s).
 */

import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { refreshOwnedJellyfinCache } from "../lib/jellyfin/jellyfin-cache-refresher.js";
import { runJellyfinCacheRefreshSingleFlight } from "../lib/jellyfin/jellyfin-cache-singleflight.js";
import type { ServiceInstance } from "../lib/prisma.js";
import { JOB_ID } from "../lib/scheduler-registry/job-definitions.js";
import {
	ensureLibraryRefreshRecovery,
	isRetryableLibraryRefreshResult,
} from "../lib/services/library-refresh-recovery.js";
import { createProviderPublicationAuthority } from "../lib/services/provider-identity-guard.js";

const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const STARTUP_DELAY_MS = 45_000; // 45 seconds
const RECOVERY_RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000] as const;

type ScheduledJellyfinRefreshOutcome = "complete" | "settled" | "retryable" | "superseded";

export async function refreshScheduledJellyfinCacheInstance(
	app: Pick<FastifyInstance, "encryptor" | "prisma" | "log">,
	instance: ServiceInstance,
): Promise<ScheduledJellyfinRefreshOutcome> {
	const authority = createProviderPublicationAuthority(instance);
	try {
		const result = await runJellyfinCacheRefreshSingleFlight(
			authority,
			"jellyfin",
			async () =>
				await refreshOwnedJellyfinCache({
					prisma: app.prisma,
					encryptor: app.encryptor,
					instance,
					log: app.log,
				}),
		);
		app.log.info(
			{
				instanceId: instance.id,
				complete: result.complete,
				upserted: result.upserted,
				errors: result.errors,
			},
			"Jellyfin cache refresh completed for instance",
		);
		if (result.superseded) return "superseded";
		if (isRetryableLibraryRefreshResult("jellyfin", result)) return "retryable";
		if (result.complete) return "complete";
		return result.errors > 0 ? "retryable" : "settled";
	} catch {
		app.log.error(
			{ instanceId: instance.id, category: "refresh-failed" },
			"Jellyfin cache refresh failed for instance",
		);
		return "retryable";
	}
}

const jellyfinCacheSchedulerPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		let intervalHandle: ReturnType<typeof setInterval> | null = null;
		let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
		let isRunning = false;
		let closing = false;
		const recoveryHandles = new Map<string, ReturnType<typeof setTimeout>>();
		const recoveryOwners = new Map<string, string>();
		const runningRecoveryInstances = new Set<string>();

		function clearRecovery(instanceId: string) {
			const handle = recoveryHandles.get(instanceId);
			if (handle) clearTimeout(handle);
			recoveryHandles.delete(instanceId);
			recoveryOwners.delete(instanceId);
		}

		function scheduleRecovery(instanceId: string, retryIndex: number, userId?: string) {
			const delay = RECOVERY_RETRY_DELAYS_MS[retryIndex];
			if (closing || delay === undefined || recoveryHandles.has(instanceId)) return;
			if (userId !== undefined) recoveryOwners.set(instanceId, userId);
			const handle = setTimeout(() => {
				recoveryHandles.delete(instanceId);
				void retryCurrentInstance(instanceId, retryIndex + 1);
			}, delay);
			recoveryHandles.set(instanceId, handle);
		}

		async function retryCurrentInstance(instanceId: string, nextRetryIndex: number) {
			if (closing || runningRecoveryInstances.has(instanceId)) return;
			runningRecoveryInstances.add(instanceId);
			try {
				const current = await app.prisma.serviceInstance.findFirst({
					where: {
						id: instanceId,
						...(recoveryOwners.has(instanceId) ? { userId: recoveryOwners.get(instanceId) } : {}),
						service: { in: ["JELLYFIN", "EMBY"] },
						enabled: true,
						identityStatus: "VERIFIED",
						expectedIdentity: { not: null },
					},
				});
				if (closing || !current?.expectedIdentity?.trim()) return;
				const outcome = await refreshScheduledJellyfinCacheInstance(app, current);
				if (outcome === "retryable") scheduleRecovery(instanceId, nextRetryIndex);
				else clearRecovery(instanceId);
			} catch {
				app.log.error(
					{ category: "recovery-refresh-failed" },
					"Jellyfin cache recovery refresh failed",
				);
				scheduleRecovery(instanceId, nextRetryIndex);
			} finally {
				runningRecoveryInstances.delete(instanceId);
			}
		}

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
						const outcome = await refreshScheduledJellyfinCacheInstance(app, instance);
						if (outcome === "retryable") scheduleRecovery(instance.id, 0);
						else clearRecovery(instance.id);
					}
				});
			} finally {
				isRunning = false;
			}
		}

		const recovery = ensureLibraryRefreshRecovery(app);
		const unregisterRecovery = recovery.libraryRefreshRecovery.register(
			"jellyfin",
			async (request) => {
				if (closing) return { status: "unavailable" };
				try {
					const instance = await app.prisma.serviceInstance.findFirst({
						where: {
							id: request.instanceId,
							userId: request.userId,
							service: { in: ["JELLYFIN", "EMBY"] },
							enabled: true,
							identityStatus: "VERIFIED",
							expectedIdentity: { not: null },
						},
					});
					if (!instance) return { status: "ineligible" };
					if (closing) return { status: "unavailable" };
					recoveryOwners.set(instance.id, request.userId);
					if (recoveryHandles.has(instance.id) || runningRecoveryInstances.has(instance.id))
						return { status: "accepted" };
					scheduleRecovery(instance.id, 0, request.userId);
					return { status: "accepted" };
				} catch {
					return { status: "unavailable" };
				}
			},
		);

		app.addHook("onReady", async () => {
			// Stagger startup, then run on interval after earlier recovery hooks settle.
			timeoutHandle = setTimeout(() => {
				refreshAllJellyfinCaches().catch(() =>
					app.log.error(
						{ category: "initial-refresh-failed" },
						"Jellyfin cache initial refresh failed",
					),
				);
				intervalHandle = setInterval(() => {
					refreshAllJellyfinCaches().catch(() =>
						app.log.error(
							{ category: "scheduled-refresh-failed" },
							"Jellyfin cache scheduled refresh failed",
						),
					);
				}, INTERVAL_MS);
			}, STARTUP_DELAY_MS);
		});

		app.addHook("onClose", () => {
			closing = true;
			unregisterRecovery();
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (intervalHandle) clearInterval(intervalHandle);
			for (const handle of recoveryHandles.values()) clearTimeout(handle);
			recoveryHandles.clear();
			recoveryOwners.clear();
		});

		app.log.info(
			{
				intervalMs: INTERVAL_MS,
				startupDelayMs: STARTUP_DELAY_MS,
				recoveryAttempts: RECOVERY_RETRY_DELAYS_MS.length,
			},
			"Jellyfin cache scheduler initialized",
		);
	},
	{ name: "jellyfin-cache-scheduler", dependencies: ["scheduler-registry"] },
);

export default jellyfinCacheSchedulerPlugin;
