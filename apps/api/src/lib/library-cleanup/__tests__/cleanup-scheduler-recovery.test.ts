import { afterEach, describe, expect, it, vi } from "vitest";
import { appendCleanupAuditEvent, appendCleanupTerminalAuditEvent } from "../cleanup-audit.js";
import { INTERRUPTED_CLEANUP_RECOVERY_MESSAGE } from "../cleanup-executor.js";
import {
	CleanupMaintenanceConflictError,
	withCleanupMaintenanceGuard,
} from "../cleanup-maintenance-gate.js";
import { CleanupScheduler } from "../cleanup-scheduler.js";

vi.mock("../media-server-rescan.js", () => ({
	retryAllPendingMediaServerRescans: vi.fn().mockResolvedValue({
		targets: 0,
		triggered: 0,
		failed: 0,
		warnings: [],
	}),
}));

vi.mock("../cleanup-audit.js", () => ({
	appendCleanupAuditEvent: vi.fn().mockResolvedValue({}),
	appendCleanupTerminalAuditEvent: vi.fn().mockResolvedValue({}),
	createCleanupTerminalAuditState: vi.fn(
		(input: {
			actorId?: string | null;
			actorType: string;
			correlationId: string;
			eventType: string;
			outcome: string;
			summary?: { reason?: string };
			trigger: string;
		}) => ({
			terminalAuditCorrelationId: input.correlationId,
			terminalAuditEventType: input.eventType,
			terminalAuditOutcome: input.outcome,
			terminalAuditActorType: input.actorType,
			terminalAuditActorId: input.actorId ?? null,
			terminalAuditTrigger: input.trigger,
			terminalAuditReason: input.summary?.reason ?? null,
			terminalAuditRecordedAt: null,
		}),
	),
	createCleanupAuditEventKey: vi.fn(
		(input: { actionId: string; correlationId: string; eventType: string }) =>
			`${input.eventType}:${input.actionId}:${input.correlationId}`,
	),
}));

