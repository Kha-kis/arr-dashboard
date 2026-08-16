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
import type { LibraryCleanupApproval, PrismaClient } from "../prisma.js";
import {
	passthroughTickWrapper,
	type TickWrapper,
} from "../scheduler-registry/scheduler-registry.js";
import { getErrorMessage } from "../utils/error-message.js";
import {
	appendCleanupAuditEvent,
	appendCleanupTerminalAuditEvent,
	createCleanupAuditEventKey,
	createCleanupTerminalAuditState,
	type AppendCleanupAuditEventInput,
	type CleanupTerminalAuditStatus,
} from "./cleanup-audit.js";
import {
	CLEANUP_RUN_LEASE_MS,
	CleanupRunAlreadyInProgressError,
	executeCleanupRun,
	INTERRUPTED_CLEANUP_RECOVERY_MESSAGE,
	SONARR_EPISODE_UNMONITOR_CONFIRMED_RECOVERY_MESSAGE,
	SONARR_EPISODE_UNMONITOR_PARTIAL_MESSAGE,
	SONARR_EPISODE_UNMONITOR_STARTED_RECOVERY_MESSAGE,
} from "./cleanup-executor.js";
import {
	CleanupMaintenanceConflictError,
	withCleanupOperationGuard,
} from "./cleanup-maintenance-gate.js";
import { retryAllPendingMediaServerRescans } from "./media-server-rescan.js";
import type { CleanupExecutorDeps, CleanupRunResult } from "./types.js";

const CHECK_INTERVAL_MS = 60 * 1000; // Check every minute
const TERMINAL_AUDIT_REPAIR_LIMIT = 100;
const TRANSITION_AUDIT_BATCH_LIMIT = 100;

type SchedulerAuditApproval = Pick<
	LibraryCleanupApproval,
	| "action"
	| "arrEpisodeId"
	| "arrItemId"
	| "configId"
	| "executionAuditCorrelationId"
	| "episodeNumber"
	| "episodeTitle"
	| "expiresAt"
	| "id"
	| "instanceId"
	| "itemType"
	| "matchedRuleId"
	| "matchedRuleName"
	| "reason"
	| "reconciledWithoutMutation"
	| "reviewedAt"
	| "seasonNumber"
	| "status"
	| "targetScope"
	| "terminalAuditActorId"
	| "terminalAuditActorType"
	| "terminalAuditCorrelationId"
	| "terminalAuditEventType"
	| "terminalAuditOutcome"
	| "terminalAuditRecordedAt"
	| "terminalAuditReason"
	| "terminalAuditTrigger"
	| "title"
> & { config: { userId: string } };

function schedulerAuditTitle(approval: SchedulerAuditApproval): string {
	return approval.targetScope === "episode" &&
		typeof approval.seasonNumber === "number" &&
		typeof approval.episodeNumber === "number"
		? `${approval.title} S${String(approval.seasonNumber).padStart(2, "0")}E${String(approval.episodeNumber).padStart(2, "0")}${approval.episodeTitle ? ` · ${approval.episodeTitle}` : ""}`
		: approval.title;
}

function schedulerAuditTarget(approval: SchedulerAuditApproval) {
	const itemType =
		approval.itemType === "movie" || approval.itemType === "series" ? approval.itemType : undefined;
	return {
		kind: "approval",
		id: approval.id,
		instanceId: approval.instanceId,
		...(itemType ? { itemType } : {}),
		arrItemId: approval.arrItemId,
		...(approval.targetScope === "episode" && approval.arrEpisodeId !== null
			? { arrEpisodeId: approval.arrEpisodeId }
			: {}),
		targetScope: approval.targetScope === "episode" ? ("episode" as const) : ("series" as const),
	};
}

function schedulerAuditSummary(approval: SchedulerAuditApproval, reason: string) {
	const action: "delete" | "delete_files" | "unmonitor" =
		approval.action === "unmonitor" || approval.action === "delete_files"
			? approval.action
			: "delete";
	return {
		action,
		title: schedulerAuditTitle(approval),
		ruleId: approval.matchedRuleId,
		ruleName: approval.matchedRuleName,
		reason,
	};
}

