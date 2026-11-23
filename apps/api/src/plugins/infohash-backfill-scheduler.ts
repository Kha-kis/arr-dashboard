/**
 * infoHash Backfill Scheduler
 *
 * Walks LibraryCache rows missing `infoHash` (for users with qui configured),
 * queries the relevant *arr's `/api/v3/history` to find the original grab's
 * `downloadId` (which IS the qBit infoHash for torrent grabs), and persists
 * it. Required to make the qui Torrent State filter cover the *whole* library
 * — without backfill, only items grabbed since PR #416 (2026-05-04) ever get
 * correlated, leaving a long tail of legacy items as `null` forever.
 *
 * Two-phase design:
 *
 *   1. **Catch-up phase** — runs at startup whenever the backlog is non-zero.
 *      Fires batches back-to-back with a 60s gap between them, capped at
 *      MAX_CATCHUP_BATCHES total batches per startup. Drains an existing
 *      library quickly: a 1500-row backlog completes in ~5 minutes instead
 *      of ~3 days under the old per-6h cadence. Exits early once the
 *      backlog drops to zero, or if a tick fails to make forward progress.
 *
 *   2. **Steady-state phase** — starts after catch-up finishes (or
 *      immediately when the backlog is empty at startup). Runs every 6h to
 *      capture any new items that have landed in LibraryCache since the
 *      last sweep. Incremental, low-cost.
 *
 * Per-startup caps: 10k history and movie rows, plus 40k episode rows.
 * A five-minute probe retries due correlations in smaller batches and
 * known failed metadata targets independently of correlation counts;
 * the six-hour steady-state pass remains the broad metadata fallback.
 */

import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import {
	acquireIndependentCleanupOperationGuard,
	CleanupMaintenanceConflictError,
} from "../lib/library-cleanup/cleanup-maintenance-gate.js";
import {
	type EpisodeFileSyncResult,
	runEpisodeBackfillSweep,
	runEpisodeFileSync,
} from "../lib/library-sync/episode-file-backfill.js";
import {
	type BackfillSweepResult,
	countBackfillCandidates,
	countDueDeferredCorrelationCandidates,
	countOutstandingBackfillCandidates,
	runInfoHashBackfillSweep,
} from "../lib/library-sync/infohash-backfill.js";
import { runPathBackfillSweep } from "../lib/library-sync/infohash-backfill-by-path.js";
import { JOB_ID } from "../lib/scheduler-registry/job-definitions.js";

const INTERVAL_MS = 6 * 60 * 60_000; // 6h steady-state cadence
const RETRY_PROBE_INTERVAL_MS = 5 * 60_000; // lightweight due-only probe
const STARTUP_DELAY_MS = 30_000; // 30s before first action
const CATCHUP_GAP_MS = 60_000; // 60s breathing room between catch-up batches
const MAX_CATCHUP_BATCHES = 20; // hard cap: 10k rows / ~17 min worst-case
const BATCH_SIZE = 500;
const EPISODE_CATCHUP_BATCH_SIZE = 2_000;
const EPISODE_RETRY_BATCH_SIZE = 1_000;
const PER_ROW_SLEEP_MS = 100;
const METADATA_RETRY_QUEUE_CAP = 1_000;
const METADATA_RETRY_BATCH_SIZE = 100;
const METADATA_RETRY_BACKOFF_MS = [5 * 60_000, 10 * 60_000, 20 * 60_000];

