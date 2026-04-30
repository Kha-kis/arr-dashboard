/**
 * Auto-Tag Scheduler
 *
 * Walks enabled `AutoTagRule` rows and runs each through the same
 * execution engine as the on-demand "Run now" endpoint
 * (`executeAutoTagRule`). Per-rule cooldown skips rules that already
 * ran in the last hour.
 *
 * Mirrors the LabelSyncScheduler pattern:
 * - Singleton: in-flight guard prevents overlapping ticks
 * - Tick interval: 5 minutes (registry-declared `intervalMs`)
 * - Per-rule cooldown: 60 minutes since last run
 */

import type { FastifyBaseLogger } from "fastify";
import type { ArrClientFactory } from "../arr/client-factory.js";
import type { Encryptor } from "../auth/encryption.js";
import type { PrismaClient } from "../prisma.js";
import {
	passthroughTickWrapper,
	type TickWrapper,
} from "../scheduler-registry/scheduler-registry.js";
import { executeAutoTagRule } from "./execute-rule.js";
import { runRuleWithLock } from "./run-with-lock.js";

const TICK_INTERVAL_MS = 5 * 60 * 1000; // Wake every 5 minutes
const RULE_COOLDOWN_MS = 60 * 60 * 1000; // Skip rules that ran in the last hour

export class AutoTagScheduler {
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
			this.log.warn("Auto-tag scheduler already running");
			return;
		}

		this.log.info({ intervalMs: TICK_INTERVAL_MS }, "Starting auto-tag scheduler");

		this.trackTick(() => this.tick()).catch((err) => {
			this.log.error({ err }, "Initial auto-tag tick failed");
		});

		this.intervalId = setInterval(() => {
			this.trackTick(() => this.tick()).catch((err) => {
				this.log.error({ err }, "Scheduled auto-tag tick failed");
			});
		}, TICK_INTERVAL_MS);
	}

	stop(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
			this.log.info("Auto-tag scheduler stopped");
		}
	}

	private async tick(): Promise<void> {
		if (this.inFlight) {
			this.log.debug("Auto-tag tick skipped — previous tick still in flight");
			return;
		}
		this.inFlight = true;

		try {
			const cooldownThreshold = new Date(Date.now() - RULE_COOLDOWN_MS);
			const dueRules = await this.prisma.autoTagRule.findMany({
				where: {
					enabled: true,
					OR: [{ lastRunAt: null }, { lastRunAt: { lt: cooldownThreshold } }],
				},
			});

			if (dueRules.length === 0) {
				this.log.debug("No auto-tag rules due this tick");
				return;
			}

			this.log.info({ ruleCount: dueRules.length }, "Running scheduled auto-tag rules");

			let succeeded = 0;
			let partial = 0;
			let failed = 0;
			let skipped = 0;

			for (const rule of dueRules) {
				try {
					// Skip if an on-demand "Run now" is currently executing this same
					// rule — prevents two concurrent series/movie.update calls from
					// racing and dropping each other's tag merges.
					const lockResult = await runRuleWithLock(rule.id, () =>
						executeAutoTagRule({
							rule: {
								id: rule.id,
								userId: rule.userId,
								name: rule.name,
								ruleType: rule.ruleType,
								parameters: parseRecord(rule.parameters),
								operator: rule.operator as "AND" | "OR" | null,
								conditions: parseArray<{
									ruleType: string;
									parameters: Record<string, unknown>;
								}>(rule.conditions),
								serviceFilter: parseArray<string>(rule.serviceFilter),
								instanceFilter: parseArray<string>(rule.instanceFilter),
								excludeTags: parseArray<number>(rule.excludeTags),
								excludeTitles: parseArray<string>(rule.excludeTitles),
								plexLibraryFilter: parseArray<string>(rule.plexLibraryFilter),
								tagName: rule.tagName,
							},
							prisma: this.prisma,
							arrClientFactory: this.arrClientFactory,
							encryptor: this.encryptor,
							log: this.log,
						}),
					);

					if (lockResult.status === "skipped") {
						skipped++;
						this.log.debug(
							{ ruleId: rule.id },
							"Auto-tag rule skipped — already running (on-demand run in flight)",
						);
						continue;
					}

					const result = lockResult.result;
					await this.prisma.autoTagRule.update({
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
						"Auto-tag rule execution threw — recording as failure",
					);
					await this.prisma.autoTagRule
						.update({
							where: { id: rule.id },
							data: {
								lastRunAt: new Date(),
								lastRunStatus: "failed",
								lastRunMessage: `Scheduler exception: ${message}`,
							},
						})
						.catch((updateErr: unknown) => {
							this.log.error(
								{ err: updateErr, ruleId: rule.id },
								"Failed to persist auto-tag rule failure status",
							);
						});
				}
			}

			this.log.info(
				{ ruleCount: dueRules.length, succeeded, partial, failed, skipped },
				"Scheduled auto-tag tick complete",
			);
		} finally {
			this.inFlight = false;
		}
	}
}

function parseRecord(value: string | null): Record<string, unknown> {
	if (!value) return {};
	try {
		const parsed = JSON.parse(value);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		/* fall through */
	}
	return {};
}

function parseArray<T>(value: string | null): T[] | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value);
		if (Array.isArray(parsed)) return parsed as T[];
	} catch {
		/* fall through */
	}
	return null;
}
