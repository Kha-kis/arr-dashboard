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
import type { Encryptor } from "../auth/encryption.js";
import type { NotificationPayload } from "../notifications/types.js";
import type { PrismaClient } from "../prisma.js";
import {
	passthroughTickWrapper,
	type TickWrapper,
} from "../scheduler-registry/scheduler-registry.js";
import { getErrorMessage } from "../utils/error-message.js";
import {
	CLEANUP_RUN_LEASE_MS,
	CleanupRunAlreadyInProgressError,
	executeCleanupRun,
	INTERRUPTED_CLEANUP_RECOVERY_MESSAGE,
} from "./cleanup-executor.js";
import type { CleanupRunResult } from "./types.js";

const CHECK_INTERVAL_MS = 60 * 1000; // Check every minute

export function buildCleanupNotification(
	result: CleanupRunResult,
): NotificationPayload | undefined {
	const hasActions =
		result.itemsRemoved > 0 || result.itemsUnmonitored > 0 || result.itemsFilesDeleted > 0;
	if (!hasActions && result.itemsFlagged === 0 && result.itemsSkipped === 0) return undefined;

	if (hasActions) {
		const needsReview = result.status === "partial" || result.itemsSkipped > 0;
		const parts: string[] = [];
		if (result.itemsRemoved > 0) parts.push(`${result.itemsRemoved} removed`);
		if (result.itemsUnmonitored > 0) parts.push(`${result.itemsUnmonitored} unmonitored`);
		if (result.itemsFilesDeleted > 0) parts.push(`${result.itemsFilesDeleted} files deleted`);
		if (result.itemsSkipped > 0) parts.push(`${result.itemsSkipped} skipped`);
		return {
			eventType: "CLEANUP_ITEMS_REMOVED",
			title: needsReview ? "Library cleanup needs review" : "Library cleanup completed",
			body: parts.join(", "),
			url: "/library-cleanup",
			metadata: {
				itemsRemoved: result.itemsRemoved,
				itemsUnmonitored: result.itemsUnmonitored,
				itemsFilesDeleted: result.itemsFilesDeleted,
				itemsSkipped: result.itemsSkipped,
			},
		};
	}

	const queued = result.details.filter((detail) => detail.action === "queued_for_approval").length;
	const dryRunMatches = result.details.filter((detail) => detail.action !== "skipped").length;
	const parts: string[] = [];
	if (queued > 0) parts.push(`${queued} queued for review`);
	else if (result.isDryRun && dryRunMatches > 0)
		parts.push(`${dryRunMatches} actionable matches in dry run`);
	else if (result.itemsFlagged > 0 && result.itemsSkipped === 0)
		parts.push(`${result.itemsFlagged} matched`);
	if (result.itemsSkipped > 0) parts.push(`${result.itemsSkipped} safety-blocked or skipped`);

	return {
		eventType: "CLEANUP_ITEMS_FLAGGED",
		title:
			result.status === "partial" || result.itemsSkipped > 0
				? "Library cleanup needs review"
				: "Library cleanup completed",
		body: parts.join(", "),
		url: "/library-cleanup",
		metadata: {
			itemsFlagged: result.itemsFlagged,
			itemsSkipped: result.itemsSkipped,
		},
	};
}

export class CleanupScheduler {
	private intervalId: NodeJS.Timeout | null = null;
	private _isRunning = false;
	private notifyFn?: (payload: NotificationPayload) => Promise<void>;
	private trackTick: TickWrapper;

	/** Whether a cleanup run is currently in progress */
	get isRunning(): boolean {
		return this._isRunning;
	}

	constructor(
		private prisma: PrismaClient,
		private arrClientFactory: ArrClientFactory,
		private encryptor: Encryptor,
		private logger: FastifyBaseLogger,
		notifyFn?: (payload: NotificationPayload) => Promise<void>,
		options?: { trackTick?: TickWrapper },
	) {
		this.notifyFn = notifyFn;
		this.trackTick = options?.trackTick ?? passthroughTickWrapper;
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
		this.trackTick(() => this.checkAndRun()).catch((error) => {
			this.logger.error({ err: error }, "Failed to run initial cleanup check");
		});

		// Then check every minute
		this.intervalId = setInterval(() => {
			this.trackTick(() => this.checkAndRun()).catch((error) => {
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

			// Recover stuck "executing" items (crash recovery: >1 hour since approval).
			// The persisted safety snapshot is reconciled against the live file
			// remainder when the operator approves it again.
			const stuckThreshold = new Date(Date.now() - 60 * 60 * 1000);
			const staleRunLeaseThreshold = new Date(Date.now() - CLEANUP_RUN_LEASE_MS);
			await this.prisma.libraryCleanupApproval
				.updateMany({
					where: {
						status: "approved",
						reviewedAt: { lt: stuckThreshold },
						config: {
							OR: [
								{ runClaimToken: null },
								{ runClaimedAt: null },
								{ runClaimedAt: { lt: staleRunLeaseThreshold } },
							],
						},
					},
					data: {
						status: "pending",
						executionToken: null,
						lastExecutionError:
							"Recovered an interrupted approval request. Review and approve again.",
					},
				})
				.then((result) => {
					if (result.count > 0) {
						this.logger.warn(
							{ recoveredCount: result.count },
							"Recovered stuck approved cleanup items — returned them to pending review",
						);
					}
				})
				.catch((err) => {
					this.logger.warn({ err }, "Failed to recover stuck approved cleanup items");
				});
			await this.prisma.libraryCleanupApproval
				.updateMany({
					where: {
						status: "executing",
						reviewedAt: { lt: stuckThreshold },
						config: {
							OR: [
								{ runClaimToken: null },
								{ runClaimedAt: null },
								{ runClaimedAt: { lt: staleRunLeaseThreshold } },
							],
						},
					},
					data: {
						status: "pending",
						executionToken: null,
						lastExecutionError: INTERRUPTED_CLEANUP_RECOVERY_MESSAGE,
					},
				})
				.then((result) => {
					if (result.count > 0) {
						this.logger.warn(
							{ recoveredCount: result.count },
							"Recovered stuck executing approval items — returned them to pending review",
						);
					}
				})
				.catch((err) => {
					this.logger.warn({ err }, "Failed to recover stuck executing approvals");
				});
			await this.prisma.libraryCleanupApproval
				.updateMany({
					where: {
						status: "retry_executing",
						reviewedAt: { lt: stuckThreshold },
						config: {
							OR: [
								{ runClaimToken: null },
								{ runClaimedAt: null },
								{ runClaimedAt: { lt: staleRunLeaseThreshold } },
							],
						},
					},
					data: { status: "retry_pending", executionToken: null },
				})
				.then((result) => {
					if (result.count > 0) {
						this.logger.warn(
							{ recoveredCount: result.count },
							"Recovered stuck record-only cleanup retries — returned them to retry pending",
						);
					}
				})
				.catch((err) => {
					this.logger.warn({ err }, "Failed to recover stuck record-only cleanup retries");
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
					{
						prisma: this.prisma,
						arrClientFactory: this.arrClientFactory,
						encryptor: this.encryptor,
						log: this.logger,
					},
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

				const notification = buildCleanupNotification(result);
				if (notification) {
					this.notifyFn?.(notification).catch((err) => {
						this.logger.warn({ err }, "Failed to send cleanup notification");
					});
				}
			} finally {
				this._isRunning = false;
			}
		} catch (error) {
			this._isRunning = false;
			if (error instanceof CleanupRunAlreadyInProgressError) {
				this.logger.debug("Another app process owns the library-cleanup run lease");
				return;
			}
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
