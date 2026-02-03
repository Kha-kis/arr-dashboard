import type { FastifyInstance } from "fastify";
import {
	executeQueueCleaner,
	executeEnhancedPreview,
	type CleanerResult,
	type EnhancedPreviewResult,
} from "./cleaner-executor.js";
import { MANUAL_CLEAN_COOLDOWN_MINS, MAX_CLEAN_DURATION_MS, SCHEDULER_TICK_MS } from "./constants.js";
import { loggers } from "../logger.js";

const log = loggers.scheduler;

/**
 * Error thrown when scheduler operations are attempted before initialization.
 */
export class SchedulerNotInitializedError extends Error {
	constructor(operation: string) {
		super(`Queue cleaner scheduler not initialized - cannot perform ${operation}`);
		this.name = "SchedulerNotInitializedError";
	}
}

/**
 * Run a promise with a timeout guard.
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
 * Queue Cleaner Scheduler
 *
 * Manages automated queue cleaner jobs for Sonarr/Radarr instances.
 * Mirrors the HuntingScheduler pattern with interval-based ticks.
 */
class QueueCleanerScheduler {
	private app: FastifyInstance | null = null;
	private running = false;
	private intervalId: NodeJS.Timeout | null = null;
	private lastCleanTimes: Map<string, Date> = new Map();
	// Track instances currently being cleaned to prevent race conditions
	private cleaningInProgress: Set<string> = new Set();
	// Health tracking
	private consecutiveTickFailures = 0;
	private lastTickError: string | null = null;
	private lastSuccessfulTick: Date | null = null;
	// Additional health tracking for silent failures
	private consecutiveDecayFailures = 0;
	private lastDecayError: string | null = null;
	private stuckLogsCleanupFailed = false;
	private orphanCleanAttempts: Array<{ instanceId: string; timestamp: Date }> = [];

	/**
	 * Initialize the scheduler with the app instance.
	 * Must be called before any cleans can run.
	 */
	initialize(app: FastifyInstance): void {
		this.app = app;

		// Clean up any stuck logs from previous runs
		this.cleanupStuckLogs().catch((error) => {
			log.error({ err: error }, "Failed to cleanup stuck queue cleaner logs on init");
		});
	}

	/**
	 * Clean up logs that were left in "running" state from previous app runs.
	 */
	private async cleanupStuckLogs(): Promise<void> {
		if (!this.app) {
			log.debug("cleanupStuckLogs called before app initialization - skipping");
			return;
		}

		try {
			const stuckLogs = await this.app.prisma.queueCleanerLog.findMany({
				where: { status: "running" },
			});

			if (stuckLogs.length > 0) {
				await this.app.prisma.queueCleanerLog.updateMany({
					where: { status: "running" },
					data: {
						status: "error",
						message: "Clean was interrupted (app restart or crash)",
						completedAt: new Date(),
					},
				});
			}
			this.stuckLogsCleanupFailed = false;
		} catch (error) {
			this.stuckLogsCleanupFailed = true;
			log.error(
				{ err: error },
				"Failed to cleanup stuck queue cleaner logs - Activity tab may show stale 'running' entries",
			);
		}
	}

	/**
	 * Start the scheduler (automatic/scheduled cleans).
	 */
	start(app: FastifyInstance): void {
		if (this.running) return;

		if (!this.app) {
			this.app = app;
		}

		this.running = true;

		this.intervalId = setInterval(() => {
			this.tick()
				.then(() => {
					// Success - reset failure tracking
					this.consecutiveTickFailures = 0;
					this.lastTickError = null;
					this.lastSuccessfulTick = new Date();
				})
				.catch((error) => {
					// Track failures for health monitoring
					this.consecutiveTickFailures++;
					this.lastTickError = error instanceof Error ? error.message : "Unknown error";
					log.error(
						{ err: error, consecutiveFailures: this.consecutiveTickFailures },
						"Queue cleaner scheduler tick failed",
					);
				});
		}, SCHEDULER_TICK_MS);
	}

	/**
	 * Stop the scheduler.
	 */
	stop(): void {
		if (!this.running) return;

		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}

