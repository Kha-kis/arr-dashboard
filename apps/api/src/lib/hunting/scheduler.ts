import type { FastifyInstance } from "fastify";
import { loggers } from "../logger.js";
import { withTimeout } from "../utils/delay.js";
import { getErrorMessage } from "../utils/error-message.js";
import {
	MAX_HUNT_DURATION_MS,
	MIN_INSTANCE_COOLDOWN_MINS,
	MIN_MANUAL_HUNT_COOLDOWN_MINS,
} from "./constants.js";
import { executeHuntWithSdk, type HuntResult } from "./hunt-executor.js";

const log = loggers.hunting;

/**
 * Hunting Scheduler
 *
 * Manages automated hunt jobs for missing content and quality upgrades.
 * Uses a simple interval-based approach that can be replaced with node-cron later.
 * Enforces minimum cooldown periods to prevent overwhelming arr instances.
 */

// Track last hunt times per instance (in-memory for cooldown enforcement)
interface InstanceHuntTimes {
	lastAnyHunt: Date | null;
	lastMissingHunt: Date | null;
	lastUpgradeHunt: Date | null;
}

class HuntingScheduler {
	private app: FastifyInstance | null = null;
	private running = false;
	private intervalId: NodeJS.Timeout | null = null;
	// In-memory cooldown tracking (supplements database timestamps)
	private instanceHuntTimes: Map<string, InstanceHuntTimes> = new Map();

	/**
	 * Initialize the scheduler with the app instance
	 * This must be called before any hunts can run (manual or scheduled)
	 */
	initialize(app: FastifyInstance): void {
		this.app = app;

		// Clean up any stuck hunts from previous runs
		this.cleanupStuckHunts().catch((error) => {
			log.error({ err: error }, "Failed to cleanup stuck hunts on init");
		});
	}

	/**
	 * Clean up hunts that were left in "running" state from previous app runs
	 * This can happen if the app crashes or is restarted during a hunt
	 */
	private async cleanupStuckHunts(): Promise<void> {
		if (!this.app) return;

		try {
			const stuckHunts = await this.app.prisma.huntLog.findMany({
				where: { status: "running" },
			});

			if (stuckHunts.length > 0) {
				await this.app.prisma.huntLog.updateMany({
					where: { status: "running" },
					data: {
						status: "error",
						message: "Hunt was interrupted (app restart or crash)",
						completedAt: new Date(),
					},
				});
			}
		} catch (error) {
			log.error({ err: error }, "Failed to cleanup stuck hunts");
		}
	}

	/**
	 * Start the hunting scheduler (automatic/scheduled hunts)
	 */
	start(app: FastifyInstance): void {
		if (this.running) {
			return;
		}

		// Initialize if not already done
		if (!this.app) {
			this.app = app;
		}
		this.running = true;

		// Check every minute for hunts that need to run
		this.intervalId = setInterval(() => {
			this.tick().catch((error) => {
				log.error({ err: error }, "Scheduler tick failed");
			});
		}, 60 * 1000);
	}

	/**
	 * Stop the hunting scheduler (automatic/scheduled hunts only)
	 * Manual hunts can still be triggered when stopped
	 */
	stop(): void {
		if (!this.running) {
			return;
		}

		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}

