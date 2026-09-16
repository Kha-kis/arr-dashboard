/**
 * Plex Cache Scheduler Plugin
 *
 * Periodically refreshes PlexCache data from all enabled Plex instances.
 * Runs every 6 hours with an initial 30-second startup delay.
 */

import type { ProviderObservationReasonCode, ProviderObservationStatus } from "@arr/shared";
import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { loadGenerationObservationsForOwnedInstances } from "../lib/plex/plex-persisted-observation-repository.js";
import { refreshOwnedPlexCache } from "../lib/plex/plex-refresh-orchestration.js";
import { evaluateProviderCoverageReceipt } from "../lib/provider-observation/coverage-receipt.js";
import { JOB_ID } from "../lib/scheduler-registry/job-definitions.js";
import {
	ensureLibraryRefreshRecovery,
	isRetryableLibraryRefreshResult,
} from "../lib/services/library-refresh-recovery.js";

const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const STARTUP_DELAY_MS = 30_000; // 30 seconds — staggers with tautulli (2min), episode (5min), snapshot (60s)
const FAILURE_RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;

const PROVIDER_REASON_CODES = new Set<ProviderObservationReasonCode>([
	"no-publication",
	"identity-unverified",
	"identity-changed",
	"refresh-running",
	"refresh-failed",
	"publication-superseded",
	"receipt-invalid",
	"coverage-incomplete",
	"accepted-skips",
	"provider-limit",
	"provider-unavailable",
	"publication-stale",
	"rows-inconsistent",
	"positive-only",
	"unknown-failure",
]);

type PlexTelemetry = {
	provider: "plex";
	outcome: "complete" | "partial" | "failed" | "superseded";
	availability: ProviderObservationStatus["availability"];
	reason: ProviderObservationReasonCode | "none";
	durationMs: number;
	staleCount?: number;
	rawObserved?: number;
	sourceBindings?: number;
	canonicalEntities?: number;
	acceptedSkips?: number;
	fatalCount?: number;
	pagesAttempted?: number;
	pagesCompleted?: number;
};

function boundedReason(value: unknown): ProviderObservationReasonCode | "none" {
	if (value === undefined) return "none";
	return typeof value === "string" &&
		PROVIDER_REASON_CODES.has(value as ProviderObservationReasonCode)
		? (value as ProviderObservationReasonCode)
		: "unknown-failure";
}

function persistedAvailability(value: unknown): ProviderObservationStatus["availability"] {
	if (
		value === "current" ||
		value === "partial" ||
		value === "last-known" ||
		value === "unavailable"
	) {
		return value;
	}
	return "unavailable";
}

function telemetryForResult(
	result: unknown,
	providerStatus: ProviderObservationStatus | undefined,
	startedAt: number,
	thrown: boolean,
): PlexTelemetry {
	const evaluation = evaluateProviderCoverageReceipt(
		typeof result === "object" && result !== null
			? (result as { receipt?: unknown }).receipt
			: undefined,
	);
	const outcome: PlexTelemetry["outcome"] = thrown
		? "failed"
		: typeof result === "object" &&
				result !== null &&
				(result as { superseded?: unknown }).superseded === true
			? "superseded"
			: !evaluation.valid
				? "failed"
				: evaluation.complete
					? "complete"
					: "partial";
	const reason = thrown
		? "unknown-failure"
		: boundedReason(
				evaluation.reasonCodes[0] ??
					providerStatus?.reasonCodes?.[0] ??
					(!providerStatus ? "unknown-failure" : undefined),
			);
	const telemetry: PlexTelemetry = {
		provider: "plex",
		outcome,
		availability: persistedAvailability(providerStatus?.availability),
		reason,
		durationMs: Math.max(0, Date.now() - startedAt),
	};
	if (evaluation.valid) {
		telemetry.rawObserved = evaluation.rawObserved;
		telemetry.sourceBindings = evaluation.sourceBindings;
		telemetry.canonicalEntities = evaluation.canonicalEntities;
		telemetry.acceptedSkips = evaluation.acceptedSkipCount;
		telemetry.fatalCount = evaluation.fatalCount;
		telemetry.pagesAttempted = evaluation.pagesAttempted;
		telemetry.pagesCompleted = evaluation.pagesCompleted;
	}
	return telemetry;
}

const plexCacheSchedulerPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		let intervalHandle: ReturnType<typeof setInterval> | null = null;
		let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
		let retryHandle: ReturnType<typeof setTimeout> | null = null;
		let closed = false;
		let isRunning = false;
		const retries = new Map<string, { attempts: number; dueAt: number; userId?: string }>();

		function recordFailure(instanceId: string, retryOnly: boolean, userId?: string) {
			const existing = retries.get(instanceId);
			const attempts = retryOnly ? (existing?.attempts ?? 0) : 0;
			const delay = FAILURE_RETRY_DELAYS_MS[attempts];
			if (closed || delay === undefined) {
				retries.delete(instanceId);
				return;
			}
			retries.set(instanceId, {
				attempts: attempts + 1,
				dueAt: Date.now() + delay,
				...(userId === undefined && existing?.userId === undefined
					? {}
					: { userId: userId ?? existing?.userId }),
			});
		}

		function scheduleRetry() {
			if (retryHandle) clearTimeout(retryHandle);
			retryHandle = null;
			if (closed || retries.size === 0) return;
			const dueAt = Math.min(...[...retries.values()].map((retry) => retry.dueAt));
			retryHandle = setTimeout(
				() => {
					retryHandle = null;
					void refreshAllPlexCaches(true);
				},
				Math.max(isRunning ? 1_000 : 0, dueAt - Date.now()),
			);
		}

		async function refreshAllPlexCaches(retryOnly = false) {
			if (closed) return;
			if (isRunning) {
				if (retryOnly) scheduleRetry();
				app.log.warn(
					{ provider: "plex", outcome: "skipped", reason: "refresh-running" },
					"Plex provider observation already running, skipping",
				);
				return;
			}
			isRunning = true;
			const retryIds = [...retries]
				.filter(([, retry]) => retry.dueAt <= Date.now())
				.map(([id]) => id);
			try {
				// Route the tick through the scheduler registry so last run / duration /
				// failure counts surface on /api/system/jobs. The registry re-throws,
				// so fatal errors reach the outer .catch() handlers below just as before.
				await app.schedulerRegistry.track(JOB_ID.plexCache, async () => {
					const enabledInstances = await app.prisma.serviceInstance.findMany({
						where: {
							service: "PLEX",
							enabled: true,
							...(retryOnly ? { id: { in: retryIds } } : {}),
						},
					});
					const instances = retryOnly
						? (
								await Promise.all(
									enabledInstances
										.filter((instance) => retryIds.includes(instance.id))
										.map(async (instance) => {
											const retry = retries.get(instance.id);
											if (!retry?.userId) return instance;
											return await app.prisma.serviceInstance.findFirst({
												where: {
													id: instance.id,
													userId: retry.userId,
													service: "PLEX",
													enabled: true,
													identityStatus: "VERIFIED",
													expectedIdentity: { not: null },
												},
											});
										}),
								)
							).filter(
								(instance): instance is (typeof enabledInstances)[number] => instance !== null,
							)
						: enabledInstances;
					for (const id of retryIds) {
						if (!instances.some((instance) => instance.id === id)) retries.delete(id);
					}

					if (instances.length === 0) {
						app.log.debug(
							{ provider: "plex", outcome: "skipped", reason: "provider-unavailable" },
							"Plex provider observation skipped: no enabled instances",
						);
						return;
					}

					app.log.info({ provider: "plex", outcome: "started" }, "Provider observation started");

					for (const instance of instances) {
						if (closed) break;
						const startedAt = Date.now();
						let result: unknown;
						let thrown = false;
						try {
							result = await refreshOwnedPlexCache({
								prisma: app.prisma,
								encryptor: app.encryptor,
								instance,
								log: app.log,
							});
						} catch {
							thrown = true;
						}
						const failed = isRetryableLibraryRefreshResult("plex", result, thrown);
						if (failed) recordFailure(instance.id, retryOnly);
						else retries.delete(instance.id);

						let providerStatus: ProviderObservationStatus | undefined;
						try {
							const [observation] = await loadGenerationObservationsForOwnedInstances(app.prisma, {
								instances: [instance],
								maxAgeMs: 12 * 60 * 60 * 1000,
							});
							providerStatus = observation?.providerStatus;
						} catch {
							// Missing persisted state is intentionally represented as unavailable.
						}
						const telemetry = telemetryForResult(result, providerStatus, startedAt, thrown);
						app.log[thrown ? "warn" : "info"](
							telemetry,
							thrown ? "Provider observation failed" : "Provider observation completed",
						);
					}
					// Routine stale notifications remain on the six-hour cadence.
					if (retryOnly || closed) return;

					// Check for stale caches (>12h since last successful refresh)
					const staleThreshold = new Date(Date.now() - 12 * 60 * 60 * 1000);
					const publishedEntries = await app.prisma.cacheRefreshStatus.findMany({
						where: {
							cacheType: "plex",
							instance: { enabled: true },
						},
						include: { instance: true },
					});
					const staleEntries = [];
					for (const entry of publishedEntries) {
						const [observation] = await loadGenerationObservationsForOwnedInstances(app.prisma, {
							instances: [entry.instance],
							maxAgeMs: 12 * 60 * 60 * 1000,
						});
						if (
							entry.lastRefreshedAt < staleThreshold ||
							!observation?.available ||
							observation.providerStatus?.availability !== "current"
						) {
							staleEntries.push(entry);
						}
					}
					if (staleEntries.length > 0) {
						app.log.warn(
							{
								provider: "plex",
								outcome: "stale",
								availability: "unavailable",
								reason: "publication-stale",
								staleCount: staleEntries.length,
							},
							"Plex provider observation is stale",
						);
						await app.notificationService
							.notify({
								eventType: "CACHE_REFRESH_STALE",
								title: "Plex provider observation is stale",
								body: `Plex provider observation is stale for ${staleEntries.length} enabled instance(s).`,
							})
							.catch(() => {
								app.log.warn(
									{ provider: "plex", outcome: "notification-failed", reason: "unknown-failure" },
									"Plex provider stale notification failed",
								);
							});
					}
				});
			} catch {
				if (retryOnly) {
					for (const id of retryIds) recordFailure(id, true);
				}
				// Registry already recorded the failure; keep scheduler telemetry generic.
				app.log.error(
					{
						provider: "plex",
						outcome: "failed",
						availability: "unavailable",
						reason: "unknown-failure",
						durationMs: 0,
					},
					"Plex provider scheduler failed",
				);
			} finally {
				isRunning = false;
				scheduleRetry();
			}
		}

		const recovery = ensureLibraryRefreshRecovery(app);
		const unregisterRecovery = recovery.libraryRefreshRecovery.register("plex", async (request) => {
			if (closed) return { status: "unavailable" };
			try {
				const instance = await app.prisma.serviceInstance.findFirst({
					where: {
						id: request.instanceId,
						userId: request.userId,
						service: "PLEX",
						enabled: true,
						identityStatus: "VERIFIED",
						expectedIdentity: { not: null },
					},
				});
				if (!instance) return { status: "ineligible" };
				if (closed) return { status: "unavailable" };
				const existing = retries.get(instance.id);
				if (existing) {
					if (existing.userId === undefined) existing.userId = request.userId;
					return { status: "accepted" };
				}
				const delay = FAILURE_RETRY_DELAYS_MS[0];
				if (delay === undefined) return { status: "unavailable" };
				retries.set(instance.id, {
					attempts: 1,
					dueAt: Date.now() + delay,
					userId: request.userId,
				});
				scheduleRetry();
				return { status: "accepted" };
			} catch {
				return { status: "unavailable" };
			}
		});

		app.addHook("onReady", async () => {
			app.log.info(
				{ provider: "plex", outcome: "initialized" },
				"Plex provider scheduler initialized",
			);

			// Initial refresh after startup delay
			timeoutHandle = setTimeout(() => {
				refreshAllPlexCaches().catch(() => {
					app.log.error(
						{
							provider: "plex",
							outcome: "failed",
							availability: "unavailable",
							reason: "unknown-failure",
							durationMs: 0,
						},
						"Plex provider initial refresh failed",
					);
				});
				// Recurring refresh
				intervalHandle = setInterval(() => {
					refreshAllPlexCaches().catch(() => {
						app.log.error(
							{
								provider: "plex",
								outcome: "failed",
								availability: "unavailable",
								reason: "unknown-failure",
								durationMs: 0,
							},
							"Plex provider scheduled refresh failed",
						);
					});
				}, INTERVAL_MS);
			}, STARTUP_DELAY_MS);
		});

		app.addHook("onClose", async () => {
			closed = true;
			unregisterRecovery();
			retries.clear();
			if (retryHandle) clearTimeout(retryHandle);
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (intervalHandle) clearInterval(intervalHandle);
			app.log.info({ provider: "plex", outcome: "stopped" }, "Plex provider scheduler stopped");
		});
	},
	{
		name: "plex-cache-scheduler",
		dependencies: ["prisma", "security", "notification-service", "scheduler-registry"],
	},
);

export default plexCacheSchedulerPlugin;