function buildSchedulerTransitionAuditInput(
	approval: SchedulerAuditApproval,
	input: {
		eventType: "expired" | "recovered";
		fromStatus: string;
		toStatus: string;
		reason: string;
	},
): AppendCleanupAuditEventInput {
	const transitionAt =
		input.eventType === "expired"
			? approval.expiresAt.toISOString()
			: (approval.reviewedAt?.toISOString() ?? "unreviewed");
	const correlationId = `scheduler:${approval.id}:${input.eventType}:${transitionAt}`;
	return {
		userId: approval.config.userId,
		configId: approval.configId,
		eventKey: createCleanupAuditEventKey({
			actionId: approval.id,
			correlationId,
			eventType: input.eventType,
		}),
		actionId: approval.id,
		correlationId,
		actorType: "scheduler",
		eventType: input.eventType,
		trigger: input.eventType === "expired" ? "scheduled" : "recovery",
		target: schedulerAuditTarget(approval),
		summary: schedulerAuditSummary(approval, input.reason),
		outcome: input.eventType === "expired" ? "blocked" : "info",
		evidence: {
			stateTransitionPersisted: true,
			fromStatus: input.fromStatus,
			toStatus: input.toStatus,
		},
	};
}

function buildSchedulerRecoveryExpiredAuditInput(
	approval: SchedulerAuditApproval,
	fromStatus: string,
	reason: string,
	recoveryAt: Date,
): AppendCleanupAuditEventInput {
	const eventType = "expired" as const;
	const correlationId = `recovery:${approval.id}:episode-phase:${fromStatus}:${recoveryAt.getTime()}`;
	return {
		userId: approval.config.userId,
		configId: approval.configId,
		eventKey: createCleanupAuditEventKey({ actionId: approval.id, correlationId, eventType }),
		actionId: approval.id,
		correlationId,
		actorType: "scheduler",
		eventType,
		trigger: "recovery",
		target: schedulerAuditTarget(approval),
		summary: schedulerAuditSummary(approval, reason),
		outcome: "blocked",
		evidence: {
			stateTransitionPersisted: true,
			fromStatus,
			toStatus: "expired",
			mutationOutcome: "unknown",
		},
	};
}

function episodeRecoverySourceStatus(
	correlationId: string,
): "executing" | "retry_executing" | null {
	const marker = ":episode-phase:";
	const markerIndex = correlationId.lastIndexOf(marker);
	if (!correlationId.startsWith("recovery:") || markerIndex < 0) return null;
	const [fromStatus, timestamp, ...remainder] = correlationId
		.slice(markerIndex + marker.length)
		.split(":");
	if (
		remainder.length > 0 ||
		(fromStatus !== "executing" && fromStatus !== "retry_executing") ||
		!timestamp ||
		!/^[0-9]+$/.test(timestamp)
	) {
		return null;
	}
	return fromStatus;
}