		this.running = false;
		// Keep app reference so manual hunts still work
	}

	/**
	 * Check if scheduler is running
	 */
	isRunning(): boolean {
		return this.running;
	}

	/**
	 * Trigger a manual hunt (with cooldown check)
	 * Starts the hunt immediately instead of waiting for scheduler tick
	 */
	triggerManualHunt(
		instanceId: string,
		type: "missing" | "upgrade",
	): { queued: boolean; message: string } {
		// Check cooldowns before running
		const cooldownCheck = this.checkCooldown(instanceId, type, true);
		if (!cooldownCheck.ok) {
			return { queued: false, message: cooldownCheck.message };
		}

		if (!this.app) {
			return { queued: false, message: "Scheduler not started" };
		}

		// Update hunt times immediately to prevent race conditions with rapid API calls
		this.updateHuntTimes(instanceId, type);

		// Run hunt immediately in background (don't await - let API return quickly)
		this.runHunt(instanceId, type, true).catch((error) => {
			log.error({ err: error, instanceId }, "Manual hunt failed");
		});

		return { queued: true, message: `${type} hunt started` };
	}

	/**
	 * Check if an instance is within cooldown period
	 */
	private checkCooldown(
		instanceId: string,
		type: "missing" | "upgrade",
		isManual: boolean,
	): { ok: boolean; message: string } {
		const now = new Date();
		const times = this.instanceHuntTimes.get(instanceId);

		if (!times) {
			return { ok: true, message: "No previous hunts recorded" };
		}

		// Check global instance cooldown (prevents back-to-back requests)
		if (times.lastAnyHunt) {
			const minsSinceLastHunt = (now.getTime() - times.lastAnyHunt.getTime()) / (60 * 1000);
			if (minsSinceLastHunt < MIN_INSTANCE_COOLDOWN_MINS) {
				const waitMins = Math.ceil(MIN_INSTANCE_COOLDOWN_MINS - minsSinceLastHunt);
				return {
					ok: false,
					message: `Instance cooldown: wait ${waitMins} minute(s) between hunts`,
				};
			}
		}

		// For manual hunts, also check type-specific cooldown
		if (isManual) {
			const lastTypeHunt = type === "missing" ? times.lastMissingHunt : times.lastUpgradeHunt;
			if (lastTypeHunt) {
				const minsSinceLastTypeHunt = (now.getTime() - lastTypeHunt.getTime()) / (60 * 1000);
				if (minsSinceLastTypeHunt < MIN_MANUAL_HUNT_COOLDOWN_MINS) {
					const waitMins = Math.ceil(MIN_MANUAL_HUNT_COOLDOWN_MINS - minsSinceLastTypeHunt);
					return {
						ok: false,
						message: `Manual hunt cooldown: wait ${waitMins} minute(s) before another ${type} hunt`,
					};
				}
			}
		}

		return { ok: true, message: "Cooldown satisfied" };
	}

	/**
	 * Update hunt times after a successful hunt
	 */
	private updateHuntTimes(instanceId: string, type: "missing" | "upgrade"): void {
		const now = new Date();
		const existing = this.instanceHuntTimes.get(instanceId) ?? {
			lastAnyHunt: null,
			lastMissingHunt: null,
			lastUpgradeHunt: null,
		};

		existing.lastAnyHunt = now;
		if (type === "missing") {
			existing.lastMissingHunt = now;
		} else {
			existing.lastUpgradeHunt = now;
		}

		this.instanceHuntTimes.set(instanceId, existing);
	}

	/**
	 * Main scheduler tick - runs every minute
	 */
	private async tick(): Promise<void> {
		if (!this.app) return;

		try {
			await this.processScheduledHunts();
		} catch (error) {
			log.error({ err: error }, "Tick error");
		}
	}

	/**
	 * Check and process scheduled hunts
	 */
	private async processScheduledHunts(): Promise<void> {
		if (!this.app) return;

		const now = new Date();
		const ONE_HOUR_MS = 60 * 60 * 1000;

		// Reset expired API call counters, preserving the original hourly window alignment
		const expiredConfigs = await this.app.prisma.huntConfig.findMany({
			where: {
				OR: [{ huntMissingEnabled: true }, { huntUpgradesEnabled: true }],
				apiCallsResetAt: { lt: now },
			},
			select: { id: true, apiCallsResetAt: true },
		});
		for (const ec of expiredConfigs) {
			// Advance from the original resetAt to avoid drift
			let nextReset = ec.apiCallsResetAt
				? new Date(ec.apiCallsResetAt.getTime() + ONE_HOUR_MS)
				: new Date(now.getTime() + ONE_HOUR_MS);
			// If still in the past (e.g., after long downtime), snap to now + 1h
			if (nextReset <= now) nextReset = new Date(now.getTime() + ONE_HOUR_MS);

			await this.app.prisma.huntConfig.update({
				where: { id: ec.id },
				data: { apiCallsThisHour: 0, apiCallsResetAt: nextReset },
			});
		}

		// Get all enabled hunt configs (after reset, so counts are fresh)
		const configs = await this.app.prisma.huntConfig.findMany({
			where: {
				OR: [{ huntMissingEnabled: true }, { huntUpgradesEnabled: true }],
			},
			include: {
				instance: true,
			},
		});

		for (const config of configs) {
			// Check if we're over API cap
			if (config.apiCallsThisHour >= config.hourlyApiCap) {
				continue;
			}

			// Note: Queue threshold check is intentionally done inside executeHuntWithSdk() rather than here.
			// This avoids making unnecessary API calls for instances that aren't due for a hunt,
			// and ensures the queue is checked at execution time (not scheduling time).

			// Check missing hunt schedule
			if (config.huntMissingEnabled) {
				const lastMissing = config.lastMissingHunt ?? new Date(0);
				const nextMissing = new Date(
					lastMissing.getTime() + config.missingIntervalMins * 60 * 1000,
				);

				if (now >= nextMissing) {
					await this.runHunt(config.instanceId, "missing");
				}
			}

			// Check upgrade hunt schedule
			if (config.huntUpgradesEnabled) {
				const lastUpgrade = config.lastUpgradeHunt ?? new Date(0);
				const nextUpgrade = new Date(
					lastUpgrade.getTime() + config.upgradeIntervalMins * 60 * 1000,
				);

				if (now >= nextUpgrade) {
					await this.runHunt(config.instanceId, "upgrade");
				}
			}
		}
	}

	/**
	 * Execute a hunt for an instance
	 */
	private async runHunt(
		instanceId: string,
		type: "missing" | "upgrade",
		isManual = false,
	): Promise<void> {
		if (!this.app) return;

		// For scheduled hunts, enforce cooldown check here
		// For manual hunts, skip this check since triggerManualHunt already checked
		// and called updateHuntTimes (which would cause this check to fail)
		if (!isManual) {
			const cooldownCheck = this.checkCooldown(instanceId, type, false);
			if (!cooldownCheck.ok) {
				return;
			}
		}

		const startTime = Date.now();

		// Get config and instance
		const config = await this.app.prisma.huntConfig.findUnique({
			where: { instanceId },
			include: { instance: true },
		});

		if (!config) {
			log.error({ instanceId }, "No config found for instance");
			return;
		}

		// Create log entry with "running" status
		const huntLogEntry = await this.app.prisma.huntLog.create({
			data: {
				instanceId,
				huntType: type,
				status: "running",
				itemsSearched: 0,
				itemsFound: 0,
			},
		});

		// Update hunt times immediately to prevent race conditions
		this.updateHuntTimes(instanceId, type);

		try {
			// Execute the actual hunt using hunt-executor with timeout protection
			const result: HuntResult = await withTimeout(
				executeHuntWithSdk(this.app, config.instance, config, type),
				MAX_HUNT_DURATION_MS,
				`Hunt timed out after ${MAX_HUNT_DURATION_MS / 1000} seconds`,
			);

			// Update log with results
			const durationMs = Date.now() - startTime;
			await this.app.prisma.huntLog.update({
				where: { id: huntLogEntry.id },
				data: {
					itemsSearched: result.itemsSearched,
					itemsFound: result.itemsGrabbed,
					// searchedItems = items we triggered searches for
					searchedItems:
						result.searchedItems.length > 0 ? JSON.stringify(result.searchedItems) : null,
					// foundItems = items that were actually grabbed (reusing existing field)
					foundItems: result.grabbedItems.length > 0 ? JSON.stringify(result.grabbedItems) : null,
					status: result.status,
					message: result.message,
					durationMs,
					completedAt: new Date(),
				},
			});

			log.info({
				instanceLabel: config.instance.label,
				huntType: type,
				status: result.status,
				itemsSearched: result.itemsSearched,
				itemsGrabbed: result.itemsGrabbed,
				apiCalls: result.apiCallsMade,
				durationMs,
			}, "Hunt completed");

			// Fire-and-forget notification for hunt results
			const huntMeta = {
				instance: config.instance.label,
				service: config.instance.service,
				huntType: type,
				itemsSearched: result.itemsSearched,
				itemsGrabbed: result.itemsGrabbed,
				apiCalls: result.apiCallsMade,
				durationMs,
				grabbedItems: result.grabbedItems.slice(0, 5).map((g) => g.title),
			};
			if (result.itemsGrabbed > 0) {
				this.app.notificationService
					?.notify({
						eventType: "HUNT_CONTENT_FOUND",
						title: `Hunt found ${result.itemsGrabbed} item(s) on ${config.instance.label}`,
						body: result.message,
						url: "/hunting",
						metadata: huntMeta,
					})
					.catch((err) => {
						log.debug({ err, instanceLabel: config.instance.label }, "Hunt notification dispatch failed");
					});
			} else if (result.status === "completed") {
				this.app.notificationService
					?.notify({
						eventType: "HUNT_COMPLETED",
						title: `Hunt completed on ${config.instance.label}`,
						body: result.message,
						url: "/hunting",
						metadata: huntMeta,
					})
					.catch((err) => {
						log.debug({ err, instanceLabel: config.instance.label }, "Hunt notification dispatch failed");
					});
			}

			// Update config timestamps and API call count (only if we actually made API calls)
			if (result.status !== "skipped" && result.apiCallsMade > 0) {
				const updateData: Record<string, unknown> = {
					apiCallsThisHour: { increment: result.apiCallsMade },
				};

				if (type === "missing") {
					updateData.lastMissingHunt = new Date();
				} else {
					updateData.lastUpgradeHunt = new Date();
				}

				if (!config.apiCallsResetAt) {
					updateData.apiCallsResetAt = new Date(Date.now() + 60 * 60 * 1000);
				}

				await this.app.prisma.huntConfig.update({
					where: { id: config.id },
					data: updateData,
				});
			}
		} catch (error) {
			const durationMs = Date.now() - startTime;
			const message = getErrorMessage(error, "Unknown error");

			await this.app.prisma.huntLog.update({
				where: { id: huntLogEntry.id },
				data: {
					status: "error",
					message,
					durationMs,
					completedAt: new Date(),
				},
			});

			log.error({ err: error, instanceLabel: config.instance.label }, "Hunt error");

			// Fire-and-forget notification for hunt failure
			this.app.notificationService
				?.notify({
					eventType: "HUNT_FAILED",
					title: `Hunt failed on ${config.instance.label}`,
					body: message,
					url: "/hunting",
					metadata: {
						instance: config.instance.label,
						service: config.instance.service,
						huntType: type,
						durationMs,
					},
				})
				.catch((err) => {
					log.debug({ err, instanceLabel: config.instance.label }, "Hunt failure notification dispatch failed");
				});
		}
	}
}

// Singleton instance
let scheduler: HuntingScheduler | null = null;

/**
 * Retrieve the singleton HuntingScheduler instance.
 *
 * @returns The global HuntingScheduler singleton.
 */
export function getHuntingScheduler(): HuntingScheduler {
	if (!scheduler) {
		scheduler = new HuntingScheduler();
	}
	return scheduler;
}