const infoHashBackfillSchedulerPlugin = fp(
	async (app: FastifyInstance) => {
		let intervalHandle: ReturnType<typeof setInterval> | null = null;
		let retryIntervalHandle: ReturnType<typeof setInterval> | null = null;
		let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
		let cancelled = false;
		let isRunning = false;
		let startupStarted = false;
		let catchUpGapHandle: ReturnType<typeof setTimeout> | null = null;
		let wakeCatchUpGap: (() => void) | null = null;
		const pendingRounds = new Set<Promise<void>>();
		// Process-local hints, never authority or a durable repair guarantee.
		// A restart or an exhausted budget falls back to the ordinary 6h sync.
		const metadataRetries = new Map<string, { attempts: number; retryAt: number }>();

		function recordMetadataOutcome(result: EpisodeFileSyncResult) {
			const failed = new Set(result.failedSeriesIds ?? []);
			for (const id of result.attemptedSeriesIds ?? []) {
				if (!failed.has(id)) metadataRetries.delete(id);
			}
			let overflow = 0;
			for (const id of failed) {
				if (metadataRetries.has(id)) continue;
				if (metadataRetries.size >= METADATA_RETRY_QUEUE_CAP) {
					overflow++;
					continue;
				}
				metadataRetries.set(id, {
					attempts: 0,
					retryAt: Date.now() + METADATA_RETRY_BACKOFF_MS[0]!,
				});
			}
			if (result.errors > 0) {
				app.log.warn(
					{ errors: result.errors, pendingSeries: metadataRetries.size, overflow },
					"Sonarr metadata sync incomplete; known failures have bounded repair hints, ordinary scheduled sync remains fallback",
				);
			}
		}

		async function retryEpisodeMetadata(ids: string[]): Promise<void> {
			for (const id of ids) metadataRetries.get(id)!.attempts++;
			let failed = new Set(ids);
			try {
				const result = await runEpisodeFileSync({
					app,
					log: app.log,
					seriesCap: METADATA_RETRY_BATCH_SIZE,
					retrySeriesIds: ids,
				});
				const attempted = new Set(result.attemptedSeriesIds ?? []);
				failed =
					result.attemptedSeriesIds && result.failedSeriesIds
						? new Set(result.failedSeriesIds)
						: new Set(ids);
				if (result.errors > 0)
					app.log.warn(
						{ errors: result.errors, selectedSeries: ids.length },
						"Sonarr metadata repair incomplete; remaining attempts are bounded",
					);
				// An errored result without a per-series outcome cannot prove a
				// selected target succeeded. Keep only our already-known hints.
				if (result.errors > 0)
					for (const id of ids) {
						if (!attempted.has(id)) failed.add(id);
					}
			} catch {
				app.log.warn(
					{ category: "metadata-retry-failed" },
					"Sonarr metadata repair failed; known targets retain only their remaining retry budget",
				);
			}
			let exhausted = 0;
			for (const id of ids) {
				const retry = metadataRetries.get(id)!;
				if (!failed.has(id)) {
					// Includes rows no longer eligible in the current enabled topology.
					metadataRetries.delete(id);
				} else if (retry.attempts >= METADATA_RETRY_BACKOFF_MS.length) {
					metadataRetries.delete(id);
					exhausted++;
				} else {
					retry.retryAt = Date.now() + METADATA_RETRY_BACKOFF_MS[retry.attempts]!;
				}
			}
			if (exhausted > 0)
				app.log.warn(
					{ exhausted },
					"Sonarr metadata repair budget exhausted; ordinary scheduled sync remains fallback",
				);
		}

		async function runOwnedRound(work: () => Promise<unknown>): Promise<void> {
			if (cancelled) return;
			let finish!: () => void;
			const completion = new Promise<void>((resolve) => {
				finish = resolve;
			});
			pendingRounds.add(completion);
			try {
				await app.restoreRuntime.runIndependentOperation(work);
			} catch (error) {
				if (!(error instanceof CleanupMaintenanceConflictError)) throw error;
				app.log.info("infoHash backfill skipped during database maintenance");
			} finally {
				pendingRounds.delete(completion);
				finish();
			}
		}

		async function runOneSweep({
			syncEpisodeFiles = true,
			onEpisodeSyncComplete,
		}: {
			syncEpisodeFiles?: boolean;
			onEpisodeSyncComplete?: () => void;
		} = {}): Promise<BackfillSweepResult | null> {
			if (cancelled) return null;
			if (isRunning) {
				app.log.warn("infoHash backfill already running, skipping tick");
				return null;
			}
			isRunning = true;
			try {
				let captured: BackfillSweepResult | null = null;
				await app.schedulerRegistry.track(JOB_ID.infoHashBackfill, async () => {
					captured = await runInfoHashBackfillSweep({
						app,
						log: app.log,
						batchSize: BATCH_SIZE,
						perRowSleepMs: PER_ROW_SLEEP_MS,
					});
					// Second pass: anything *arr-history couldn't resolve gets a
					// shot at matching against qui's torrent list by on-disk
					// shape (savePath + name, or `(name, size)` fingerprint for
					// hardlinked files). This bypasses *arr history retention
					// pruning — a huge coverage gain for older libraries.
					// Uses its own batch budget so a 500-row history pass + a
					// 500-row path pass don't compound into a 1000-row tick.
					// Failures here don't roll back the history-pass results.
					try {
						const pathResult = await runPathBackfillSweep({
							app,
							log: app.log,
							batchSize: BATCH_SIZE,
						});
						if (pathResult.rowsHashed > 0) {
							app.log.info(
								{ pathHashed: pathResult.rowsHashed, pathScanned: pathResult.rowsScanned },
								"infoHash path-correlation backfill hashed additional rows this tick",
							);
						}
						// Fold path-pass deltas into the captured result so the
						// scheduler's no-progress probe + activity-log emitter
						// see the combined work as one tick.
						if (captured) {
							captured.rowsScanned += pathResult.rowsScanned;
							captured.rowsHashed += pathResult.rowsHashed;
							captured.rowsMissed += pathResult.rowsMissed;
							captured.errors += pathResult.errors;
						}
					} catch (pathErr) {
						app.log.warn(
							{ err: pathErr },
							"infoHash path-correlation pass failed; continuing with history-only results",
						);
					}

					// Refresh metadata once per catch-up cycle. Known failures enter
					// bounded repair instead of repeating a broad metadata scan.
					let episodeFilesUpserted = 0;
					if (syncEpisodeFiles) {
						try {
							const episodeSync = await runEpisodeFileSync({
								app,
								log: app.log,
								seriesCap: BATCH_SIZE * 2,
							});
							recordMetadataOutcome(episodeSync);
							episodeFilesUpserted = episodeSync.filesUpserted;
							if (captured) captured.errors += episodeSync.errors;
						} catch (episodeErr) {
							if (captured) captured.errors++;
							app.log.warn(
								{ err: episodeErr },
								"infoHash episode-file metadata sync failed without known targets; ordinary scheduled sync remains fallback",
							);
						} finally {
							onEpisodeSyncComplete?.();
						}
					}
					try {
						const episodeSweep = await runEpisodeBackfillSweep({
							app,
							log: app.log,
							// Bound both Prisma's selected rows and per-row writes.
							// Catch-up repeats while due work decreases.
							batchSize: EPISODE_CATCHUP_BATCH_SIZE,
						});
						if (captured) {
							captured.rowsScanned += episodeSweep.rowsScanned;
							captured.rowsHashed += episodeSweep.rowsHashed;
							captured.rowsMissed += episodeSweep.rowsMissed;
							captured.errors += episodeSweep.errors;
						}
						if (episodeFilesUpserted > 0 || episodeSweep.rowsHashed > 0) {
							app.log.info(
								{
									episodeFilesUpserted,
									episodeFilesHashed: episodeSweep.rowsHashed,
									episodeRowsScanned: episodeSweep.rowsScanned,
								},
								"infoHash episode-file pipeline produced new state this tick",
							);
						}
					} catch (episodeErr) {
						if (captured) captured.errors++;
						app.log.warn(
							{ err: episodeErr },
							"infoHash episode-file pipeline failed; movies & series-level results still valid",
						);
					}
				});
				return captured;
			} catch (err) {
				// Registry already recorded the failure; preserve log semantics.
				app.log.error({ err }, "infoHash backfill tick failed");
				return null;
			} finally {
				isRunning = false;
			}
		}

		async function runDueCorrelationRetry(): Promise<void> {
			if (cancelled || isRunning) return;
			isRunning = true;
			let release: (() => void) | undefined;
			try {
				release = acquireIndependentCleanupOperationGuard();
				const metadataIds = [...metadataRetries]
					.filter(([, retry]) => retry.retryAt <= Date.now())
					.slice(0, METADATA_RETRY_BATCH_SIZE)
					.map(([id]) => id);
				let due = 0;
				try {
					due = await countDueDeferredCorrelationCandidates(app);
				} catch (error) {
					if (metadataIds.length === 0 || error instanceof CleanupMaintenanceConflictError)
						throw error;
					app.log.warn(
						{ category: "correlation-retry-probe-failed" },
						"infoHash correlation count failed; continuing known metadata repair only",
					);
				}
				if (due === 0 && metadataIds.length === 0) return;
				await app.schedulerRegistry.track(JOB_ID.infoHashBackfill, async () => {
					if (metadataIds.length > 0) await retryEpisodeMetadata(metadataIds);
					if (due === 0) return;
					const movie = await runPathBackfillSweep({
						app,
						log: app.log,
						batchSize: BATCH_SIZE,
						dueOnly: true,
					});
					const episode = await runEpisodeBackfillSweep({
						app,
						log: app.log,
						batchSize: EPISODE_RETRY_BATCH_SIZE,
						dueOnly: true,
					});
					app.log.info(
						{
							due,
							rowsScanned: movie.rowsScanned + episode.rowsScanned,
							rowsHashed: movie.rowsHashed + episode.rowsHashed,
							errors: movie.errors + episode.errors,
						},
						"infoHash due correlation retry completed",
					);
				});
			} catch (error) {
				if (error instanceof CleanupMaintenanceConflictError) throw error;
				app.log.warn(
					{ category: "correlation-retry-failed" },
					"infoHash due correlation retry failed; next probe will retry",
				);
			} finally {
				release?.();
				isRunning = false;
			}
		}

		/**
		 * Run sweeps back-to-back until the backlog drains, the hard cap
		 * trips, the plugin shuts down, or a tick fails to make forward
		 * progress. The forward-progress guard prevents an infinite loop in
		 * the unlikely case that the underlying *arr is misbehaving (e.g.
		 * always returning empty history) and counts never decrease.
		 */
		async function runCatchUp() {
			let lastRemaining = Number.POSITIVE_INFINITY;
			let lastSweep: BackfillSweepResult | null = null;
			let episodeSyncNeeded = true;
			for (let i = 0; i < MAX_CATCHUP_BATCHES; i++) {
				if (cancelled) return;
				// Probes and their selected sweep share one maintenance epoch. Release
				// before the idle gap, not before provider/persistence work settles.
				const release = acquireIndependentCleanupOperationGuard();
				try {
					let remaining = 0;
					try {
						remaining = await countBackfillCandidates(app);
					} catch (err) {
						app.log.warn({ err }, "infoHash backfill: count probe failed during catch-up");
						return;
					}
					if (remaining === 0) {
						const outstanding = await countOutstandingBackfillCandidates(app);
						if (outstanding === 0) {
							app.log.info("infoHash backfill: catch-up complete (backlog drained)");
						} else {
							app.log.info(
								{ outstanding },
								"infoHash backfill: no currently eligible rows; unresolved backlog remains",
							);
						}
						return;
					}
					if (remaining >= lastRemaining) {
						// Distinguish "*arr broken / auth failing" from "permanent backlog
						// tail" so operators know which is actionable. The last sweep's
						// error/miss breakdown is the strongest signal: high errors →
						// look at *arr; high misses with zero errors → backlog is
						// genuinely unresolvable (history pruned). See `infohash-backfill.ts`
						// where 401/403/5xx now throw to drive `errors` up rather than
						// silently counting as misses.
						app.log.warn(
							{
								remaining,
								lastRemaining,
								lastSweep: lastSweep
									? {
											errors: lastSweep.errors,
											rowsMissed: lastSweep.rowsMissed,
											rowsHashed: lastSweep.rowsHashed,
										}
									: null,
								hint:
									(lastSweep?.errors ?? 0) > 0
										? "non-zero errors — check *arr API key / instance health (look for ERROR-level logs from infohash-backfill)"
										: "zero errors — backlog is unresolvable (most likely *arr history retention pruned the original grab records)",
							},
							"infoHash backfill: catch-up made no progress, falling through to steady-state",
						);
						return;
					}
					lastRemaining = remaining;

					app.log.info(
						{ batchIndex: i + 1, remaining, hardCap: MAX_CATCHUP_BATCHES },
						"infoHash backfill: catch-up batch starting",
					);
					lastSweep = await runOneSweep({
						syncEpisodeFiles: episodeSyncNeeded,
						onEpisodeSyncComplete: () => {
							episodeSyncNeeded = false;
						},
					});
				} finally {
					release();
				}

				// Breathing room before the next batch — gives *arr a chance to
				// service interactive requests instead of being saturated by
				// back-to-back history fetches.
				if (!cancelled && i < MAX_CATCHUP_BATCHES - 1) {
					await new Promise<void>((resolve) => {
						wakeCatchUpGap = resolve;
						catchUpGapHandle = setTimeout(() => {
							catchUpGapHandle = null;
							wakeCatchUpGap = null;
							resolve();
						}, CATCHUP_GAP_MS);
					});
				}
			}
			app.log.info(
				{
					historyMovieRowCap: MAX_CATCHUP_BATCHES * BATCH_SIZE,
					episodeRowCap: MAX_CATCHUP_BATCHES * EPISODE_CATCHUP_BATCH_SIZE,
				},
				"infoHash backfill: catch-up hit hard cap, remainder will drain via steady-state ticks",
			);
		}

		app.addHook("onReady", async () => {
			if (cancelled) return;
			app.log.info(
				`infoHash backfill scheduler initialized (catch-up on startup, ${INTERVAL_MS / 60_000}min steady-state)`,
			);

			timeoutHandle = setTimeout(() => {
				if (cancelled || startupStarted) return;
				startupStarted = true;
				timeoutHandle = null;
				// Catch-up phase: drain any existing backlog.
				runOwnedRound(runCatchUp)
					.catch((err) => {
						app.log.error({ err }, "infoHash backfill: catch-up phase failed");
					})
					.finally(() => {
						if (cancelled) return;
						// Steady-state phase: pick up any newly-landed items every 6h.
						intervalHandle = setInterval(() => {
							runOwnedRound(runOneSweep).catch((err) => {
								app.log.error({ err }, "Failed during scheduled infoHash backfill");
							});
						}, INTERVAL_MS);
						retryIntervalHandle = setInterval(() => {
							runOwnedRound(runDueCorrelationRetry).catch((err) => {
								app.log.error({ err }, "Failed during scheduled infoHash correlation retry");
							});
						}, RETRY_PROBE_INTERVAL_MS);
					});
			}, STARTUP_DELAY_MS);
		});

		function closeAdmission() {
			cancelled = true;
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
				timeoutHandle = null;
			}
			if (intervalHandle) {
				clearInterval(intervalHandle);
				intervalHandle = null;
			}
			if (retryIntervalHandle) {
				clearInterval(retryIntervalHandle);
				retryIntervalHandle = null;
			}
			if (catchUpGapHandle) {
				clearTimeout(catchUpGapHandle);
				catchUpGapHandle = null;
			}
			wakeCatchUpGap?.();
			wakeCatchUpGap = null;
		}
		app.addHook("preClose", async () => closeAdmission());
		app.addHook("onClose", async () => {
			closeAdmission();
			while (pendingRounds.size > 0) await Promise.all([...pendingRounds]);
			app.log.info("infoHash backfill scheduler stopped");
		});
	},
	{
		name: "infohash-backfill-scheduler",
		dependencies: ["prisma", "security", "scheduler-registry"],
	},
);

export default infoHashBackfillSchedulerPlugin;
