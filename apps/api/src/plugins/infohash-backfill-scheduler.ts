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
 * Hard cap: MAX_CATCHUP_BATCHES * BATCH_SIZE rows per startup = 10k rows /
 * ~17 minutes worst-case. Libraries larger than that finish the long tail
 * across subsequent steady-state ticks rather than ever blocking startup.
 */

import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import {
	type BackfillSweepResult,
	countBackfillCandidates,
	runInfoHashBackfillSweep,
} from "../lib/library-sync/infohash-backfill.js";
import { JOB_ID } from "../lib/scheduler-registry/job-definitions.js";

const INTERVAL_MS = 6 * 60 * 60_000; // 6h steady-state cadence
const STARTUP_DELAY_MS = 30_000; // 30s before first action
const CATCHUP_GAP_MS = 60_000; // 60s breathing room between catch-up batches
const MAX_CATCHUP_BATCHES = 20; // hard cap: 10k rows / ~17 min worst-case
const BATCH_SIZE = 500;
const PER_ROW_SLEEP_MS = 100;

const infoHashBackfillSchedulerPlugin = fp(
	async (app: FastifyInstance) => {
		let intervalHandle: ReturnType<typeof setInterval> | null = null;
		let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
		let cancelled = false;
		let isRunning = false;

		async function runOneSweep(): Promise<BackfillSweepResult | null> {
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
			for (let i = 0; i < MAX_CATCHUP_BATCHES; i++) {
				if (cancelled) return;
				let remaining = 0;
				try {
					remaining = await countBackfillCandidates(app);
				} catch (err) {
					app.log.warn({ err }, "infoHash backfill: count probe failed during catch-up");
					return;
				}
				if (remaining === 0) {
					app.log.info("infoHash backfill: catch-up complete (backlog drained)");
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
				lastSweep = await runOneSweep();

				// Breathing room before the next batch — gives *arr a chance to
				// service interactive requests instead of being saturated by
				// back-to-back history fetches.
				if (!cancelled && i < MAX_CATCHUP_BATCHES - 1) {
					await new Promise((resolve) => setTimeout(resolve, CATCHUP_GAP_MS));
				}
			}
			app.log.info(
				{ hardCap: MAX_CATCHUP_BATCHES * BATCH_SIZE },
				"infoHash backfill: catch-up hit hard cap, remainder will drain via steady-state ticks",
			);
		}

		app.addHook("onReady", async () => {
			app.log.info(
				`infoHash backfill scheduler initialized (catch-up on startup, ${INTERVAL_MS / 60_000}min steady-state)`,
			);

			timeoutHandle = setTimeout(() => {
				// Catch-up phase: drain any existing backlog.
				runCatchUp()
					.catch((err) => {
						app.log.error({ err }, "infoHash backfill: catch-up phase failed");
					})
					.finally(() => {
						if (cancelled) return;
						// Steady-state phase: pick up any newly-landed items every 6h.
						intervalHandle = setInterval(() => {
							runOneSweep().catch((err) => {
								app.log.error({ err }, "Failed during scheduled infoHash backfill");
							});
						}, INTERVAL_MS);
					});
			}, STARTUP_DELAY_MS);
		});

		app.addHook("onClose", async () => {
			cancelled = true;
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (intervalHandle) clearInterval(intervalHandle);
			app.log.info("infoHash backfill scheduler stopped");
		});
	},
	{
		name: "infohash-backfill-scheduler",
		dependencies: ["prisma", "security", "scheduler-registry"],
	},
);

export default infoHashBackfillSchedulerPlugin;
