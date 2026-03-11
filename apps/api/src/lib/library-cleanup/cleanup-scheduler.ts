/**
 * Library Cleanup Scheduler
 *
 * Interval-based scheduler that checks if a cleanup run is due.
 * Follows the same pattern as BackupScheduler:
 * - Checks every minute
 * - In-flight guard prevents overlapping runs
 * - Calculates next run time after completion
 */

import type { FastifyBaseLogger } from "fastify";
import type { ArrClientFactory } from "../arr/client-factory.js";
import type { NotificationPayload } from "../notifications/types.js";
import type { PrismaClient } from "../prisma.js";
import { getErrorMessage } from "../utils/error-message.js";
import { executeCleanupRun } from "./cleanup-executor.js";

const CHECK_INTERVAL_MS = 60 * 1000; // Check every minute

export class CleanupScheduler {
	private intervalId: NodeJS.Timeout | null = null;
	private _isRunning = false;
	private notifyFn?: (payload: NotificationPayload) => Promise<void>;

	/** Whether a cleanup run is currently in progress */
	get isRunning(): boolean {
		return this._isRunning;
	}

	constructor(
		private prisma: PrismaClient,
		private arrClientFactory: ArrClientFactory,
		private logger: FastifyBaseLogger,
		notifyFn?: (payload: NotificationPayload) => Promise<void>,
	) {
		this.notifyFn = notifyFn;
	}

	/**
	 * Start the cleanup scheduler.
	 */
	start(): void {
		if (this.intervalId) {
			this.logger.warn("Cleanup scheduler already running");
			return;
		}

		this.logger.info("Starting library cleanup scheduler");

		// Check immediately on startup
		this.checkAndRun().catch((error) => {
			this.logger.error({ err: error }, "Failed to run initial cleanup check");
		});

		// Then check every minute
		this.intervalId = setInterval(() => {
			this.checkAndRun().catch((error) => {
				this.logger.error({ err: error }, "Failed to run scheduled cleanup check");
			});
		}, CHECK_INTERVAL_MS);
	}

	/**
	 * Stop the cleanup scheduler.
	 */
	stop(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
			this.logger.info("Cleanup scheduler stopped");
		}
	}

	/**
	 * Check if a cleanup run should execute and run it.
	 */
	private async checkAndRun(): Promise<void> {
		if (this._isRunning) {
			this.logger.debug("Cleanup already running, skipping check");
			return;
		}

		try {
			// Expire stale pending approvals
			await this.prisma.libraryCleanupApproval
				.updateMany({
					where: { status: "pending", expiresAt: { lt: new Date() } },
					data: { status: "expired" },
				})
				.catch((err) => {
					this.logger.warn({ err }, "Failed to expire stale approvals");
				});

			// Recover stuck "executing" items (crash recovery: >1 hour since approval)
			const stuckThreshold = new Date(Date.now() - 60 * 60 * 1000);
			await this.prisma.libraryCleanupApproval
				.updateMany({
					where: { status: "executing", reviewedAt: { lt: stuckThreshold } },
					data: { status: "expired" },
				})
				.then((result) => {
					if (result.count > 0) {
						this.logger.warn(
							{ recoveredCount: result.count },
							"Recovered stuck executing approval items — marked as expired",
						);
					}
				})
				.catch((err) => {
					this.logger.warn({ err }, "Failed to recover stuck executing approvals");
				});

			// Find any user's config that is enabled and due for a run.
			// (Single-admin app, so there's at most one config.)
			const config = await this.prisma.libraryCleanupConfig.findFirst({
				where: { enabled: true },
			});

			if (!config) return;

			const now = new Date();
			if (!config.nextRunAt || config.nextRunAt > now) return;

			this._isRunning = true;

			this.logger.info(
				{ intervalHours: config.intervalHours, dryRunMode: config.dryRunMode },
				"Running scheduled library cleanup",
			);

			try {
				const result = await executeCleanupRun(
					{ prisma: this.prisma, arrClientFactory: this.arrClientFactory, log: this.logger },
					config.userId,
				);

				// Calculate next run time
				const nextRunAt = new Date(now.getTime() + config.intervalHours * 60 * 60 * 1000);

				await this.prisma.libraryCleanupConfig.update({
					where: { id: config.id },
					data: { lastRunAt: now, nextRunAt },
				});

				this.logger.info(
					{
						itemsEvaluated: result.itemsEvaluated,
						itemsFlagged: result.itemsFlagged,
						itemsRemoved: result.itemsRemoved,
						nextRunAt: nextRunAt.toISOString(),
					},
					"Scheduled library cleanup completed",
				);

				if (result.itemsFlagged > 0 || result.itemsRemoved > 0 || result.itemsUnmonitored > 0) {
					const hasActions =
						result.itemsRemoved > 0 || result.itemsUnmonitored > 0 || result.itemsFilesDeleted > 0;

					if (hasActions) {
						const parts: string[] = [];
						if (result.itemsRemoved > 0) parts.push(`${result.itemsRemoved} removed`);
						if (result.itemsUnmonitored > 0) parts.push(`${result.itemsUnmonitored} unmonitored`);
						if (result.itemsFilesDeleted > 0)
							parts.push(`${result.itemsFilesDeleted} files deleted`);

						this.notifyFn?.({
							eventType: "CLEANUP_ITEMS_REMOVED",
							title: "Library cleanup completed",
							body: parts.join(", "),
							url: "/library",
							metadata: {
								itemsRemoved: result.itemsRemoved,
								itemsUnmonitored: result.itemsUnmonitored,
								itemsFilesDeleted: result.itemsFilesDeleted,
							},
						}).catch((err) => {
							this.logger.warn({ err }, "Failed to send cleanup notification");
						});
					} else {
						this.notifyFn?.({
							eventType: "CLEANUP_ITEMS_FLAGGED",
							title: "Library cleanup completed",
							body: `Flagged ${result.itemsFlagged} items for review`,
							url: "/library",
							metadata: {
								itemsFlagged: result.itemsFlagged,
							},
						}).catch((err) => {
							this.logger.warn({ err }, "Failed to send cleanup notification");
						});
					}
				}
			} finally {
				this._isRunning = false;
			}
		} catch (error) {
			this._isRunning = false;
			this.logger.error({ err: error }, "Error checking/running scheduled cleanup");

			this.notifyFn?.({
				eventType: "SYSTEM_ERROR",
				title: "Library cleanup failed",
				body: getErrorMessage(error),
				url: "/library",
			}).catch((err) => {
				this.logger.warn({ err }, "Failed to send cleanup error notification");
			});
		}
	}
}
