import type { FastifyInstance } from "fastify";
import { executeHunt, type HuntResult } from "./hunt-executor.js";
import {
	MIN_MANUAL_HUNT_COOLDOWN_MINS,
	MIN_INSTANCE_COOLDOWN_MINS,
	MAX_HUNT_DURATION_MS,
} from "./constants.js";

/**
 * Execute a promise with a timeout
 * Throws an error if the promise doesn't resolve within the specified time
 */
async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	timeoutMessage: string,
): Promise<T> {
	let timeoutId: NodeJS.Timeout | undefined;

	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => {
			reject(new Error(timeoutMessage));
		}, timeoutMs);
	});

	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timeoutId) {
			clearTimeout(timeoutId);
		}
	}
}

/**
 * Hunting Scheduler
 *
 * Manages automated hunt jobs for missing content and quality upgrades.
 * Uses a simple interval-based approach that can be replaced with node-cron later.
 * Enforces minimum cooldown periods to prevent overwhelming arr instances.
 */

interface QueuedHunt {
	instanceId: string;
	type: "missing" | "upgrade";
	queuedAt: Date;
}

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
	private manualQueue: QueuedHunt[] = [];
	// In-memory cooldown tracking (supplements database timestamps)
	private instanceHuntTimes: Map<string, InstanceHuntTimes> = new Map();

	/**
	 * Initialize the scheduler with the app instance
	 * This must be called before any hunts can run (manual or scheduled)
	 */
	initialize(app: FastifyInstance): void {
		this.app = app;
		console.log("[HuntingScheduler] Initialized");

		// Clean up any stuck hunts from previous runs
		this.cleanupStuckHunts().catch((error) => {
			console.error("[HuntingScheduler] Failed to cleanup stuck hunts on init:", error);
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
				console.log(`[HuntingScheduler] Found ${stuckHunts.length} stuck hunt(s), marking as error`);

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
			console.error("[HuntingScheduler] Failed to cleanup stuck hunts:", error);
		}
	}

	/**
	 * Start the hunting scheduler (automatic/scheduled hunts)
	 */
	start(app: FastifyInstance): void {
		if (this.running) {
			console.log("[HuntingScheduler] Already running");
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
				console.error("[HuntingScheduler] Scheduler tick failed:", error);
			});
		}, 60 * 1000);

		console.log("[HuntingScheduler] Started");
	}

	/**
	 * Stop the hunting scheduler (automatic/scheduled hunts only)
	 * Manual hunts can still be triggered when stopped
	 */
	stop(): void {
		if (!this.running) {
			console.log("[HuntingScheduler] Not running");
			return;
		}

		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}

		this.running = false;
		// Keep app reference so manual hunts still work
		console.log("[HuntingScheduler] Stopped (manual hunts still available)");
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
	triggerManualHunt(instanceId: string, type: "missing" | "upgrade"): { queued: boolean; message: string } {
		// Check cooldowns before running
		const cooldownCheck = this.checkCooldown(instanceId, type, true);
		if (!cooldownCheck.ok) {
			console.log(`[HuntingScheduler] Manual ${type} hunt for ${instanceId} rejected: ${cooldownCheck.message}`);
			return { queued: false, message: cooldownCheck.message };
		}

		if (!this.app) {
			console.log(`[HuntingScheduler] Manual ${type} hunt for ${instanceId} rejected: Scheduler not started`);
			return { queued: false, message: "Scheduler not started" };
		}

		console.log(`[HuntingScheduler] Starting manual ${type} hunt for ${instanceId}`);

		// Update hunt times immediately to prevent race conditions with rapid API calls
		this.updateHuntTimes(instanceId, type);

		// Run hunt immediately in background (don't await - let API return quickly)
		this.runHunt(instanceId, type, true).catch((error) => {
			console.error(`[HuntingScheduler] Manual hunt failed for ${instanceId}:`, error);
		});

		return { queued: true, message: `${type} hunt started` };
	}

	/**
	 * @deprecated Use triggerManualHunt instead - kept for backwards compatibility
	 */
	queueManualHunt(instanceId: string, type: "missing" | "upgrade"): { queued: boolean; message: string } {
		return this.triggerManualHunt(instanceId, type);
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
			// Process manual queue first
			await this.processManualQueue();

			// Then check for scheduled hunts
			await this.processScheduledHunts();
		} catch (error) {
			console.error("[HuntingScheduler] Tick error:", error);
		}
	}

	/**
	 * Process manually queued hunts
	 */
	private async processManualQueue(): Promise<void> {
		if (!this.app || this.manualQueue.length === 0) return;

		const hunt = this.manualQueue.shift();
		if (!hunt) return;

		console.log(`[HuntingScheduler] Processing manual ${hunt.type} hunt for ${hunt.instanceId}`);
		await this.runHunt(hunt.instanceId, hunt.type, true);
	}

	/**
	 * Check and process scheduled hunts
	 */
	private async processScheduledHunts(): Promise<void> {
		if (!this.app) return;

		const now = new Date();

		// Get all enabled hunt configs
		const configs = await this.app.prisma.huntConfig.findMany({
			where: {
				OR: [{ huntMissingEnabled: true }, { huntUpgradesEnabled: true }],
			},
			include: {
				instance: true,
			},
		});

		for (const config of configs) {
			// Reset hourly API cap if needed
			if (config.apiCallsResetAt && config.apiCallsResetAt < now) {
				const newResetAt = new Date(now.getTime() + 60 * 60 * 1000);
				await this.app.prisma.huntConfig.update({
					where: { id: config.id },
					data: {
						apiCallsThisHour: 0,
						apiCallsResetAt: newResetAt,
					},
				});
				// Update in-memory object to avoid stale cap check
				config.apiCallsThisHour = 0;
				config.apiCallsResetAt = newResetAt;
			}

			// Check if we're over API cap
			if (config.apiCallsThisHour >= config.hourlyApiCap) {
				continue;
			}

			// Check queue threshold (simplified - actual implementation would check instance queue)
			// TODO: Implement queue check against actual instance

			// Check missing hunt schedule
			if (config.huntMissingEnabled) {
				const lastMissing = config.lastMissingHunt ?? new Date(0);
				const nextMissing = new Date(lastMissing.getTime() + config.missingIntervalMins * 60 * 1000);

				if (now >= nextMissing) {
					console.log(`[HuntingScheduler] Running scheduled missing hunt for ${config.instance.label}`);
					await this.runHunt(config.instanceId, "missing");
				}
			}

			// Check upgrade hunt schedule
			if (config.huntUpgradesEnabled) {
				const lastUpgrade = config.lastUpgradeHunt ?? new Date(0);
				const nextUpgrade = new Date(lastUpgrade.getTime() + config.upgradeIntervalMins * 60 * 1000);

				if (now >= nextUpgrade) {
					console.log(`[HuntingScheduler] Running scheduled upgrade hunt for ${config.instance.label}`);
					await this.runHunt(config.instanceId, "upgrade");
				}
			}
		}
	}

	/**
	 * Execute a hunt for an instance
	 */
	private async runHunt(instanceId: string, type: "missing" | "upgrade", isManual = false): Promise<void> {
		if (!this.app) return;

		// Enforce cooldown (additional check - manual hunts already checked in queueManualHunt)
		const cooldownCheck = this.checkCooldown(instanceId, type, isManual);
		if (!cooldownCheck.ok) {
			console.log(`[HuntingScheduler] Hunt skipped due to cooldown: ${cooldownCheck.message}`);
			return;
		}

		const startTime = Date.now();

		// Get config and instance
		const config = await this.app.prisma.huntConfig.findUnique({
			where: { instanceId },
			include: { instance: true },
		});

		if (!config) {
			console.error(`[HuntingScheduler] No config found for instance ${instanceId}`);
			return;
		}

		// Create log entry with "running" status
		const log = await this.app.prisma.huntLog.create({
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
			console.log(`[HuntingScheduler] Executing ${type} hunt for ${config.instance.label} (timeout: ${MAX_HUNT_DURATION_MS / 1000}s)`);

			// Execute the actual hunt using hunt-executor with timeout protection
			const result: HuntResult = await withTimeout(
				executeHunt(
					this.app,
					config.instance,
					config,
					type,
				),
				MAX_HUNT_DURATION_MS,
				`Hunt timed out after ${MAX_HUNT_DURATION_MS / 1000} seconds`,
			);

			// Update log with results
			const durationMs = Date.now() - startTime;
			await this.app.prisma.huntLog.update({
				where: { id: log.id },
				data: {
					itemsSearched: result.itemsSearched,
					itemsFound: result.itemsGrabbed,
					// searchedItems = items we triggered searches for
					searchedItems: result.searchedItems.length > 0 ? JSON.stringify(result.searchedItems) : null,
					// foundItems = items that were actually grabbed (reusing existing field)
					foundItems: result.grabbedItems.length > 0 ? JSON.stringify(result.grabbedItems) : null,
					status: result.status,
					message: result.message,
					durationMs,
					completedAt: new Date(),
				},
			});

			// Update config timestamps and API call count (only if we actually made API calls)
			if (result.status !== "skipped") {
				const updateData: Record<string, unknown> = {
					apiCallsThisHour: { increment: 1 },
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

			console.log(
				`[HuntingScheduler] Completed ${type} hunt for ${config.instance.label} in ${durationMs}ms: ${result.message}`,
			);
		} catch (error) {
			const durationMs = Date.now() - startTime;
			const message = error instanceof Error ? error.message : "Unknown error";

			await this.app.prisma.huntLog.update({
				where: { id: log.id },
				data: {
					status: "error",
					message,
					durationMs,
					completedAt: new Date(),
				},
			});

			console.error(`[HuntingScheduler] Hunt error for ${config.instance.label}:`, error);
		}
	}
}

// Singleton instance
let scheduler: HuntingScheduler | null = null;

/**
 * Get the hunting scheduler singleton
 */
export function getHuntingScheduler(): HuntingScheduler {
	if (!scheduler) {
		scheduler = new HuntingScheduler();
	}
	return scheduler;
}