		this.running = false;
	}

	/**
	 * Check if the scheduler is running.
	 */
	isRunning(): boolean {
		return this.running;
	}

	/**
	 * Get scheduler health status for monitoring.
	 * Returns running state plus health indicators like consecutive failures.
	 */
	getHealth(): {
		running: boolean;
		healthy: boolean;
		consecutiveFailures: number;
		lastError: string | null;
		lastSuccessfulTick: string | null;
		warnings: string[];
	} {
		const warnings: string[] = [];

		// Check for decay failures (Issue 2: could cause unexpected removals)
		if (this.consecutiveDecayFailures >= 3) {
			warnings.push(
				`Strike decay failing (${this.consecutiveDecayFailures} consecutive failures): ${this.lastDecayError ?? "Unknown error"}. Strikes may not decay properly.`,
			);
		}

		// Check for stuck logs cleanup failure (Issue 3: stale UI entries)
		if (this.stuckLogsCleanupFailed) {
			warnings.push("Stuck log cleanup failed on startup - Activity tab may show stale 'running' entries.");
		}

		// Check for orphan clean attempts (Issue 6: invisible skipped cleans)
		// Keep only recent orphans (last hour) to avoid memory growth
		const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
		this.orphanCleanAttempts = this.orphanCleanAttempts.filter((o) => o.timestamp > oneHourAgo);
		if (this.orphanCleanAttempts.length > 0) {
			warnings.push(
				`${this.orphanCleanAttempts.length} scheduled clean(s) skipped - config not found for instance(s): ${this.orphanCleanAttempts.map((o) => o.instanceId).join(", ")}`,
			);
		}

		return {
			running: this.running,
			healthy: this.consecutiveTickFailures < 3 && this.consecutiveDecayFailures < 3,
			consecutiveFailures: this.consecutiveTickFailures,
			lastError: this.lastTickError,
			lastSuccessfulTick: this.lastSuccessfulTick?.toISOString() ?? null,
			warnings,
		};
	}

	/**
	 * Trigger a manual clean for an instance (with cooldown check).
	 * Creates a log entry first, then runs asynchronously.
	 * Failures are recorded in the log entry for user visibility in the Activity tab.
	 */
	async triggerManualClean(
		instanceId: string,
	): Promise<{ triggered: boolean; message: string }> {
		// Check if clean is already in progress (prevents race condition)
		if (this.cleaningInProgress.has(instanceId)) {
			return { triggered: false, message: "Clean already in progress for this instance" };
		}

		const cooldownCheck = this.checkCooldown(instanceId);
		if (!cooldownCheck.ok) {
			return { triggered: false, message: cooldownCheck.message };
		}

		if (!this.app) {
			throw new SchedulerNotInitializedError("manual clean");
		}

		// Mark as in-progress BEFORE setting cooldown time (atomic-ish protection)
		this.cleaningInProgress.add(instanceId);
		this.lastCleanTimes.set(instanceId, new Date());

		// Run the clean asynchronously - runClean creates and manages its own log entry
		// Errors are captured in the log entry, making failures visible in Activity tab
		const logIdPromise = this.runClean(instanceId).finally(() => {
			// Always clear the in-progress flag when done
			this.cleaningInProgress.delete(instanceId);
		});

		// Don't await - we want to return immediately
		// But we do catch to prevent unhandled rejection AND create visible error entry
		logIdPromise.catch(async (error) => {
			const message = error instanceof Error ? error.message : "Unknown error";
			log.error({ err: error, instanceId }, "Manual queue clean failed before log entry creation");

			// Create an error log entry so the failure is visible in Activity tab
			// This handles cases where runClean fails before creating its own log entry
			try {
				if (this.app) {
					await this.app.prisma.queueCleanerLog.create({
						data: {
							instanceId,
							status: "error",
							message: `Clean failed to start: ${message}`,
							completedAt: new Date(),
							isDryRun: false,
						},
					});
				}
			} catch (logError) {
				log.error(
					{ err: logError, instanceId, originalError: message },
					"Failed to create error log entry for failed manual clean",
				);
			}
		});

		// Message indicates job is queued, not necessarily completed
		// Check Activity tab for results
		return { triggered: true, message: "Queue clean queued - check Activity tab for results" };
	}

	/**
	 * Run a dry-run synchronously and return results directly.
	 */
	async triggerDryRun(instanceId: string): Promise<CleanerResult> {
		if (!this.app) {
			throw new SchedulerNotInitializedError("dry run");
		}

		const config = await this.app.prisma.queueCleanerConfig.findUnique({
			where: { instanceId },
			include: { instance: true },
		});

		if (!config) {
			return {
				itemsCleaned: 0,
				itemsSkipped: 0,
				itemsWarned: 0,
				cleanedItems: [],
				skippedItems: [],
				warnedItems: [],
				isDryRun: true,
				status: "error",
				message: "No queue cleaner config found for this instance",
			};
		}

		// Force dry-run mode for this execution
		const dryRunConfig = { ...config, dryRunMode: true };

		return withTimeout(
			executeQueueCleaner(this.app, config.instance, dryRunConfig),
			MAX_CLEAN_DURATION_MS,
			`Dry run timed out after ${MAX_CLEAN_DURATION_MS / 1000} seconds`,
		);
	}

	/**
	 * Run an enhanced preview and return rich preview data for the UI.
	 */
	async triggerEnhancedPreview(instanceId: string): Promise<EnhancedPreviewResult> {
		if (!this.app) {
			throw new SchedulerNotInitializedError("enhanced preview");
		}

		const config = await this.app.prisma.queueCleanerConfig.findUnique({
			where: { instanceId },
			include: { instance: true },
		});

		if (!config) {
			return {
				instanceId,
				instanceLabel: "Unknown",
				instanceService: "sonarr",
				instanceReachable: false,
				errorMessage: "No queue cleaner configuration found for this instance",
				queueSummary: {
					totalItems: 0,
					downloading: 0,
					paused: 0,
					queued: 0,
					seeding: 0,
					importPending: 0,
					failed: 0,
				},
				wouldRemove: 0,
				wouldWarn: 0,
				wouldSkip: 0,
				previewItems: [],
				ruleSummary: {},
				previewGeneratedAt: new Date().toISOString(),
				configSnapshot: {
					dryRunMode: true,
					strikeSystemEnabled: false,
					maxStrikes: 3,
					maxRemovalsPerRun: 10,
				},
			};
		}

		return withTimeout(
			executeEnhancedPreview(this.app, config.instance, config),
			MAX_CLEAN_DURATION_MS,
			`Enhanced preview timed out after ${MAX_CLEAN_DURATION_MS / 1000} seconds`,
		);
	}

	/**
	 * Check cooldown for an instance.
	 */
	private checkCooldown(instanceId: string): { ok: boolean; message: string } {
		const lastClean = this.lastCleanTimes.get(instanceId);
		if (!lastClean) {
			return { ok: true, message: "No previous cleans recorded" };
		}

		const now = new Date();
		const minsSinceLastClean = (now.getTime() - lastClean.getTime()) / (60 * 1000);

		if (minsSinceLastClean < MANUAL_CLEAN_COOLDOWN_MINS) {
			const waitMins = Math.ceil(MANUAL_CLEAN_COOLDOWN_MINS - minsSinceLastClean);
			return {
				ok: false,
				message: `Cooldown: wait ${waitMins} minute(s) between cleans`,
			};
		}

		return { ok: true, message: "Cooldown satisfied" };
	}

	/**
	 * Main scheduler tick — runs every minute.
	 * Note: Errors are re-thrown so the outer handler in start() can track failures.
	 */
	private async tick(): Promise<void> {
		if (!this.app) return;

		try {
			// Run strike decay first
			await this.decayStrikes();

			// Then process scheduled cleans
			await this.processScheduledCleans();
		} catch (error) {
			log.error({ err: error }, "Queue cleaner tick error");
			// Re-throw so outer handler tracks failure for health monitoring
			throw error;
		}
	}

	/**
	 * Decay strikes that haven't been updated within the decay period.
	 * Tracks consecutive failures to surface in health status.
	 */
	private async decayStrikes(): Promise<void> {
		if (!this.app) return;

		try {
			// Get all configs with strike system enabled
			const configs = await this.app.prisma.queueCleanerConfig.findMany({
				where: { strikeSystemEnabled: true },
				select: { instanceId: true, strikeDecayHours: true },
			});

			for (const config of configs) {
				const decayCutoff = new Date(Date.now() - config.strikeDecayHours * 60 * 60 * 1000);

				// Delete strikes older than decay threshold
				const deleted = await this.app.prisma.queueCleanerStrike.deleteMany({
					where: {
						instanceId: config.instanceId,
						lastStrikeAt: { lt: decayCutoff },
					},
				});

				if (deleted.count > 0) {
					log.debug(
						{ instanceId: config.instanceId, deletedCount: deleted.count },
						"Decayed old strikes",
					);
				}
			}
			// Reset failure tracking on success
			this.consecutiveDecayFailures = 0;
			this.lastDecayError = null;
		} catch (error) {
			// Track consecutive failures for health monitoring
			this.consecutiveDecayFailures++;
			this.lastDecayError = error instanceof Error ? error.message : "Unknown error";
			log.error(
				{ err: error, consecutiveFailures: this.consecutiveDecayFailures },
				"Failed to decay strikes - strikes may accumulate unexpectedly",
			);
			// Don't throw - decay failure shouldn't stop the entire tick
			// But we track it for health status visibility
		}
	}

	/**
	 * Check for configs that are due to run and execute them.
	 * Each instance is processed independently - one failure doesn't stop others.
	 */
	private async processScheduledCleans(): Promise<void> {
		if (!this.app) return;

		const now = new Date();

		const configs = await this.app.prisma.queueCleanerConfig.findMany({
			where: { enabled: true },
			include: { instance: true },
		});

		for (const config of configs) {
			const lastRun = config.lastRunAt ?? new Date(0);
			const nextRun = new Date(lastRun.getTime() + config.intervalMins * 60 * 1000);

			if (now >= nextRun) {
				// Skip if a clean is already in progress for this instance
				// (prevents race condition with manual cleans)
				if (this.cleaningInProgress.has(config.instanceId)) {
					log.debug(
						{ instanceId: config.instanceId },
						"Skipping scheduled clean - already in progress",
					);
					continue;
				}

				// Mark as in-progress before starting
				this.cleaningInProgress.add(config.instanceId);

				try {
					await this.runClean(config.instanceId);
				} catch (error) {
					// Log but continue with remaining instances
					log.error(
						{ err: error, instanceId: config.instanceId },
						"Unexpected error during scheduled clean - continuing with remaining instances",
					);
				} finally {
					// Always clear the in-progress flag
					this.cleaningInProgress.delete(config.instanceId);
				}
			}
		}
	}

	/**
	 * Execute a clean for an instance.
	 */
	private async runClean(instanceId: string): Promise<void> {
		if (!this.app) return;

		const startTime = Date.now();

		const config = await this.app.prisma.queueCleanerConfig.findUnique({
			where: { instanceId },
			include: { instance: true },
		});

		if (!config) {
			log.error({ instanceId }, "No queue cleaner config found for instance - clean skipped");
			// Track orphan attempts so they're visible in health status
			this.orphanCleanAttempts.push({ instanceId, timestamp: new Date() });
			return;
		}

		// Create log entry
		const logEntry = await this.app.prisma.queueCleanerLog.create({
			data: {
				instanceId,
				status: "running",
				isDryRun: config.dryRunMode,
			},
		});

		try {
			const result = await withTimeout(
				executeQueueCleaner(this.app, config.instance, config),
				MAX_CLEAN_DURATION_MS,
				`Queue clean timed out after ${MAX_CLEAN_DURATION_MS / 1000} seconds`,
			);

			const durationMs = Date.now() - startTime;
			const completedAt = new Date();

			// Update log and config state in a transaction for consistency
			await this.app.prisma.$transaction(async (tx) => {
				// Update log with results
				await tx.queueCleanerLog.update({
					where: { id: logEntry.id },
					data: {
						itemsCleaned: result.itemsCleaned,
						itemsSkipped: result.itemsSkipped,
						itemsWarned: result.itemsWarned,
						isDryRun: result.isDryRun,
						cleanedItems: result.cleanedItems.length > 0 ? JSON.stringify(result.cleanedItems) : null,
						skippedItems: result.skippedItems.length > 0 ? JSON.stringify(result.skippedItems) : null,
						warnedItems: result.warnedItems.length > 0 ? JSON.stringify(result.warnedItems) : null,
						status: result.status,
						message: result.message,
						durationMs,
						completedAt,
					},
				});

				// Update config state
				await tx.queueCleanerConfig.update({
					where: { instanceId },
					data: {
						lastRunAt: completedAt,
						lastRunItemsCleaned: result.itemsCleaned,
						lastRunItemsSkipped: result.itemsSkipped,
					},
				});
			});
		} catch (error) {
			const durationMs = Date.now() - startTime;
			const message = error instanceof Error ? error.message : "Unknown error";

			await this.app.prisma.queueCleanerLog.update({
				where: { id: logEntry.id },
				data: {
					status: "error",
					message,
					durationMs,
					completedAt: new Date(),
				},
			});

			log.error(
				{ err: error, instanceLabel: config.instance.label },
				"Queue cleaner error",
			);
		}
	}
}

// Singleton instance
let scheduler: QueueCleanerScheduler | null = null;

/**
 * Retrieve the singleton QueueCleanerScheduler instance.
 */
export function getQueueCleanerScheduler(): QueueCleanerScheduler {
	if (!scheduler) {
		scheduler = new QueueCleanerScheduler();
	}
	return scheduler;
}
