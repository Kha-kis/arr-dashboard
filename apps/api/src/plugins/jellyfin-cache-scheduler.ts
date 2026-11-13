/**
 * Jellyfin Cache Scheduler Plugin
 *
 * Periodically refreshes JellyfinCache data from all enabled Jellyfin instances.
 * Runs every 6 hours with an initial 45-second startup delay (staggered with Plex at 30s).
 */

import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { refreshOwnedJellyfinCacheWithAttempt } from "../lib/jellyfin/jellyfin-cache-refresher.js";
import { runJellyfinCacheRefreshSingleFlight } from "../lib/jellyfin/jellyfin-cache-singleflight.js";
import {
	CleanupMaintenanceConflictError,
	withIndependentCleanupOperationGuard,
} from "../lib/library-cleanup/cleanup-maintenance-gate.js";
import type { ServiceInstance } from "../lib/prisma.js";
import { JOB_ID } from "../lib/scheduler-registry/job-definitions.js";
import {
	ensureLibraryRefreshRecovery,
	isRetryableLibraryRefreshResult,
	libraryRefreshPublishedAt,
	type LibraryRefreshRecoveryRequest,
} from "../lib/services/library-refresh-recovery.js";
import {
	claimProviderCacheRefreshAttempt,
	reconcileSettledProviderCacheRefreshAttempt,
} from "../lib/services/provider-cache-status.js";
import {
	createProviderPublicationAuthority,
	sameProviderPublicationAuthority,
} from "../lib/services/provider-identity-guard.js";

const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const STARTUP_DELAY_MS = 45_000; // 45 seconds
const RECOVERY_RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000] as const;

type ScheduledJellyfinRefreshOutcome = "complete" | "settled" | "retryable" | "superseded";

