import { afterEach, describe, expect, it, vi } from "vitest";

const executorMocks = vi.hoisted(() => ({ executeCleanupRun: vi.fn() }));
const rescanMocks = vi.hoisted(() => ({
	recoverAllPendingTerminalAudits: vi
		.fn()
		.mockResolvedValue({ candidates: 0, recovered: 0, failed: 0 }),
	retryAllPendingMediaServerRescans: vi
		.fn()
		.mockResolvedValue({ targets: 0, triggered: 0, failed: 0, warnings: [] }),
}));
vi.mock("../cleanup-executor.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../cleanup-executor.js")>()),
	executeCleanupRun: executorMocks.executeCleanupRun,
}));
vi.mock("../media-server-rescan.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../media-server-rescan.js")>()),
	recoverAllPendingTerminalAudits: rescanMocks.recoverAllPendingTerminalAudits,
	retryAllPendingMediaServerRescans: rescanMocks.retryAllPendingMediaServerRescans,
}));

import {
	SONARR_EPISODE_UNMONITOR_CONFIRMED_RECOVERY_MESSAGE,
	SONARR_EPISODE_UNMONITOR_PARTIAL_MESSAGE,
	SONARR_EPISODE_UNMONITOR_STARTED_RECOVERY_MESSAGE,
} from "../cleanup-executor.js";
import {
	CleanupMaintenanceConflictError,
	withCleanupMaintenanceGuard,
} from "../cleanup-maintenance-gate.js";
import { CleanupScheduler } from "../cleanup-scheduler.js";

