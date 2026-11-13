/**
 * Plex Cache Scheduler Plugin
 *
 * Periodically refreshes PlexCache data from all enabled Plex instances.
 * Runs every 6 hours with an initial 30-second startup delay.
 */

import type { ProviderObservationReasonCode, ProviderObservationStatus } from "@arr/shared";
import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import {
	CleanupMaintenanceConflictError,
	withIndependentCleanupOperationGuard,
} from "../lib/library-cleanup/cleanup-maintenance-gate.js";
import { loadGenerationObservationsForOwnedInstances } from "../lib/plex/plex-persisted-observation-repository.js";
import { refreshOwnedPlexCacheWithAttempt } from "../lib/plex/plex-refresh-orchestration.js";
import { evaluateProviderCoverageReceipt } from "../lib/provider-observation/coverage-receipt.js";
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
		const shutdown = new AbortController();
		let isRunning = false;
		const retries = new Map<
			string,
			{ attempts: number; dueAt: number; origin?: LibraryRefreshRecoveryRequest; version: symbol }
		>();
		const pendingOperations = new Set<Promise<void>>();

		async function runAccepted<T>(operation: () => Promise<T>): Promise<T> {
			let finish!: () => void;
			const completion = new Promise<void>((resolve) => {
				finish = resolve;
			});
			// Register before the first read, including recovery admission lookups.
			pendingOperations.add(completion);
			try {
				return await withIndependentCleanupOperationGuard(operation);
			} finally {
				pendingOperations.delete(completion);
				finish();
			}
		}

		function recordFailure(
			instanceId: string,
			retryOnly: boolean,
			version: symbol | undefined,
			origin?: LibraryRefreshRecoveryRequest,
		) {
			const existing = retries.get(instanceId);
			if (existing?.version !== version) return;
			const attempts = retryOnly ? (existing?.attempts ?? 0) : 0;
			const delay = FAILURE_RETRY_DELAYS_MS[attempts];
			if (closed) {
				retries.delete(instanceId);
				return;
			}
			if (delay === undefined) {
				// Keep a settled owner for the ordinary cadence, without a fourth timer.
				const retained = origin ?? existing?.origin;
				if (retained)
					retries.set(instanceId, {
						attempts,
						dueAt: Number.POSITIVE_INFINITY,
						origin: retained,
						version: version ?? Symbol(),
					});
				else retries.delete(instanceId);
				return;
			}
			retries.set(instanceId, {
				attempts: attempts + 1,
				dueAt: Date.now() + delay,
				origin: origin ?? existing?.origin,
				version: version ?? Symbol(),
			});
		}
		function clearRetry(instanceId: string, version: symbol | undefined) {
			if (retries.get(instanceId)?.version === version) retries.delete(instanceId);
		}

		function scheduleRetry() {
			if (retryHandle) clearTimeout(retryHandle);
			retryHandle = null;
			if (closed || retries.size === 0) return;
			const pending = [...retries.values()].filter((retry) => Number.isFinite(retry.dueAt));
			if (pending.length === 0) return;
			const dueAt = Math.min(...pending.map((retry) => retry.dueAt));
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
			const capturedRetries = new Map(retries);
			const retryIds = [...capturedRetries]
				.filter(([, retry]) => retry.dueAt <= Date.now())
				.map(([id]) => id);
			try {
				// Route the tick through the scheduler registry so last run / duration /
				// failure counts surface on /api/system/jobs. The registry re-throws,
				// so fatal errors reach the outer .catch() handlers below just as before.
				await runAccepted(() =>
					app.notificationService.runProducer(() =>
						app.schedulerRegistry.track(JOB_ID.plexCache, async () => {
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
													const retry = capturedRetries.get(instance.id);
													if (!retry?.origin) return instance;
													return await app.prisma.serviceInstance.findFirst({
														where: {
															id: instance.id,
															userId: retry.origin.userId,
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
								if (!instances.some((instance) => instance.id === id))
									clearRetry(id, capturedRetries.get(id)?.version);
							}

							if (instances.length === 0) {
								app.log.debug(
									{ provider: "plex", outcome: "skipped", reason: "provider-unavailable" },
									"Plex provider observation skipped: no enabled instances",
								);
								return;
							}

							app.log.info(
								{ provider: "plex", outcome: "started" },
								"Provider observation started",
							);

							for (const instance of instances) {
								if (closed) break;
								const pendingRetry = retryOnly
									? capturedRetries.get(instance.id)
									: retries.get(instance.id);
								let version = pendingRetry?.version;
								const capturedAttempts = pendingRetry?.attempts ?? 0;
								if (retries.get(instance.id)?.version !== version) continue;
								if (!retryOnly && pendingRetry?.origin && Number.isFinite(pendingRetry.dueAt))
									continue;
								const startedAt = Date.now();
								let result: unknown;
								let thrown = false;
								let owned: LibraryRefreshRecoveryRequest | undefined;
								try {
									const authority = createProviderPublicationAuthority(instance);
									const origin = pendingRetry?.origin;
									if (origin) {
										if (!sameProviderPublicationAuthority(origin.authority, authority)) {
											clearRetry(instance.id, version);
											continue;
										}
										const reconciled = await reconcileSettledProviderCacheRefreshAttempt(
											app.prisma,
											"plex",
											origin.authority,
											origin.attempt,
											origin.publishedAt,
										);
										if (closed || retries.get(instance.id)?.version !== version) continue;
										if (reconciled === "superseded") {
											clearRetry(instance.id, version);
											continue;
										}
										if (reconciled === "unavailable") {
											if (pendingRetry && Number.isFinite(pendingRetry.dueAt))
												recordFailure(instance.id, retryOnly, version);
											continue;
										}
									}
									const claim = await claimProviderCacheRefreshAttempt(
										app.prisma,
										"plex",
										authority,
									);
									if (claim.status !== "acquired") {
										clearRetry(instance.id, version);
										continue;
									}
									owned = {
										provider: "plex",
										userId: instance.userId,
										instanceId: instance.id,
										authority,
										attempt: claim.attempt,
									};
									if (!closed) recovery.libraryRefreshRecovery.admit(owned);
									result = await refreshOwnedPlexCacheWithAttempt(
										{
											prisma: app.prisma,
											encryptor: app.encryptor,
											instance,
											log: app.log,
											signal: shutdown.signal,
										},
										claim.attempt,
									);
								} catch {
									thrown = true;
								}
								if (owned && !closed) {
									if (!recovery.libraryRefreshRecovery.admit(owned)) continue;
									if (retries.get(instance.id)?.version !== version) {
										version = Symbol();
										// Carry this operation's captured rung, not the external
										// handoff's budget. No live claim enters repair context.
										retries.set(instance.id, {
											attempts: capturedAttempts,
											dueAt: pendingRetry?.dueAt ?? Number.POSITIVE_INFINITY,
											version,
										});
									}
								}
								const failed = isRetryableLibraryRefreshResult("plex", result, thrown);
								if (failed)
									recordFailure(
										instance.id,
										retryOnly,
										version,
										owned
											? { ...owned, publishedAt: libraryRefreshPublishedAt(result) }
											: undefined,
									);
								else clearRetry(instance.id, version);

								let providerStatus: ProviderObservationStatus | undefined;
								try {
									const [observation] = await loadGenerationObservationsForOwnedInstances(
										app.prisma,
										{
											instances: [instance],
											maxAgeMs: 12 * 60 * 60 * 1000,
										},
									);
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
								const [observation] = await loadGenerationObservationsForOwnedInstances(
									app.prisma,
									{
										instances: [entry.instance],
										maxAgeMs: 12 * 60 * 60 * 1000,
									},
								);
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
											{
												provider: "plex",
												outcome: "notification-failed",
												reason: "unknown-failure",
											},
											"Plex provider stale notification failed",
										);
									});
							}
						}),
					),
				);
			} catch (error) {
				if (error instanceof CleanupMaintenanceConflictError) {
					// Admission did not run: defer the same rung without spending a provider attempt.
					if (retryOnly && !closed) {
						for (const id of retryIds) {
							const retry = retries.get(id);
							if (retry?.version !== capturedRetries.get(id)?.version) continue;
							const delay = retry && FAILURE_RETRY_DELAYS_MS[retry.attempts - 1];
							if (retry && delay !== undefined) retry.dueAt = Date.now() + delay;
						}
					}
					app.log.debug("Plex cache refresh paused for database maintenance");
					return;
				}
				if (retryOnly) {
					for (const id of retryIds) recordFailure(id, true, capturedRetries.get(id)?.version);
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
			// The settled owner survives database unavailability until a finite rung runs.
			const existing = retries.get(request.instanceId);
			if (
				existing?.origin?.attempt.resultMarker === request.attempt.resultMarker &&
				existing.origin.attempt.attemptedAt.getTime() === request.attempt.attemptedAt.getTime()
			)
				return { status: "accepted" };
			retries.set(request.instanceId, {
				attempts: 1,
				dueAt: Date.now() + FAILURE_RETRY_DELAYS_MS[0],
				origin: request,
				version: Symbol(),
			});
			scheduleRetry();
			return { status: "accepted" };
		});

		app.addHook("onReady", async () => {
			if (closed) return;
			app.log.info(
				{ provider: "plex", outcome: "initialized" },
				"Plex provider scheduler initialized",
			);

			// Initial refresh after startup delay
			timeoutHandle = setTimeout(() => {
				if (closed) return;
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
				if (closed) return;
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

		function closeAdmission() {
			if (closed) return;
			closed = true;
			shutdown.abort();
			unregisterRecovery();
			retries.clear();
			if (retryHandle) clearTimeout(retryHandle);
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (intervalHandle) clearInterval(intervalHandle);
			retryHandle = null;
			timeoutHandle = null;
			intervalHandle = null;
		}

		app.addHook("preClose", async () => closeAdmission());
		app.addHook("onClose", async () => {
			closeAdmission();
			while (pendingOperations.size > 0) {
				await Promise.all([...pendingOperations]);
			}
			app.log.info({ provider: "plex", outcome: "stopped" }, "Plex provider scheduler stopped");
		});
	},
	{
		name: "plex-cache-scheduler",
		dependencies: ["prisma", "security", "notification-service", "scheduler-registry"],
	},
);

export default plexCacheSchedulerPlugin;