function buildPersistedTerminalAuditInput(
	approval: SchedulerAuditApproval,
): AppendCleanupAuditEventInput | null {
	const correlationId = approval.terminalAuditCorrelationId;
	const eventType =
		approval.terminalAuditEventType === "succeeded" ||
		approval.terminalAuditEventType === "failed" ||
		approval.terminalAuditEventType === "expired" ||
		approval.terminalAuditEventType === "approval_reviewed"
			? approval.terminalAuditEventType
			: null;
	const actorType =
		approval.terminalAuditActorType === "operator" ||
		approval.terminalAuditActorType === "scheduler" ||
		approval.terminalAuditActorType === "system"
			? approval.terminalAuditActorType
			: null;
	const trigger =
		approval.terminalAuditTrigger === "scheduled" ||
		approval.terminalAuditTrigger === "manual" ||
		approval.terminalAuditTrigger === "approval" ||
		approval.terminalAuditTrigger === "retry" ||
		approval.terminalAuditTrigger === "recovery"
			? approval.terminalAuditTrigger
			: null;
	const outcome =
		approval.terminalAuditOutcome === "success" ||
		approval.terminalAuditOutcome === "blocked" ||
		approval.terminalAuditOutcome === "failed"
			? approval.terminalAuditOutcome
			: null;
	const reason = approval.terminalAuditReason;
	if (!correlationId || !eventType || !actorType || !trigger || !outcome || !reason) return null;

	let evidence: AppendCleanupAuditEventInput["evidence"];
	if (eventType === "approval_reviewed") {
		evidence = { decision: "rejected" };
	} else if (eventType === "expired") {
		const recoverySourceStatus =
			trigger === "recovery" ? episodeRecoverySourceStatus(correlationId) : null;
		evidence = recoverySourceStatus
			? {
					stateTransitionPersisted: true,
					fromStatus: recoverySourceStatus,
					toStatus: "expired",
					mutationOutcome: "unknown",
				}
			: { stateTransitionPersisted: true, fromStatus: "pending", toStatus: "expired" };
	} else {
		evidence = {
			authoritativeTerminalStatePersisted: true,
			reconciledWithoutMutation: approval.reconciledWithoutMutation,
		};
	}
	return {
		userId: approval.config.userId,
		configId: approval.configId,
		eventKey: createCleanupAuditEventKey({ actionId: approval.id, correlationId, eventType }),
		actionId: approval.id,
		correlationId,
		actorType,
		...(approval.terminalAuditActorId ? { actorId: approval.terminalAuditActorId } : {}),
		eventType,
		trigger,
		target: schedulerAuditTarget(approval),
		summary: schedulerAuditSummary(approval, reason),
		outcome,
		evidence,
	};
}

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
	private dryRunSchedule: {
		configId: string;
		configuredNextRunAtMs: number;
		configUpdatedAtMs: number | null;
		intervalHours: number;
		nextRunAtMs: number;
	} | null = null;
	private notifyFn?: (payload: NotificationPayload) => Promise<void>;
	private trackTick: TickWrapper;
	private quiClientFactory?: CleanupExecutorDeps["quiClientFactory"];
	private quiFileHashIndexFactory?: CleanupExecutorDeps["quiFileHashIndexFactory"];
	private externalRuleCacheRefresher?: CleanupExecutorDeps["externalRuleCacheRefresher"];

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
		options?: {
			trackTick?: TickWrapper;
			quiClientFactory?: CleanupExecutorDeps["quiClientFactory"];
			quiFileHashIndexFactory?: CleanupExecutorDeps["quiFileHashIndexFactory"];
			externalRuleCacheRefresher?: CleanupExecutorDeps["externalRuleCacheRefresher"];
		},
	) {
		this.notifyFn = notifyFn;
		this.trackTick = options?.trackTick ?? passthroughTickWrapper;
		this.quiClientFactory = options?.quiClientFactory;
		this.quiFileHashIndexFactory = options?.quiFileHashIndexFactory;
		this.externalRuleCacheRefresher = options?.externalRuleCacheRefresher;
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

	private async sendNotification(
		payload: NotificationPayload,
		failureMessage: string,
	): Promise<void> {
		if (!this.notifyFn) return;
		try {
			await withCleanupOperationGuard(() => this.notifyFn!(payload));
		} catch (error) {
			if (error instanceof CleanupMaintenanceConflictError) {
				this.logger.debug("Database maintenance skipped a library-cleanup notification");
				return;
			}
			this.logger.warn({ err: error }, failureMessage);
		}
	}

	private async repairMissingTerminalAuditEvents(): Promise<void> {
		const approvals = await this.prisma.libraryCleanupApproval.findMany({
			where: {
				status: { in: ["executed", "expired", "rejected"] },
				terminalAuditRecordedAt: null,
				terminalAuditCorrelationId: { not: null },
			},
			take: TERMINAL_AUDIT_REPAIR_LIMIT,
			orderBy: { id: "asc" },
			include: { config: { select: { userId: true } } },
		});

		for (const approval of approvals) {
			const event = buildPersistedTerminalAuditInput(approval);
			const status =
				approval.status === "executed" ||
				approval.status === "expired" ||
				approval.status === "rejected"
					? (approval.status as CleanupTerminalAuditStatus)
					: null;
			if (!event || !status) {
				this.logger.warn(
					{ approvalId: approval.id },
					"Skipped malformed cleanup terminal audit repair envelope",
				);
				continue;
			}
			try {
				await appendCleanupTerminalAuditEvent(this.prisma, event, {
					approvalId: approval.id,
					status,
				});
			} catch (error) {
				this.logger.warn(
					{ err: error, approvalId: approval.id },
					"Failed to repair missing cleanup terminal audit event",
				);
			}
		}
	}

	private async recoverStaleApprovals(
		fromStatus: "approved" | "executing" | "retry_executing",
		toStatus: "pending" | "retry_pending",
		lastExecutionError: string | undefined,
		stuckThreshold: Date,
		staleRunLeaseThreshold: Date,
		logMessage: string,
		excludedLastExecutionErrors: string[] = [],
	): Promise<void> {
		const leaseIsRecoverable = {
			OR: [
				{ runClaimToken: null },
				{ runClaimedAt: null },
				{ runClaimedAt: { lt: staleRunLeaseThreshold } },
			],
		};
		const lastExecutionErrorFilter =
			excludedLastExecutionErrors.length > 0
				? {
						OR: [
							{ lastExecutionError: null },
							{ lastExecutionError: { notIn: excludedLastExecutionErrors } },
						],
					}
				: {};
		const approvals = await this.prisma.libraryCleanupApproval.findMany({
			where: {
				status: fromStatus,
				reviewedAt: { lt: stuckThreshold },
				config: leaseIsRecoverable,
				...lastExecutionErrorFilter,
			},
			include: { config: { select: { userId: true } } },
			orderBy: { id: "asc" },
			take: TRANSITION_AUDIT_BATCH_LIMIT,
		});
		let recoveredCount = 0;
		for (const approval of approvals) {
			const transitionReason =
				lastExecutionError ??
				(fromStatus === "retry_executing"
					? "Recovered an interrupted record-only cleanup retry."
					: "Recovered an interrupted cleanup execution for another review.");
			const auditInput = buildSchedulerTransitionAuditInput(approval, {
				eventType: "recovered",
				fromStatus,
				toStatus,
				reason: transitionReason,
			});
			try {
				const changed = await this.prisma.$transaction(async (tx) => {
					const result = await tx.libraryCleanupApproval.updateMany({
						where: {
							id: approval.id,
							config: { userId: approval.config.userId, ...leaseIsRecoverable },
							status: fromStatus,
							reviewedAt: { lt: stuckThreshold },
							...lastExecutionErrorFilter,
						},
						data: {
							status: toStatus,
							executionToken: null,
							...(lastExecutionError ? { lastExecutionError } : {}),
						},
					});
					if (result.count !== 1) return false;
					await appendCleanupAuditEvent(tx, auditInput);
					return true;
				});
				if (changed) recoveredCount++;
			} catch (error) {
				this.logger.warn(
					{ err: error, approvalId: approval.id, fromStatus, toStatus },
					"Failed to atomically recover and audit a stale cleanup approval",
				);
			}
		}
		if (recoveredCount > 0) this.logger.warn({ recoveredCount }, logMessage);
	}

	private async recoverInterruptedSonarrEpisodePhases(
		stuckThreshold: Date,
		staleRunLeaseThreshold: Date,
	): Promise<void> {
		const leaseIsRecoverable = {
			OR: [
				{ runClaimToken: null },
				{ runClaimedAt: null },
				{ runClaimedAt: { lt: staleRunLeaseThreshold } },
			],
		};
		const transitions = [
			{
				fromStatus: "executing",
				toStatus: "expired",
				reason: SONARR_EPISODE_UNMONITOR_STARTED_RECOVERY_MESSAGE,
			},
			{
				fromStatus: "retry_executing",
				toStatus: "expired",
				reason: SONARR_EPISODE_UNMONITOR_STARTED_RECOVERY_MESSAGE,
			},
			{
				fromStatus: "executing",
				toStatus: "retry_pending",
				reason: SONARR_EPISODE_UNMONITOR_CONFIRMED_RECOVERY_MESSAGE,
			},
			{
				fromStatus: "retry_executing",
				toStatus: "retry_pending",
				reason: SONARR_EPISODE_UNMONITOR_CONFIRMED_RECOVERY_MESSAGE,
			},
			{
				fromStatus: "executing",
				toStatus: "retry_pending",
				reason: SONARR_EPISODE_UNMONITOR_PARTIAL_MESSAGE,
			},
			{
				fromStatus: "retry_executing",
				toStatus: "retry_pending",
				reason: SONARR_EPISODE_UNMONITOR_PARTIAL_MESSAGE,
			},
		] as const;

		for (const transition of transitions) {
			const approvals = await this.prisma.libraryCleanupApproval.findMany({
				where: {
					status: transition.fromStatus,
					lastExecutionError: transition.reason,
					reviewedAt: { lt: stuckThreshold },
					config: leaseIsRecoverable,
				},
				include: { config: { select: { userId: true } } },
				orderBy: { id: "asc" },
				take: TRANSITION_AUDIT_BATCH_LIMIT,
			});
			let recoveredCount = 0;
			for (const approval of approvals) {
				const recoveryAt = new Date();
				const terminalRecovery = transition.toStatus === "expired";
				const auditInput = terminalRecovery
					? buildSchedulerRecoveryExpiredAuditInput(
							approval,
							transition.fromStatus,
							transition.reason,
							recoveryAt,
						)
					: buildSchedulerTransitionAuditInput(approval, {
							eventType: "recovered",
							fromStatus: transition.fromStatus,
							toStatus: transition.toStatus,
							reason: transition.reason,
						});
				try {
					let changed = false;
					if (terminalRecovery) {
						const result = await this.prisma.libraryCleanupApproval.updateMany({
							where: {
								id: approval.id,
								config: { userId: approval.config.userId, ...leaseIsRecoverable },
								status: transition.fromStatus,
								lastExecutionError: transition.reason,
								reviewedAt: { lt: stuckThreshold },
							},
							data: {
								status: transition.toStatus,
								executionToken: null,
								reviewedAt: recoveryAt,
								...createCleanupTerminalAuditState(auditInput),
							},
						});
						changed = result.count === 1;
						if (changed) {
							await appendCleanupTerminalAuditEvent(this.prisma, auditInput, {
								approvalId: approval.id,
								status: "expired",
							}).catch((error) => {
								this.logger.warn(
									{ err: error, approvalId: approval.id },
									"Failed to append Sonarr episode recovery terminal audit; its envelope remains repairable",
								);
							});
						}
					} else {
						changed = await this.prisma.$transaction(async (tx) => {
							const result = await tx.libraryCleanupApproval.updateMany({
								where: {
									id: approval.id,
									config: { userId: approval.config.userId, ...leaseIsRecoverable },
									status: transition.fromStatus,
									lastExecutionError: transition.reason,
									reviewedAt: { lt: stuckThreshold },
								},
								data: {
									status: transition.toStatus,
									executionToken: null,
									reviewedAt: recoveryAt,
								},
							});
							if (result.count !== 1) return false;
							await appendCleanupAuditEvent(tx, auditInput);
							return true;
						});
					}
					if (changed) recoveredCount++;
				} catch (error) {
					this.logger.warn(
						{ err: error, approvalId: approval.id, phase: transition.reason },
						"Failed to recover an interrupted Sonarr episode cleanup phase",
					);
				}
			}
			if (recoveredCount > 0) {
				this.logger.warn(
					{ recoveredCount, phase: transition.reason },
					"Recovered interrupted Sonarr episode cleanup phase",
				);
			}
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

		let isScheduledDryRun = false;
		try {
			await withCleanupOperationGuard(async () => {
				// Load the active mode before lifecycle maintenance. A configured dry run
				// is fully read-only, including stale-approval recovery and audit repair.
				const config = await this.prisma.libraryCleanupConfig.findFirst({
					where: { enabled: true },
				});

				if (!config?.dryRunMode) {
					await this.repairMissingTerminalAuditEvents().catch((err) => {
						this.logger.warn({ err }, "Failed to load cleanup terminal audit repairs");
					});
					await retryAllPendingMediaServerRescans({
						prisma: this.prisma,
						encryptor: this.encryptor,
						log: this.logger,
					}).catch((err) => {
						this.logger.warn(
							{ err },
							"Failed to retry durable media-server scans; cleanup deletion will not be repeated",
						);
					});

					// Expire stale pending approvals. The status CAS remains authoritative;
					// the audit is appended only for rows that this scheduler actually changed.
					const expiryNow = new Date();
					const expiredCandidates = await this.prisma.libraryCleanupApproval.findMany({
						where: { status: "pending", expiresAt: { lt: expiryNow } },
						include: { config: { select: { userId: true } } },
						orderBy: { id: "asc" },
						take: TRANSITION_AUDIT_BATCH_LIMIT,
					});
					for (const approval of expiredCandidates) {
						const auditInput = buildSchedulerTransitionAuditInput(approval, {
							eventType: "expired",
							fromStatus: "pending",
							toStatus: "expired",
							reason: "Cleanup approval expired before execution.",
						});
						const result = await this.prisma.libraryCleanupApproval.updateMany({
							where: {
								id: approval.id,
								config: { userId: approval.config.userId },
								status: "pending",
								expiresAt: { lt: expiryNow },
							},
							data: {
								status: "expired",
								...createCleanupTerminalAuditState(auditInput),
							},
						});
						if (result.count === 1) {
							await appendCleanupTerminalAuditEvent(this.prisma, auditInput, {
								approvalId: approval.id,
								status: "expired",
							}).catch((error) => {
								this.logger.warn(
									{ err: error, approvalId: approval.id },
									"Failed to append expired cleanup audit; its envelope remains repairable",
								);
							});
						}
					}

					// Recover stuck "executing" items (crash recovery: >1 hour since approval).
					// The persisted safety snapshot is reconciled against the live file
					// remainder when the operator approves it again.
					const stuckThreshold = new Date(Date.now() - 60 * 60 * 1000);
					const staleRunLeaseThreshold = new Date(Date.now() - CLEANUP_RUN_LEASE_MS);
					await this.recoverStaleApprovals(
						"approved",
						"pending",
						"Recovered an interrupted approval request. Review and approve again.",
						stuckThreshold,
						staleRunLeaseThreshold,
						"Recovered stuck approved cleanup items — returned them to pending review",
					).catch((err) => {
						this.logger.warn({ err }, "Failed to recover stuck approved cleanup items");
					});
					await this.recoverInterruptedSonarrEpisodePhases(
						stuckThreshold,
						staleRunLeaseThreshold,
					).catch((err) => {
						this.logger.warn({ err }, "Failed to recover interrupted Sonarr episode phases");
					});
					const durableEpisodeRecoveryMessages = [
						SONARR_EPISODE_UNMONITOR_STARTED_RECOVERY_MESSAGE,
						SONARR_EPISODE_UNMONITOR_CONFIRMED_RECOVERY_MESSAGE,
						SONARR_EPISODE_UNMONITOR_PARTIAL_MESSAGE,
					];
					await this.recoverStaleApprovals(
						"executing",
						"pending",
						INTERRUPTED_CLEANUP_RECOVERY_MESSAGE,
						stuckThreshold,
						staleRunLeaseThreshold,
						"Recovered stuck executing approval items — returned them to pending review",
						durableEpisodeRecoveryMessages,
					).catch((err) => {
						this.logger.warn({ err }, "Failed to recover stuck executing approvals");
					});
					await this.recoverStaleApprovals(
						"retry_executing",
						"retry_pending",
						undefined,
						stuckThreshold,
						staleRunLeaseThreshold,
						"Recovered stuck record-only cleanup retries — returned them to retry pending",
						durableEpisodeRecoveryMessages,
					).catch((err) => {
						this.logger.warn({ err }, "Failed to recover stuck record-only cleanup retries");
					});
				}

				if (!config) return;

				const now = new Date();
				if (!config.nextRunAt) return;
				const configuredNextRunAtMs = config.nextRunAt.getTime();
				const configUpdatedAtMs = config.updatedAt?.getTime() ?? null;
				if (
					this.dryRunSchedule &&
					(this.dryRunSchedule.configId !== config.id ||
						this.dryRunSchedule.configuredNextRunAtMs !== configuredNextRunAtMs ||
						this.dryRunSchedule.configUpdatedAtMs !== configUpdatedAtMs ||
						this.dryRunSchedule.intervalHours !== config.intervalHours)
				) {
					this.dryRunSchedule = null;
				}
				const effectiveNextRunAtMs =
					config.dryRunMode && this.dryRunSchedule
						? this.dryRunSchedule.nextRunAtMs
						: configuredNextRunAtMs;
				if (effectiveNextRunAtMs > now.getTime()) return;

				this._isRunning = true;
				isScheduledDryRun = config.dryRunMode;

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
							quiClientFactory: this.quiClientFactory,
							quiFileHashIndexFactory: this.quiFileHashIndexFactory,
							externalRuleCacheRefresher: this.externalRuleCacheRefresher,
							log: this.logger,
						},
						config.userId,
						{ actorType: "scheduler", trigger: "scheduled" },
					);

					// Calculate next run time
					const nextRunAt = new Date(now.getTime() + config.intervalHours * 60 * 60 * 1000);

					if (config.dryRunMode) {
						// A dry run is read-only, including its scheduling and notification
						// side effects. Preserve cadence in process without writing the config.
						this.dryRunSchedule = {
							configId: config.id,
							configuredNextRunAtMs,
							configUpdatedAtMs,
							intervalHours: config.intervalHours,
							nextRunAtMs: nextRunAt.getTime(),
						};
					} else {
						this.dryRunSchedule = null;
						await this.prisma.libraryCleanupConfig.update({
							where: { id: config.id },
							data: { lastRunAt: now, nextRunAt },
						});
					}

					this.logger.info(
						{
							itemsEvaluated: result.itemsEvaluated,
							itemsFlagged: result.itemsFlagged,
							itemsRemoved: result.itemsRemoved,
							nextRunAt: nextRunAt.toISOString(),
						},
						"Scheduled library cleanup completed",
					);

					if (!config.dryRunMode) {
						const notification = buildCleanupNotification(result);
						if (notification) {
							await this.sendNotification(notification, "Failed to send cleanup notification");
						}
					}
				} finally {
					this._isRunning = false;
				}
			});
		} catch (error) {
			this._isRunning = false;
			if (error instanceof CleanupMaintenanceConflictError) {
				this.logger.debug("Database maintenance owns the library-cleanup operation guard");
				return;
			}
			if (error instanceof CleanupRunAlreadyInProgressError) {
				this.logger.debug("Another app process owns the library-cleanup run lease");
				return;
			}
			this.logger.error({ err: error }, "Error checking/running scheduled cleanup");
			if (isScheduledDryRun) return;

			await this.sendNotification(
				{
					eventType: "SYSTEM_ERROR",
					title: "Library cleanup failed",
					body: getErrorMessage(error),
					url: "/library",
				},
				"Failed to send cleanup error notification",
			);
		}
	}
}