describe("library cleanup scheduler recovery", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("retries durable media-server scans even when cleanup is disabled or not due", async () => {
		const prisma = {
			libraryCleanupApproval: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
			libraryCleanupConfig: { findFirst: vi.fn().mockResolvedValue(null) },
		};
		const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
		const scheduler = new CleanupScheduler(prisma as never, {} as never, {} as never, log as never);

		await (scheduler as unknown as { checkAndRun: () => Promise<void> }).checkAndRun();

		expect(rescanMocks.recoverAllPendingTerminalAudits).toHaveBeenCalledWith(
			expect.objectContaining({ prisma, auditTrigger: "recovery" }),
		);
		expect(rescanMocks.retryAllPendingMediaServerRescans).toHaveBeenCalledWith(
			expect.objectContaining({ prisma, auditTrigger: "recovery" }),
		);
		expect(executorMocks.executeCleanupRun).not.toHaveBeenCalled();
	});

	it("keeps scan retry independent when terminal-audit discovery fails", async () => {
		rescanMocks.recoverAllPendingTerminalAudits.mockRejectedValueOnce(
			new Error("approval query unavailable"),
		);
		const prisma = {
			libraryCleanupApproval: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
			libraryCleanupConfig: { findFirst: vi.fn().mockResolvedValue(null) },
		};
		const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
		const scheduler = new CleanupScheduler(prisma as never, {} as never, {} as never, log as never);

		await (scheduler as unknown as { checkAndRun: () => Promise<void> }).checkAndRun();

		expect(rescanMocks.retryAllPendingMediaServerRescans).toHaveBeenCalledOnce();
		expect(log.warn).toHaveBeenCalledWith(
			expect.objectContaining({ err: expect.any(Error) }),
			"Pending cleanup terminal audits could not be recovered",
		);
	});

	it("passes scheduled audit origin into an automatically consumed retry run", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-03T12:00:00.000Z"));
		executorMocks.executeCleanupRun.mockResolvedValue({
			isDryRun: false,
			status: "completed",
			itemsEvaluated: 0,
			itemsFlagged: 0,
			itemsRemoved: 0,
			itemsUnmonitored: 0,
			itemsFilesDeleted: 0,
			itemsSkipped: 0,
			details: [],
			durationMs: 1,
		});
		const prisma = {
			libraryCleanupApproval: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
			libraryCleanupConfig: {
				findFirst: vi.fn().mockResolvedValue({
					id: "config-1",
					userId: "user-1",
					enabled: true,
					nextRunAt: new Date("2026-08-03T11:00:00.000Z"),
					intervalHours: 24,
					dryRunMode: false,
				}),
				update: vi.fn().mockResolvedValue({}),
			},
		};
		const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
		const scheduler = new CleanupScheduler(prisma as never, {} as never, {} as never, log as never);

		await (scheduler as unknown as { checkAndRun: () => Promise<void> }).checkAndRun();

		expect(executorMocks.executeCleanupRun).toHaveBeenCalledWith(
			expect.objectContaining({ auditTrigger: "scheduled" }),
			"user-1",
		);
	});

	it("recovers stale execution rows only when their config has no active run lease", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-27T15:00:00.000Z"));

		const rows = [
			{
				id: "active",
				status: "executing",
				lastExecutionError: null as string | null,
				reviewedAt: new Date("2026-07-27T13:00:00.000Z"),
				config: {
					runClaimToken: "live-owner",
					runClaimedAt: new Date("2026-07-27T14:59:00.000Z"),
				},
			},
			{
				id: "unleased",
				status: "executing",
				lastExecutionError: null as string | null,
				reviewedAt: new Date("2026-07-27T13:00:00.000Z"),
				config: { runClaimToken: null, runClaimedAt: null },
			},
			{
				id: "stale-lease",
				status: "retry_executing",
				lastExecutionError: null as string | null,
				reviewedAt: new Date("2026-07-27T13:00:00.000Z"),
				config: {
					runClaimToken: "crashed-owner",
					runClaimedAt: new Date("2026-07-27T12:00:00.000Z"),
				},
			},
			{
				id: "approved-after-crash",
				status: "approved",
				lastExecutionError: null as string | null,
				reviewedAt: new Date("2026-07-27T13:00:00.000Z"),
				config: { runClaimToken: null, runClaimedAt: null },
			},
		];
		const approvalUpdateMany = vi.fn(
			async ({
				where,
				data,
			}: {
				where: {
					status: string;
					lastExecutionError?: string;
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
					if (
						typeof where.lastExecutionError === "string" &&
						row.lastExecutionError !== where.lastExecutionError
					) {
						continue;
					}
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
			libraryCleanupApproval: { updateMany: approvalUpdateMany },
			libraryCleanupConfig: { findFirst: vi.fn().mockResolvedValue(null) },
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
	});

	it("preserves durable Sonarr episode phases while recovering interrupted execution", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-27T15:00:00.000Z"));
		const startedMessage = SONARR_EPISODE_UNMONITOR_STARTED_RECOVERY_MESSAGE;
		const confirmedMessage = SONARR_EPISODE_UNMONITOR_CONFIRMED_RECOVERY_MESSAGE;
		const legacyPartialMessage = SONARR_EPISODE_UNMONITOR_PARTIAL_MESSAGE;
		const expiredAt = new Date("2026-07-27T14:00:00.000Z");
		const rows = [
			{ id: "started", status: "executing", lastExecutionError: startedMessage },
			{
				id: "confirmed",
				status: "executing",
				lastExecutionError: confirmedMessage,
				expiresAt: expiredAt,
			},
			{
				id: "legacy-partial",
				status: "executing",
				lastExecutionError: legacyPartialMessage,
			},
			{ id: "retry-started", status: "retry_executing", lastExecutionError: startedMessage },
			{ id: "retry-confirmed", status: "retry_executing", lastExecutionError: confirmedMessage },
			{ id: "ordinary", status: "executing", lastExecutionError: null },
			{ id: "ordinary-retry", status: "retry_executing", lastExecutionError: "retrying" },
		];
		const updateMany = vi.fn(
			async ({
				where,
				data,
			}: {
				where: {
					status: string;
					lastExecutionError?: string | { notIn?: string[] };
				};
				data: Record<string, unknown>;
			}) => {
				let count = 0;
				for (const row of rows) {
					if (row.status !== where.status) continue;
					if (typeof where.lastExecutionError === "string") {
						if (row.lastExecutionError !== where.lastExecutionError) continue;
					} else if (where.lastExecutionError?.notIn?.includes(row.lastExecutionError ?? "")) {
						continue;
					}
					Object.assign(row, data);
					count++;
				}
				return { count };
			},
		);
		const prisma = {
			libraryCleanupApproval: { updateMany },
			libraryCleanupConfig: { findFirst: vi.fn().mockResolvedValue(null) },
		};
		const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
		const scheduler = new CleanupScheduler(prisma as never, {} as never, {} as never, log as never);

		await (scheduler as unknown as { checkAndRun: () => Promise<void> }).checkAndRun();

		expect(rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "started",
					status: "expired",
					lastExecutionError: startedMessage,
				}),
				expect.objectContaining({
					id: "confirmed",
					status: "retry_pending",
					lastExecutionError: confirmedMessage,
					expiresAt: expiredAt,
				}),
				expect.objectContaining({
					id: "legacy-partial",
					status: "retry_pending",
					lastExecutionError: legacyPartialMessage,
				}),
				expect.objectContaining({
					id: "retry-started",
					status: "expired",
					lastExecutionError: startedMessage,
				}),
				expect.objectContaining({
					id: "retry-confirmed",
					status: "retry_pending",
					lastExecutionError: confirmedMessage,
				}),
				expect.objectContaining({ id: "ordinary", status: "pending" }),
				expect.objectContaining({ id: "ordinary-retry", status: "retry_pending" }),
			]),
		);
	});

	it("appends expiry and crash-recovery events only after the authoritative transitions", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-30T15:00:00.000Z"));
		const expired = {
			id: "expired-1",
			configId: "config-1",
			instanceId: "radarr-1",
			arrItemId: 1,
			itemType: "movie",
			targetScope: "series",
			arrEpisodeId: null,
			title: "Expired",
			matchedRuleId: "rule-1",
			matchedRuleName: "Old",
			reason: "Matched",
			action: "delete",
			status: "pending",
			reviewedAt: null as Date | null,
			expiresAt: new Date("2026-07-30T14:00:00.000Z"),
			lastExecutionError: null as string | null,
		};
		const crashed = {
			...expired,
			id: "crashed-1",
			title: "Crashed",
			status: "executing",
			reviewedAt: new Date("2026-07-30T12:00:00.000Z"),
			expiresAt: new Date("2026-08-01T12:00:00.000Z"),
		};
		const auditCreate = vi.fn().mockResolvedValue({});
		const approvalFindMany = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
			if (where.expiresAt) return expired.status === "pending" ? [expired] : [];
			if (where.status === "approved" || where.status === "retry_executing") return [];
			if (where.status === "executing") return crashed.status === "executing" ? [crashed] : [];
			if (where.status === "pending" && "id" in where) return [crashed];
			return [];
		});
		const approvalUpdateMany = vi.fn(
			async ({
				where,
				data,
			}: {
				where: Record<string, unknown>;
				data: Record<string, unknown>;
			}) => {
				if (where.id === expired.id && expired.status === "pending") {
					Object.assign(expired, data);
					return { count: 1 };
				}
				if (
					where.status === "executing" &&
					crashed.status === "executing" &&
					(typeof where.lastExecutionError !== "string" ||
						crashed.lastExecutionError === where.lastExecutionError)
				) {
					Object.assign(crashed, data);
					return { count: 1 };
				}
				return { count: 0 };
			},
		);
		const prisma = {
			libraryCleanupAuditEvent: { create: auditCreate },
			libraryCleanupApproval: {
				findMany: approvalFindMany,
				updateMany: approvalUpdateMany,
			},
			libraryCleanupConfig: { findFirst: vi.fn().mockResolvedValue(null) },
		};
		const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
		const scheduler = new CleanupScheduler(prisma as never, {} as never, {} as never, log as never);

		await (
			scheduler as unknown as {
				checkAndRun: () => Promise<void>;
			}
		).checkAndRun();

		expect(expired).toMatchObject({
			status: "expired",
			lastExecutionError: "Approval expired before operator action.",
		});
		expect(crashed).toMatchObject({
			status: "pending",
			lastExecutionError: expect.stringContaining("interrupted"),
		});
		const events = auditCreate.mock.calls.map(([call]) => call.data);
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ actionId: "expired-1", eventType: "approval_expired" }),
				expect.objectContaining({
					actionId: "crashed-1",
					eventType: "recovery_transition",
					trigger: "scheduled",
					outcome: "failed",
					details: expect.stringContaining('"mutationOutcome":"unknown"'),
				}),
			]),
		);
		const executingWriteOrder = approvalUpdateMany.mock.invocationCallOrder.find(
			(_order, index) => approvalUpdateMany.mock.calls[index]?.[0].where.status === "executing",
		);
		const recoveryAuditOrder = auditCreate.mock.invocationCallOrder.find(
			(_order, index) =>
				auditCreate.mock.calls[index]?.[0].data.eventType === "recovery_transition",
		);
		expect(executingWriteOrder).toBeLessThan(recoveryAuditOrder!);
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
