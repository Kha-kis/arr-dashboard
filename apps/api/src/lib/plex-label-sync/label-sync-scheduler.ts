/**
 * Plex Label Sync Scheduler
 *
 * Walks enabled PlexLabelSyncRule rows and runs each through the same
 * execution engine that powers the on-demand "Run now" endpoint
 * (`executeLabelSyncRule`). Per-rule cooldown skips rules that already
 * ran in the last hour, so a manually-triggered run and a scheduled
 * tick don't double-fire on the same rule.
 *
 * Mirrors the BackupScheduler / CleanupScheduler pattern:
 * - Singleton: in-flight guard prevents overlapping ticks
 * - Tick interval: 5 minutes (the registry-declared `intervalMs`)
 * - Per-rule cooldown: 60 minutes since last successful run
 */

import type { FastifyBaseLogger } from "fastify";
import type { ArrClientFactory } from "../arr/client-factory.js";
import type { Encryptor } from "../auth/encryption.js";
import type { PrismaClient } from "../prisma.js";
import {
	passthroughTickWrapper,
	type TickWrapper,
} from "../scheduler-registry/scheduler-registry.js";
import { executeLabelSyncRule } from "./execute-rule.js";

const TICK_INTERVAL_MS = 5 * 60 * 1000; // Wake every 5 minutes
const RULE_COOLDOWN_MS = 60 * 60 * 1000; // Skip rules that ran in the last hour

export class LabelSyncScheduler {
	private intervalId: NodeJS.Timeout | null = null;
	private inFlight = false;
	private trackTick: TickWrapper;

	constructor(
		private prisma: PrismaClient,
		private arrClientFactory: ArrClientFactory,
		private encryptor: Encryptor,
		private log: FastifyBaseLogger,
		options?: { trackTick?: TickWrapper },
	) {
		this.trackTick = options?.trackTick ?? passthroughTickWrapper;
	}

	start(): void {
		if (this.intervalId) {
			this.log.warn("Label sync scheduler already running");
			return;
		}

		this.log.info({ intervalMs: TICK_INTERVAL_MS }, "Starting Plex label sync scheduler");

		// Fire one tick immediately so a recently-modified rule doesn't wait the
		// full interval before its first scheduled run.
		this.trackTick(() => this.tick()).catch((err) => {
			this.log.error({ err }, "Initial label-sync tick failed");
		});

		this.intervalId = setInterval(() => {
			this.trackTick(() => this.tick()).catch((err) => {
				this.log.error({ err }, "Scheduled label-sync tick failed");
			});
		}, TICK_INTERVAL_MS);
	}

	stop(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
			this.log.info("Plex label sync scheduler stopped");
		}
	}

	/**
	 * One scheduler tick. Selects rules that are due (enabled, and either
	 * never run or last-run is older than the cooldown), executes each
	 * serially, persists the result.
	 */
	private async tick(): Promise<void> {
		if (this.inFlight) {
			this.log.debug("Label sync tick skipped — previous tick still in flight");
			return;
		}
		this.inFlight = true;

		try {
			const cooldownThreshold = new Date(Date.now() - RULE_COOLDOWN_MS);
			const dueRules = await this.prisma.plexLabelSyncRule.findMany({
				where: {
					enabled: true,
					OR: [{ lastRunAt: null }, { lastRunAt: { lt: cooldownThreshold } }],
				},
			});

			if (dueRules.length === 0) {
				this.log.debug("No label-sync rules due this tick");
				return;
			}

			this.log.info({ ruleCount: dueRules.length }, "Running scheduled label-sync rules");

			let succeeded = 0;
			let partial = 0;
			let failed = 0;

			for (const rule of dueRules) {
				try {
					const result = await executeLabelSyncRule({
						rule: {
							id: rule.id,
							userId: rule.userId,
							arrService: rule.arrService,
							arrInstanceId: rule.arrInstanceId,
							arrTagName: rule.arrTagName,
							plexInstanceId: rule.plexInstanceId,
							plexLabel: rule.plexLabel,
						},
						prisma: this.prisma,
						arrClientFactory: this.arrClientFactory,
						encryptor: this.encryptor,
						log: this.log,
					});

					await this.prisma.plexLabelSyncRule.update({
						where: { id: rule.id },
						data: {
							lastRunAt: new Date(),
							lastRunStatus: result.status,
							lastRunMessage: result.message,
						},
					});

					if (result.status === "success") succeeded++;
					else if (result.status === "partial") partial++;
					else failed++;
				} catch (err) {
					failed++;
					const message = err instanceof Error ? err.message : String(err);
					this.log.warn(
						{ err, ruleId: rule.id },
						"Label-sync rule execution threw — recording as failure",
					);
					await this.prisma.plexLabelSyncRule
						.update({
							where: { id: rule.id },
							data: {
								lastRunAt: new Date(),
								lastRunStatus: "failed",
								lastRunMessage: `Scheduler exception: ${message}`,
							},
						})
						.catch((updateErr) => {
							this.log.error(
								{ err: updateErr, ruleId: rule.id },
								"Failed to persist rule failure status",
							);
						});
				}
			}

			this.log.info(
				{ ruleCount: dueRules.length, succeeded, partial, failed },
				"Scheduled label-sync tick complete",
			);
		} finally {
			this.inFlight = false;
		}
	}
}