describe("library cleanup scheduler recovery", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("recovers stale execution rows only when their config has no active run lease", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-27T15:00:00.000Z"));

		const rows = [
			{
				id: "active",
				status: "executing",
				reviewedAt: new Date("2026-07-27T13:00:00.000Z"),
				config: {
					runClaimToken: "live-owner",
					runClaimedAt: new Date("2026-07-27T14:59:00.000Z"),
					userId: "user-1",
				},
			},
			{
				id: "unleased",
				status: "executing",
				reviewedAt: new Date("2026-07-27T13:00:00.000Z"),
				config: { runClaimToken: null, runClaimedAt: null, userId: "user-1" },
			},
			{
				id: "stale-lease",
				status: "retry_executing",
				reviewedAt: new Date("2026-07-27T13:00:00.000Z"),
				config: {
					runClaimToken: "crashed-owner",
					runClaimedAt: new Date("2026-07-27T12:00:00.000Z"),
					userId: "user-1",
				},
			},
			{
				id: "approved-after-crash",
				status: "approved",
				reviewedAt: new Date("2026-07-27T13:00:00.000Z"),
				config: { runClaimToken: null, runClaimedAt: null, userId: "user-1" },
			},
		];
		const approvalFindMany = vi.fn(
			async ({ where }: { where: { status?: string; reviewedAt?: { lt: Date } } }) =>
				rows.filter(
					(row) =>
						(!where.status || row.status === where.status) &&
						(!where.reviewedAt || row.reviewedAt < where.reviewedAt.lt),
				),
		);
		const approvalUpdateMany = vi.fn(
			async ({
				where,
				data,
			}: {
				where: {
					status: string;
					reviewedAt?: { lt: Date };
					config?: { OR: Array<{ runClaimedAt?: null | { lt: Date }; runClaimToken?: null }> };
				};
				data: { status: string; executionToken?: null; lastExecutionError?: string };
			}) => {
				let count = 0;
				const staleLeaseBefore = where.config?.OR.find(
					(condition) => condition.runClaimedAt && typeof condition.runClaimedAt === "object",
				)?.runClaimedAt as { lt: Date } | undefined;
				for (const row of rows) {
					if (row.status !== where.status) continue;
					if (where.reviewedAt && row.reviewedAt >= where.reviewedAt.lt) continue;
					if (where.config) {
						const leaseIsRecoverable =
							row.config.runClaimToken === null ||
							row.config.runClaimedAt === null ||
							(staleLeaseBefore !== undefined && row.config.runClaimedAt < staleLeaseBefore.lt);
						if (!leaseIsRecoverable) continue;
					}
					Object.assign(row, data);
					count++;
				}
				return { count };
			},
		);
		const prisma = {
			libraryCleanupApproval: { findMany: approvalFindMany, updateMany: approvalUpdateMany },
			libraryCleanupConfig: { findFirst: vi.fn().mockResolvedValue(null) },
			$transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => await run(prisma)),
		};
		const log = {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		};
		const scheduler = new CleanupScheduler(prisma as never, {} as never, {} as never, log as never);

		await (
			scheduler as unknown as {
				checkAndRun: () => Promise<void>;
			}
		).checkAndRun();

		expect(rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "active", status: "executing" }),
				expect.objectContaining({ id: "unleased", status: "pending" }),
				expect.objectContaining({ id: "stale-lease", status: "retry_pending" }),
				expect.objectContaining({ id: "approved-after-crash", status: "pending" }),
			]),
		);
		expect(
			approvalUpdateMany.mock.calls.find(([args]) => args.where.status === "executing")?.[0].where
				.config,
		).toBeDefined();
		// Four candidates reached the transactional CAS; the active-lease row
		// remained unchanged and therefore emitted no audit event.
		expect(prisma.$transaction).toHaveBeenCalledTimes(4);
		expect(appendCleanupAuditEvent).toHaveBeenCalledTimes(3);
		expect(appendCleanupAuditEvent).toHaveBeenCalledWith(
			prisma,
			expect.objectContaining({
				eventType: "recovered",
				trigger: "recovery",
				summary: expect.objectContaining({
					reason: INTERRUPTED_CLEANUP_RECOVERY_MESSAGE,
				}),
				evidence: expect.objectContaining({
					fromStatus: "executing",
					toStatus: "pending",
				}),
			}),
		);
	});

	it("persists a repairable expiration envelope with transition-specific history", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-27T15:00:00.000Z"));
		const approval = {
			id: "expired-approval",
			configId: "config-1",
			instanceId: "radarr-1",
			arrItemId: 42,
			arrEpisodeId: null,
			itemType: "movie",
			targetScope: "series",
			seasonNumber: null,
			episodeNumber: null,
			episodeTitle: null,
			title: "Example Movie",
			matchedRuleId: "rule-1",
			matchedRuleName: "Old media",
			reason: "Matched old-media policy",
			action: "delete",
			status: "pending",
			expiresAt: new Date("2026-07-27T14:00:00.000Z"),
			reviewedAt: null,
			reconciledWithoutMutation: false,
			terminalAuditRecordedAt: null,
			config: { userId: "user-1" },
		};
		const findMany = vi.fn(async ({ where }: { where: { status?: unknown } }) =>
			where.status === "pending" && approval.status === "pending" ? [approval] : [],
		);
		const updateMany = vi.fn(
			async ({ where, data }: { where: { status: string }; data: object }) => {
				if (where.status !== approval.status) return { count: 0 };
				Object.assign(approval, data);
				return { count: 1 };
			},
		);
		const prisma = {
			libraryCleanupApproval: { findMany, updateMany },
			libraryCleanupConfig: { findFirst: vi.fn().mockResolvedValue(null) },
			$transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => await run(prisma)),
		};
		const scheduler = new CleanupScheduler(
			prisma as never,
			{} as never,
			{} as never,
			{ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
		);

		await (
			scheduler as unknown as {
				checkAndRun: () => Promise<void>;
			}
		).checkAndRun();

		expect(approval).toMatchObject({
			status: "expired",
			terminalAuditEventType: "expired",
			terminalAuditOutcome: "blocked",
			terminalAuditActorType: "scheduler",
			terminalAuditTrigger: "scheduled",
			terminalAuditReason: "Cleanup approval expired before execution.",
			terminalAuditRecordedAt: null,
		});
		expect(appendCleanupTerminalAuditEvent).toHaveBeenCalledWith(
			prisma,
			expect.objectContaining({
				eventType: "expired",
				summary: expect.objectContaining({
					reason: "Cleanup approval expired before execution.",
				}),
				evidence: {
					stateTransitionPersisted: true,
					fromStatus: "pending",
					toStatus: "expired",
				},
			}),
			{ approvalId: "expired-approval", status: "expired" },
		);
	});

	it("rolls back a stale-execution recovery when its audit event cannot commit", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-27T15:00:00.000Z"));
		const approval = {
			id: "stale-execution",
			configId: "config-1",
			instanceId: "sonarr-1",
			arrItemId: 42,
			arrEpisodeId: null,
			itemType: "series",
			targetScope: "series",
			seasonNumber: null,
			episodeNumber: null,
			episodeTitle: null,
			title: "Example Series",
			matchedRuleId: "rule-1",
			matchedRuleName: "Old media",
			reason: "Matched old-media policy",
			action: "delete",
			status: "executing",
			executionToken: "active-execution",
			reviewedAt: new Date("2026-07-27T13:00:00.000Z"),
			expiresAt: new Date("2026-07-28T15:00:00.000Z"),
			reconciledWithoutMutation: false,
			terminalAuditRecordedAt: null,
			lastExecutionError: null as string | null,
			config: { userId: "user-1", runClaimToken: null, runClaimedAt: null },
		};
		const findMany = vi.fn(async ({ where }: { where: { status?: unknown } }) =>
			where.status === "executing" ? [approval] : [],
		);
		const updateMany = vi.fn(
			async ({ where, data }: { where: { status: string }; data: object }) => {
				if (where.status !== approval.status) return { count: 0 };
				Object.assign(approval, data);
				return { count: 1 };
			},
		);
		const prisma = {
			libraryCleanupApproval: { findMany, updateMany },
			libraryCleanupConfig: { findFirst: vi.fn().mockResolvedValue(null) },
			$transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => {
				const before = { ...approval };
				try {
					return await run(prisma);
				} catch (error) {
					Object.assign(approval, before);
					throw error;
				}
			}),
		};
		vi.mocked(appendCleanupAuditEvent).mockRejectedValueOnce(new Error("audit unavailable"));
		const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
		const scheduler = new CleanupScheduler(prisma as never, {} as never, {} as never, log as never);

		await (
			scheduler as unknown as {
				checkAndRun: () => Promise<void>;
			}
		).checkAndRun();

		expect(approval).toMatchObject({
			status: "executing",
			executionToken: "active-execution",
			lastExecutionError: null,
		});
		expect(log.warn).toHaveBeenCalledWith(
			expect.objectContaining({ approvalId: "stale-execution" }),
			"Failed to atomically recover and audit a stale cleanup approval",
		);
	});

	it("does not run recovery writes while database maintenance is active", async () => {
		const updateMany = vi.fn().mockResolvedValue({ count: 0 });
		const findFirst = vi.fn().mockResolvedValue(null);
		const log = {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		};
		const scheduler = new CleanupScheduler(
			{
				libraryCleanupApproval: { updateMany },
				libraryCleanupConfig: { findFirst },
			} as never,
			{} as never,
			{} as never,
			log as never,
		);
		let finishMaintenance!: () => void;
		const maintenanceBlocked = new Promise<void>((resolve) => {
			finishMaintenance = resolve;
		});
		const maintenance = withCleanupMaintenanceGuard(() => maintenanceBlocked);

		try {
			await (
				scheduler as unknown as {
					checkAndRun: () => Promise<void>;
				}
			).checkAndRun();

			expect(updateMany).not.toHaveBeenCalled();
			expect(findFirst).not.toHaveBeenCalled();
			expect(log.debug).toHaveBeenCalledWith(
				"Database maintenance owns the library-cleanup operation guard",
			);
		} finally {
			finishMaintenance();
			await maintenance;
		}
	});

	it("repairs canonical executed and blocked terminal audits without constructing an ARR client", async () => {
		vi.mocked(appendCleanupTerminalAuditEvent).mockClear();
		const executed = {
			id: "executed-without-terminal-audit",
			configId: "config-1",
			instanceId: "radarr-1",
			arrItemId: 42,
			arrEpisodeId: null,
			itemType: "movie",
			targetScope: "series",
			title: "Example Movie",
			matchedRuleId: "rule-1",
			matchedRuleName: "Old media",
			reason: "Matched cleanup policy",
			action: "delete",
			status: "executed",
			executionAuditCorrelationId: "execution-correlation-1",
			terminalAuditCorrelationId: "execution-correlation-1",
			terminalAuditEventType: "succeeded",
			terminalAuditOutcome: "success",
			terminalAuditActorType: "operator",
			terminalAuditActorId: "user-1",
			terminalAuditTrigger: "approval",
			terminalAuditReason: "Cleanup action completed successfully.",
			reconciledWithoutMutation: false,
			terminalAuditRecordedAt: null as Date | null,
			config: { userId: "user-1" },
		};
		const blocked = {
			...executed,
			id: "blocked-without-terminal-audit",
			status: "expired",
			terminalAuditCorrelationId: "blocked-correlation-1",
			terminalAuditEventType: "failed",
			terminalAuditOutcome: "blocked",
			terminalAuditTrigger: "retry",
			terminalAuditReason: "Current policy blocked this action.",
		};
		const rejected = {
			...executed,
			id: "rejected-without-terminal-audit",
			status: "rejected",
			terminalAuditCorrelationId: "rejection-correlation-1",
			terminalAuditEventType: "approval_reviewed",
			terminalAuditOutcome: "blocked",
			terminalAuditActorType: "operator",
			terminalAuditActorId: "user-1",
			terminalAuditTrigger: "approval",
			terminalAuditReason: "Rejected by the operator",
		};
		const rows = [executed, blocked, rejected];
		const approvalFindMany = vi.fn(async () =>
			rows.filter((row) => row.terminalAuditRecordedAt === null),
		);
		vi.mocked(appendCleanupTerminalAuditEvent).mockImplementation(async (_prisma, input) => {
			const row = rows.find((candidate) => candidate.id === input.actionId);
			if (row) row.terminalAuditRecordedAt = new Date();
			return {} as never;
		});
		const arrClientFactory = { create: vi.fn() };
		const scheduler = new CleanupScheduler(
			{
				libraryCleanupApproval: { findMany: approvalFindMany },
				libraryCleanupConfig: { findFirst: vi.fn().mockResolvedValue(null) },
			} as never,
			arrClientFactory as never,
			{} as never,
			{ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
		);

		await (
			scheduler as unknown as {
				checkAndRun: () => Promise<void>;
			}
		).checkAndRun();

		expect(appendCleanupTerminalAuditEvent).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				eventType: "succeeded",
				outcome: "success",
				actorType: "operator",
				trigger: "approval",
			}),
			{ approvalId: executed.id, status: "executed" },
		);
		expect(appendCleanupTerminalAuditEvent).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				eventType: "failed",
				outcome: "blocked",
				trigger: "retry",
				summary: expect.objectContaining({
					reason: "Current policy blocked this action.",
				}),
			}),
			{ approvalId: blocked.id, status: "expired" },
		);
		expect(appendCleanupTerminalAuditEvent).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				eventType: "approval_reviewed",
				outcome: "blocked",
				actorType: "operator",
				summary: expect.objectContaining({ reason: "Rejected by the operator" }),
			}),
			{ approvalId: rejected.id, status: "rejected" },
		);
		expect(executed.terminalAuditRecordedAt).toBeInstanceOf(Date);
		expect(blocked.terminalAuditRecordedAt).toBeInstanceOf(Date);
		expect(rejected.terminalAuditRecordedAt).toBeInstanceOf(Date);
		expect(arrClientFactory.create).not.toHaveBeenCalled();

		await (
			scheduler as unknown as {
				checkAndRun: () => Promise<void>;
			}
		).checkAndRun();
		expect(appendCleanupTerminalAuditEvent).toHaveBeenCalledTimes(3);
		vi.mocked(appendCleanupTerminalAuditEvent).mockResolvedValue({} as never);
	});

	it("keeps error notification work guarded against backup restore", async () => {
		const updateMany = vi.fn().mockResolvedValue({ count: 0 });
		const findFirst = vi.fn().mockRejectedValue(new Error("config read failed"));
		const log = {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		};
		let finishNotification!: () => void;
		const notificationBlocked = new Promise<void>((resolve) => {
			finishNotification = resolve;
		});
		const notify = vi.fn(() => notificationBlocked);
		const scheduler = new CleanupScheduler(
			{
				libraryCleanupApproval: { updateMany },
				libraryCleanupConfig: { findFirst },
			} as never,
			{} as never,
			{} as never,
			log as never,
			notify,
		);

		const tick = (
			scheduler as unknown as {
				checkAndRun: () => Promise<void>;
			}
		).checkAndRun();

		try {
			await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
			await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toBeInstanceOf(
				CleanupMaintenanceConflictError,
			);
		} finally {
			finishNotification();
			await tick;
		}
	});
});