export async function refreshScheduledJellyfinCacheInstance(
	app: Pick<FastifyInstance, "encryptor" | "prisma" | "log">,
	instance: ServiceInstance,
	onOwnedAttempt?: (request: LibraryRefreshRecoveryRequest) => void,
	onClaimed?: (request: LibraryRefreshRecoveryRequest) => void,
	signal?: AbortSignal,
): Promise<ScheduledJellyfinRefreshOutcome> {
	const authority = createProviderPublicationAuthority(instance);
	let owned: LibraryRefreshRecoveryRequest | undefined;
	try {
		const result = await runJellyfinCacheRefreshSingleFlight(authority, "jellyfin", async () => {
			const claim = await claimProviderCacheRefreshAttempt(app.prisma, "jellyfin", authority);
			if (claim.status !== "acquired")
				return { superseded: true, complete: false, upserted: 0, errors: 0 };
			owned = {
				provider: "jellyfin",
				userId: instance.userId,
				instanceId: instance.id,
				authority,
				attempt: claim.attempt,
			};
			onClaimed?.(owned);
			return await refreshOwnedJellyfinCacheWithAttempt(
				{
					prisma: app.prisma,
					encryptor: app.encryptor,
					instance,
					log: app.log,
					...(signal ? { signal } : {}),
				},
				claim.attempt,
			);
		});
		if (owned) onOwnedAttempt?.({ ...owned, publishedAt: libraryRefreshPublishedAt(result) });
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
		if (isRetryableLibraryRefreshResult("jellyfin", result)) {
			return "retryable";
		}
		if (result.complete) return "complete";
		return result.errors > 0 ? "retryable" : "settled";
	} catch {
		if (owned) onOwnedAttempt?.(owned);
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
		const shutdown = new AbortController();
		const recoveryHandles = new Map<string, ReturnType<typeof setTimeout>>();
		const recoveryAttempts = new Map<string, LibraryRefreshRecoveryRequest>();
		const recoveryVersions = new Map<string, symbol>();
		const runningRecoveryInstances = new Set<string>();
		const pendingOperations = new Set<Promise<void>>();
		function rememberAttempt(request: LibraryRefreshRecoveryRequest, version: symbol) {
			if (closing || !recovery.libraryRefreshRecovery.admit(request)) return version;
			// A claim acquired after an external handoff can be newer than this
			// operation's old version. Adopt only its now-settled, ordered owner.
			if (recoveryVersions.get(request.instanceId) !== version) {
				const handle = recoveryHandles.get(request.instanceId);
				if (handle) clearTimeout(handle);
				recoveryHandles.delete(request.instanceId);
				version = Symbol();
				recoveryVersions.set(request.instanceId, version);
			}
			recoveryAttempts.set(request.instanceId, request);
			return version;
		}
		function operationVersion(instanceId: string) {
			const version = recoveryVersions.get(instanceId) ?? Symbol();
			recoveryVersions.set(instanceId, version);
			return version;
		}
		function releaseInstance(instanceId: string, version: symbol) {
			runningRecoveryInstances.delete(instanceId);
			const currentVersion = recoveryVersions.get(instanceId);
			if (currentVersion && currentVersion !== version && recoveryAttempts.has(instanceId))
				scheduleRecovery(instanceId, 0, currentVersion);
		}
		function admitClaim(request: LibraryRefreshRecoveryRequest) {
			if (!closing) recovery.libraryRefreshRecovery.admit(request);
		}

		async function runAccepted<T>(operation: () => Promise<T>): Promise<T> {
			let finish!: () => void;
			const completion = new Promise<void>((resolve) => {
				finish = resolve;
			});
			// Register before entering the guard or starting the first database read.
			pendingOperations.add(completion);
			try {
				return await withIndependentCleanupOperationGuard(operation);
			} finally {
				pendingOperations.delete(completion);
				finish();
			}
		}

		function clearRecovery(instanceId: string, version: symbol) {
			if (recoveryVersions.get(instanceId) !== version) return;
			const handle = recoveryHandles.get(instanceId);
			if (handle) clearTimeout(handle);
			recoveryHandles.delete(instanceId);
			recoveryAttempts.delete(instanceId);
			recoveryVersions.delete(instanceId);
		}

		function scheduleRecovery(instanceId: string, retryIndex: number, version: symbol) {
			const delay = RECOVERY_RETRY_DELAYS_MS[retryIndex];
			if (
				closing ||
				recoveryVersions.get(instanceId) !== version ||
				recoveryHandles.has(instanceId)
			)
				return;
			// Exhaust timers, not knowledge of the settled owner. The ordinary
			// six-hour cadence may reconcile this same attempt after a long outage.
			if (delay === undefined) return;
			const handle = setTimeout(() => {
				if (recoveryVersions.get(instanceId) !== version) return;
				recoveryHandles.delete(instanceId);
				void retryCurrentInstance(instanceId, retryIndex + 1, version);
			}, delay);
			recoveryHandles.set(instanceId, handle);
		}

		async function retryCurrentInstance(
			instanceId: string,
			nextRetryIndex: number,
			version: symbol,
		) {
			if (closing || recoveryVersions.get(instanceId) !== version) return;
			if (runningRecoveryInstances.has(instanceId)) {
				scheduleRecovery(instanceId, nextRetryIndex - 1, version);
				return;
			}
			runningRecoveryInstances.add(instanceId);
			try {
				await runAccepted(async () => {
					const origin = recoveryAttempts.get(instanceId);
					const current = await app.prisma.serviceInstance.findFirst({
						where: {
							id: instanceId,
							...(origin ? { userId: origin.userId } : {}),
							service: { in: ["JELLYFIN", "EMBY"] },
							enabled: true,
							identityStatus: "VERIFIED",
							expectedIdentity: { not: null },
						},
					});
					if (closing || recoveryVersions.get(instanceId) !== version) return;
					if (
						!current?.expectedIdentity?.trim() ||
						(origin &&
							!sameProviderPublicationAuthority(
								origin.authority,
								createProviderPublicationAuthority(current),
							))
					) {
						clearRecovery(instanceId, version);
						return;
					}
					if (origin) {
						const reconciled = await reconcileSettledProviderCacheRefreshAttempt(
							app.prisma,
							"jellyfin",
							origin.authority,
							origin.attempt,
							origin.publishedAt,
						);
						if (closing || recoveryVersions.get(instanceId) !== version) return;
						if (reconciled === "superseded") {
							clearRecovery(instanceId, version);
							return;
						}
						if (reconciled === "unavailable") {
							scheduleRecovery(instanceId, nextRetryIndex, version);
							return;
						}
					}
					const outcome = await refreshScheduledJellyfinCacheInstance(
						app,
						current,
						(request) => {
							version = rememberAttempt(request, version);
						},
						admitClaim,
						shutdown.signal,
					);
					if (outcome === "retryable") scheduleRecovery(instanceId, nextRetryIndex, version);
					else clearRecovery(instanceId, version);
				});
			} catch (error) {
				if (error instanceof CleanupMaintenanceConflictError) {
					app.log.debug("Jellyfin cache recovery paused for database maintenance");
					// Admission was denied; no provider attempt consumed this rung.
					scheduleRecovery(instanceId, nextRetryIndex - 1, version);
				} else {
					app.log.error(
						{ category: "recovery-refresh-failed" },
						"Jellyfin cache recovery refresh failed",
					);
					scheduleRecovery(instanceId, nextRetryIndex, version);
				}
			} finally {
				releaseInstance(instanceId, version);
			}
		}

		async function refreshAllJellyfinCaches() {
			if (closing) return;
			if (isRunning) {
				app.log.warn("Jellyfin cache refresh already running, skipping");
				return;
			}
			isRunning = true;
			try {
				await runAccepted(() =>
					app.schedulerRegistry.track(JOB_ID.jellyfinCache, async () => {
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
							if (closing) break;
							if (runningRecoveryInstances.has(instance.id)) continue;
							let version = operationVersion(instance.id);
							runningRecoveryInstances.add(instance.id);
							try {
								const origin = recoveryAttempts.get(instance.id);
								if (origin) {
									if (recoveryHandles.has(instance.id)) continue;
									if (
										!sameProviderPublicationAuthority(
											origin.authority,
											createProviderPublicationAuthority(instance),
										)
									) {
										clearRecovery(instance.id, version);
										continue;
									}
									const reconciled = await reconcileSettledProviderCacheRefreshAttempt(
										app.prisma,
										"jellyfin",
										origin.authority,
										origin.attempt,
										origin.publishedAt,
									);
									if (closing || recoveryVersions.get(instance.id) !== version) continue;
									if (reconciled === "superseded") {
										clearRecovery(instance.id, version);
										continue;
									}
									if (reconciled === "unavailable") continue;
									if (closing) break;
								}
								const outcome = await refreshScheduledJellyfinCacheInstance(
									app,
									instance,
									(request) => {
										version = rememberAttempt(request, version);
									},
									admitClaim,
									shutdown.signal,
								);
								if (outcome === "retryable") scheduleRecovery(instance.id, 0, version);
								else clearRecovery(instance.id, version);
							} finally {
								releaseInstance(instance.id, version);
							}
						}
					}),
				);
			} catch (error) {
				if (!(error instanceof CleanupMaintenanceConflictError)) throw error;
				app.log.debug("Jellyfin cache refresh paused for database maintenance");
			} finally {
				isRunning = false;
			}
		}

		const recovery = ensureLibraryRefreshRecovery(app);
		const unregisterRecovery = recovery.libraryRefreshRecovery.register(
			"jellyfin",
			async (request) => {
				if (closing) return { status: "unavailable" };
				// Admission performs no database work: preserve ownership even through an outage.
				const existing = recoveryAttempts.get(request.instanceId);
				if (
					existing?.attempt.resultMarker === request.attempt.resultMarker &&
					existing.attempt.attemptedAt.getTime() === request.attempt.attemptedAt.getTime()
				)
					return { status: "accepted" };
				const handle = recoveryHandles.get(request.instanceId);
				if (handle) clearTimeout(handle);
				recoveryHandles.delete(request.instanceId);
				const version = Symbol();
				recoveryVersions.set(request.instanceId, version);
				recoveryAttempts.set(request.instanceId, request);
				if (!runningRecoveryInstances.has(request.instanceId))
					scheduleRecovery(request.instanceId, 0, version);
				return { status: "accepted" };
			},
		);

		app.addHook("onReady", async () => {
			if (closing) return;
			// Stagger startup, then run on interval after earlier recovery hooks settle.
			timeoutHandle = setTimeout(() => {
				if (closing) return;
				refreshAllJellyfinCaches().catch(() =>
					app.log.error(
						{ category: "initial-refresh-failed" },
						"Jellyfin cache initial refresh failed",
					),
				);
				if (closing) return;
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

		function closeAdmission() {
			if (closing) return;
			closing = true;
			shutdown.abort();
			unregisterRecovery();
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (intervalHandle) clearInterval(intervalHandle);
			timeoutHandle = null;
			intervalHandle = null;
			for (const handle of recoveryHandles.values()) clearTimeout(handle);
			recoveryHandles.clear();
			recoveryAttempts.clear();
			recoveryVersions.clear();
		}

		app.addHook("preClose", async () => closeAdmission());
		app.addHook("onClose", async () => {
			closeAdmission();
			while (pendingOperations.size > 0) {
				await Promise.all([...pendingOperations]);
			}
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
