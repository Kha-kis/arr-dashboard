import type { FastifyInstance } from "fastify";
import { executeHunt, type HuntResult } from "./hunt-executor.js";

/**
 * Hunting Scheduler
 *
 * Manages automated hunt jobs for missing content and quality upgrades.
 * Uses a simple interval-based approach that can be replaced with node-cron later.
 */

interface QueuedHunt {
	instanceId: string;
	type: "missing" | "upgrade";
	queuedAt: Date;
}

class HuntingScheduler {
	private app: FastifyInstance | null = null;
	private running = false;
	private intervalId: NodeJS.Timeout | null = null;
	private manualQueue: QueuedHunt[] = [];

	/**
	 * Start the hunting scheduler
	 */
	start(app: FastifyInstance): void {
		if (this.running) {
			console.log("[HuntingScheduler] Already running");
			return;
		}

		this.app = app;
		this.running = true;

		// Check every minute for hunts that need to run
		this.intervalId = setInterval(() => {
			void this.tick();
		}, 60 * 1000);

		console.log("[HuntingScheduler] Started");
	}

	/**
	 * Stop the hunting scheduler
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
		this.app = null;
		console.log("[HuntingScheduler] Stopped");
	}

	/**
	 * Check if scheduler is running
	 */
	isRunning(): boolean {
		return this.running;
	}

	/**
	 * Queue a manual hunt
	 */
	queueManualHunt(instanceId: string, type: "missing" | "upgrade"): void {
		this.manualQueue.push({
			instanceId,
			type,
			queuedAt: new Date(),
		});
		console.log(`[HuntingScheduler] Queued manual ${type} hunt for ${instanceId}`);
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
		await this.runHunt(hunt.instanceId, hunt.type);
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
				await this.app.prisma.huntConfig.update({
					where: { id: config.id },
					data: {
						apiCallsThisHour: 0,
						apiCallsResetAt: new Date(now.getTime() + 60 * 60 * 1000),
					},
				});
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
	private async runHunt(instanceId: string, type: "missing" | "upgrade"): Promise<void> {
		if (!this.app) return;

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

		// Get exclusions for this instance's config
		const exclusions = await this.app.prisma.huntExclusion.findMany({
			where: { configId: config.id },
		});

		// Create log entry
		const log = await this.app.prisma.huntLog.create({
			data: {
				instanceId,
				huntType: type,
				status: "completed",
				itemsSearched: 0,
				itemsFound: 0,
			},
		});

		try {
			console.log(`[HuntingScheduler] Executing ${type} hunt for ${config.instance.label}`);

			// Execute the actual hunt using hunt-executor
			const result: HuntResult = await executeHunt(
				this.app,
				config.instance,
				config,
				type,
				exclusions,
			);

			// Update log with results
			const durationMs = Date.now() - startTime;
			await this.app.prisma.huntLog.update({
				where: { id: log.id },
				data: {
					itemsSearched: result.itemsSearched,
					itemsFound: result.itemsFound,
					foundItems: result.foundItems.length > 0 ? JSON.stringify(result.foundItems) : null,
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
