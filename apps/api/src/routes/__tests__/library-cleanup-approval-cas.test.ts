import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const executorMocks = vi.hoisted(() => ({
	buildEvalContext: vi.fn(),
	CleanupPolicyMutationConflictError: class CleanupPolicyMutationConflictError extends Error {
		constructor() {
			super("Library cleanup settings cannot be changed while a cleanup operation is in progress");
		}
	},
	CleanupRunAlreadyInProgressError: class CleanupRunAlreadyInProgressError extends Error {
		constructor() {
			super("A cleanup operation is already in progress");
		}
	},
	executeApprovedItems: vi.fn().mockResolvedValue({ removed: 1, failed: 0, errors: [] }),
	executeCleanupPreview: vi.fn(),
	executeCleanupRun: vi.fn(),
	executeRetryItems: vi
		.fn()
		.mockResolvedValue({ removed: 0, reconciled: 1, failed: 0, errors: [] }),
	withCleanupPolicyMutationLease: vi.fn(
		async (_deps: unknown, _userId: string, mutate: () => Promise<unknown>) => await mutate(),
	),
}));

const auditMocks = vi.hoisted(() => ({
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

vi.mock("../../lib/library-cleanup/cleanup-executor.js", () => executorMocks);
vi.mock("../../lib/library-cleanup/cleanup-run-lease.js", () => ({
	CleanupPolicyMutationConflictError: executorMocks.CleanupPolicyMutationConflictError,
	CleanupRunAlreadyInProgressError: executorMocks.CleanupRunAlreadyInProgressError,
	withCleanupPolicyMutationLease: executorMocks.withCleanupPolicyMutationLease,
}));
vi.mock("../../lib/library-cleanup/cleanup-audit.js", () => auditMocks);

import {
	CleanupMaintenanceConflictError,
	withCleanupMaintenanceGuard,
} from "../../lib/library-cleanup/cleanup-maintenance-gate.js";
import { registerLibraryCleanupRoutes } from "../library-cleanup.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

describe("library cleanup approval compare-and-set routes", () => {
	let app: ReturnType<typeof Fastify>;
	let status: "pending" | "approved";
	let updateMany: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		vi.clearAllMocks();
		status = "pending";
		updateMany = vi.fn(
			async ({ where, data }: { where: { status: string }; data: { status: string } }) => {
				if (where.status !== status) return { count: 0 };
				status = data.status as typeof status;
				return { count: 1 };
			},
		);

		app = Fastify();
		setupAuthInjection(app);
		registerTestErrorHandler(app);
		app.decorate("prisma", {
			$transaction: vi.fn(async (callback) => await callback(app.prisma)),
			libraryCleanupApproval: {
				updateMany,
				findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({
					id: where.id,
					configId: "config-1",
					instanceId: "radarr-1",
					arrItemId: 101,
					arrEpisodeId: null,
					itemType: "movie",
					targetScope: "series",
					title: "Example Movie",
					episodeTitle: null,
					seasonNumber: null,
					episodeNumber: null,
					matchedRuleId: "rule-1",
					matchedRuleName: "Cleanup",
					reason: "Matched",
					action: "delete",
				})),
				findMany: vi.fn(
					async ({
						where,
					}: {
						where: { id?: { in: string[] }; status?: string; OR?: Array<{ status: string }> };
					}) =>
						where.id?.in && where.status && where.status !== status
							? []
							: (where.id?.in ?? ["retry-1"]).map((id) => ({
									id,
									configId: "config-1",
									instanceId: "radarr-1",
									arrItemId: 101,
									itemType: "movie",
									title: "Example Movie",
									matchedRuleId: "rule-1",
									matchedRuleName: "Cleanup",
									reason: "Matched",
									action: "delete",
									sizeOnDisk: 1000n,
									year: 2024,
									rating: 8,
									status: where.status ?? "executed",
									lastExecutionError: "Radarr is unavailable",
									reviewedAt: new Date(),
									executedAt: null,
									createdAt: new Date(),
									expiresAt: new Date(Date.now() + 60_000),
								})),
				),
				count: vi.fn().mockResolvedValue(1),
			},
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue([{ id: "radarr-1", label: "Radarr" }]),
			},
			libraryCache: {
				findMany: vi.fn().mockResolvedValue([]),
			},
		} as never);
		app.decorate("arrClientFactory", {} as never);
		app.decorate("encryptor", {} as never);
		await app.register(registerLibraryCleanupRoutes);
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
	});

	it("allows only one concurrent request to transition and execute a pending approval", async () => {
		const inject = createInjectAuthenticated(app);
		const [first, second] = await Promise.all([
			inject("POST", "/library-cleanup/approval-queue/approval-1/approve"),
			inject("POST", "/library-cleanup/approval-queue/approval-1/approve"),
		]);

		expect([first.statusCode, second.statusCode].sort()).toEqual([200, 404]);
		expect(executorMocks.executeApprovedItems).toHaveBeenCalledOnce();
		expect(updateMany).toHaveBeenCalledTimes(2);
		expect(auditMocks.appendCleanupAuditEvent).toHaveBeenCalledOnce();
	});

	it("records operator approval after the durable compare-and-set", async () => {
		const response = await createInjectAuthenticated(app)(
			"POST",
			"/library-cleanup/approval-queue/approval-1/approve",
		);

		expect(response.statusCode).toBe(200);
		expect(auditMocks.appendCleanupAuditEvent).toHaveBeenCalledWith(
			app.prisma,
			expect.objectContaining({
				userId: "user-1",
				configId: "config-1",
				actionId: "approval-1",
				actorType: "operator",
				actorId: "user-1",
				eventType: "approval_reviewed",
				trigger: "approval",
				outcome: "info",
				evidence: { decision: "approved" },
			}),
		);
		expect(auditMocks.appendCleanupAuditEvent.mock.invocationCallOrder[0]).toBeLessThan(
			executorMocks.executeApprovedItems.mock.invocationCallOrder[0]!,
		);
	});

	it("fails closed before approval execution when the operator audit cannot be persisted", async () => {
		auditMocks.appendCleanupAuditEvent.mockRejectedValueOnce(new Error("audit unavailable"));

		const response = await createInjectAuthenticated(app)(
			"POST",
			"/library-cleanup/approval-queue/approval-1/approve",
		);

		expect(response.statusCode).toBe(500);
		expect(executorMocks.executeApprovedItems).not.toHaveBeenCalled();
	});

	it("records a rejected review only after its durable transition", async () => {
		const response = await createInjectAuthenticated(app)(
			"POST",
			"/library-cleanup/approval-queue/approval-1/reject",
		);

		expect(response.statusCode).toBe(204);
		expect(auditMocks.appendCleanupAuditEvent).toHaveBeenCalledWith(
			app.prisma,
			expect.objectContaining({
				eventType: "approval_reviewed",
				outcome: "blocked",
				evidence: { decision: "rejected" },
			}),
		);
		expect(updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "rejected",
					terminalAuditEventType: "approval_reviewed",
					terminalAuditOutcome: "blocked",
					terminalAuditActorType: "operator",
					terminalAuditActorId: "user-1",
					terminalAuditTrigger: "approval",
					terminalAuditReason: "Rejected by the operator",
					terminalAuditRecordedAt: expect.any(Date),
				}),
			}),
		);
	});

	it("fails the rejected transition when its audit event is unavailable", async () => {
		auditMocks.appendCleanupAuditEvent.mockRejectedValueOnce(new Error("audit unavailable"));

		const response = await createInjectAuthenticated(app)(
			"POST",
			"/library-cleanup/approval-queue/approval-1/reject",
		);

		expect(response.statusCode).toBe(500);
		expect(auditMocks.appendCleanupAuditEvent).toHaveBeenCalledOnce();
	});

	it("returns a retryable conflict when another cleanup run owns the database lease", async () => {
		executorMocks.executeApprovedItems.mockRejectedValueOnce(
			new executorMocks.CleanupRunAlreadyInProgressError(),
		);

		const response = await createInjectAuthenticated(app)(
			"POST",
			"/library-cleanup/approval-queue/approval-1/approve",
		);

		expect(response.statusCode).toBe(409);
		expect(response.json()).toEqual({ error: "A cleanup operation is already in progress" });
	});

	it("does not transition an approval while backup restore owns maintenance", async () => {
		let finishMaintenance!: () => void;
		const maintenanceBlocked = new Promise<void>((resolve) => {
			finishMaintenance = resolve;
		});
		const maintenance = withCleanupMaintenanceGuard(() => maintenanceBlocked);

		try {
			const response = await createInjectAuthenticated(app)(
				"POST",
				"/library-cleanup/approval-queue/approval-1/approve",
			);

			expect(response.statusCode).toBe(409);
			expect(updateMany).not.toHaveBeenCalled();
			expect(executorMocks.executeApprovedItems).not.toHaveBeenCalled();
		} finally {
			finishMaintenance();
			await maintenance;
		}
	});

	it("does not transition expired approvals during bulk approval", async () => {
		const inject = createInjectAuthenticated(app);

		const response = await inject("POST", "/library-cleanup/approval-queue/bulk", {
			body: { ids: ["approval-1"], action: "approved" },
		});

		expect(response.statusCode).toBe(200);
		expect(updateMany).toHaveBeenCalledWith({
			where: {
				id: { in: ["approval-1"] },
				config: { userId: "user-1" },
				status: "pending",
			},
			data: {
				status: "approved",
				executionToken: expect.any(String),
				reviewedAt: expect.any(Date),
			},
		});
	});

	it("keeps expired approvals out of the pending queue while scheduler auditing catches up", async () => {
		const response = await createInjectAuthenticated(app)(
			"GET",
			"/library-cleanup/approval-queue?status=pending&pageSize=100",
		);

		expect(response.statusCode).toBe(200);
		expect(app.prisma.libraryCleanupApproval.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					status: "pending",
					expiresAt: { gt: expect.any(Date) },
				}),
			}),
		);
		expect(app.prisma.libraryCleanupApproval.count).toHaveBeenCalledWith({
			where: expect.objectContaining({
				status: "pending",
				expiresAt: { gt: expect.any(Date) },
			}),
		});
	});

	it("uses distinct request tokens for overlapping bulk approvals", async () => {
		let releaseFirst!: (result: { removed: number; failed: number; errors: string[] }) => void;
		executorMocks.executeApprovedItems
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						releaseFirst = resolve;
					}),
			)
			.mockRejectedValueOnce(new executorMocks.CleanupRunAlreadyInProgressError());
		const inject = createInjectAuthenticated(app);

		const firstRequest = inject("POST", "/library-cleanup/approval-queue/bulk", {
			body: { ids: ["approval-1"], action: "approved" },
		});
		await vi.waitFor(() => expect(executorMocks.executeApprovedItems).toHaveBeenCalledOnce());
		const secondResponse = await inject("POST", "/library-cleanup/approval-queue/bulk", {
			body: { ids: ["approval-1"], action: "approved" },
		});
		releaseFirst({ removed: 1, failed: 0, errors: [] });
		const firstResponse = await firstRequest;

		expect(firstResponse.statusCode).toBe(200);
		expect(secondResponse.statusCode).toBe(409);
		const firstToken = executorMocks.executeApprovedItems.mock.calls[0]?.[3];
		const secondToken = executorMocks.executeApprovedItems.mock.calls[1]?.[3];
		expect(firstToken).toEqual(expect.any(String));
		expect(secondToken).toEqual(expect.any(String));
		expect(firstToken).not.toBe(secondToken);
		expect(updateMany.mock.calls[0]?.[0].data.executionToken).toBe(firstToken);
	});

	it.each(["retry_pending", "retry_executing"])(
		"exposes %s durable mutation state to operators",
		async (retryStatus) => {
			const response = await createInjectAuthenticated(app)(
				"GET",
				`/library-cleanup/approval-queue?status=${retryStatus}`,
			);

			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({
				items: [
					{
						status: retryStatus,
						lastExecutionError: "Radarr is unavailable",
						instanceLabel: "Radarr",
					},
				],
				total: 1,
			});
		},
	);

	it("shows operator-approved executed rows in the Approved tab query", async () => {
		const response = await createInjectAuthenticated(app)(
			"GET",
			"/library-cleanup/approval-queue?status=approved",
		);

		expect(response.statusCode).toBe(200);
		expect(app.prisma.libraryCleanupApproval.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					config: { userId: "user-1" },
					OR: [
						{ status: "approved" },
						{ status: "executed", id: { not: { startsWith: "mutation-intent:" } } },
					],
				},
			}),
		);
		expect(app.prisma.libraryCleanupApproval.count).toHaveBeenCalledWith({
			where: {
				config: { userId: "user-1" },
				OR: [
					{ status: "approved" },
					{ status: "executed", id: { not: { startsWith: "mutation-intent:" } } },
				],
			},
		});
		expect(response.json()).toMatchObject({
			items: [
				{
					status: "executed",
					instanceLabel: "Radarr",
				},
			],
			total: 1,
		});
	});

	it("explicitly resumes a durable retry independently of cleanup mode", async () => {
		const response = await createInjectAuthenticated(app)(
			"POST",
			"/library-cleanup/approval-queue/retry-1/retry",
		);

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ removed: 0, reconciled: 1, failed: 0, errors: [] });
		expect(executorMocks.executeRetryItems).toHaveBeenCalledWith(
			expect.objectContaining({
				prisma: app.prisma,
				arrClientFactory: app.arrClientFactory,
				encryptor: app.encryptor,
			}),
			"user-1",
			["retry-1"],
		);
	});

	it("returns a conflict when another process owns the cleanup run lease", async () => {
		executorMocks.executeCleanupRun.mockRejectedValueOnce(
			new executorMocks.CleanupRunAlreadyInProgressError(),
		);

		const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/execute");

		expect(response.statusCode).toBe(409);
		expect(response.json()).toEqual({ error: "A cleanup operation is already in progress" });
	});

	it("attributes a manual cleanup run to the current operator", async () => {
		executorMocks.executeCleanupRun.mockResolvedValueOnce({
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

		const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/execute");

		expect(response.statusCode).toBe(200);
		expect(executorMocks.executeCleanupRun).toHaveBeenCalledWith(expect.anything(), "user-1", {
			actorId: "user-1",
			actorType: "operator",
			trigger: "manual",
		});
	});

	it("returns a retryable conflict when maintenance blocks manual cleanup", async () => {
		let finishMaintenance!: () => void;
		const maintenanceBlocked = new Promise<void>((resolve) => {
			finishMaintenance = resolve;
		});
		const maintenance = withCleanupMaintenanceGuard(() => maintenanceBlocked);
		executorMocks.executeCleanupRun.mockRejectedValueOnce(new CleanupMaintenanceConflictError());

		try {
			const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/execute");

			expect(response.statusCode).toBe(409);
		} finally {
			finishMaintenance();
			await maintenance;
		}
	});

	it("warns when preview details were capped before reaching the route", async () => {
		const details = Array.from({ length: 200 }, (_, index) => ({
			instanceId: "radarr-1",
			arrItemId: index + 1,
			itemType: "movie",
			title: `Movie ${index + 1}`,
			rule: "Cleanup",
			reason: "Matched",
			action: "delete",
			sizeOnDisk: "1000",
			year: 2024,
			rating: 8,
		}));
		executorMocks.executeCleanupPreview.mockResolvedValueOnce({
			isDryRun: true,
			status: "completed",
			itemsEvaluated: 201,
			itemsFlagged: 201,
			pendingRetryCount: 0,
			selectionCountsComplete: true,
			previewItemCount: 201,
			previewSelection: {
				selectedFresh: 100,
				selectedRetries: 0,
				deferredBudget: 101,
				deferredApproval: 0,
				deferredRetryFairness: 0,
				deferredInFlightTarget: 0,
				deferredDuplicateTarget: 0,
				inFlight: 0,
				blocked: 0,
				retryStateUnavailable: 0,
				retryState: "complete" as const,
				total: 201,
			},
			itemsRemoved: 0,
			itemsUnmonitored: 0,
			itemsFilesDeleted: 0,
			itemsSkipped: 0,
			details,
			durationMs: 1,
			warnings: ["Existing warning"],
		});

		const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/preview");

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			totalEvaluated: 201,
			totalFlagged: 201,
			pendingRetryCount: 0,
			selectionCountsComplete: true,
			selection: { selectedFresh: 100, deferredBudget: 101, total: 201 },
			display: { shown: 200, hidden: 1, limit: 200, complete: false },
			warnings: [
				"Existing warning",
				"Display capped at 200 of 201 preview items; selection counts remain complete.",
			],
		});
		expect(response.json().items).toHaveLength(200);
	});

	it("does not warn when one retry is the only distinct preview row", async () => {
		executorMocks.executeCleanupPreview.mockResolvedValueOnce({
			isDryRun: true,
			status: "partial",
			itemsEvaluated: 1,
			itemsFlagged: 0,
			pendingRetryCount: 1,
			previewItemCount: 1,
			itemsRemoved: 0,
			itemsUnmonitored: 0,
			itemsFilesDeleted: 0,
			itemsSkipped: 0,
			details: [
				{
					instanceId: "radarr-1",
					arrItemId: 101,
					itemType: "movie",
					title: "Example Movie",
					ruleId: "rule-1",
					rule: "Cleanup",
					reason: "Durable retry pending resume",
					action: "delete",
					sizeOnDisk: "1000",
					year: 2024,
					rating: 8,
				},
			],
			durationMs: 1,
		});

		const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/preview");

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			totalFlagged: 0,
			pendingRetryCount: 1,
			selectionCountsComplete: true,
			display: { shown: 1, hidden: 0, limit: 200, complete: true },
			warnings: [],
		});
		expect(response.json().items).toHaveLength(1);
	});

	it("uses legacy preview counts when the executor omits selection metadata", async () => {
		executorMocks.executeCleanupPreview.mockResolvedValueOnce({
			isDryRun: true,
			status: "completed",
			itemsEvaluated: 2,
			itemsFlagged: 2,
			itemsRemoved: 0,
			itemsUnmonitored: 0,
			itemsFilesDeleted: 0,
			itemsSkipped: 0,
			details: [],
			durationMs: 1,
		});
		const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/preview");
		expect(response.json()).toMatchObject({
			pendingRetryCount: 0,
			selectionCountsComplete: true,
			display: { shown: 0, hidden: 2, limit: 200, complete: false },
		});
		expect(response.json().selection).toBeUndefined();
	});

	it("preserves unavailable retry count with incomplete capped preview warning", async () => {
		const details = Array.from({ length: 200 }, (_, index) => ({
			instanceId: "radarr-1",
			arrItemId: index + 1,
			itemType: "movie",
			title: `Movie ${index + 1}`,
			rule: "Cleanup",
			reason: "Deferred",
			action: "skipped" as const,
			sizeOnDisk: "1000",
			year: 2024,
			rating: 8,
		}));
		executorMocks.executeCleanupPreview.mockResolvedValueOnce({
			isDryRun: true,
			status: "partial",
			itemsEvaluated: 201,
			itemsFlagged: 201,
			pendingRetryCount: null,
			selectionCountsComplete: false,
			previewItemCount: 201,
			itemsRemoved: 0,
			itemsUnmonitored: 0,
			itemsFilesDeleted: 0,
			itemsSkipped: 201,
			details,
			durationMs: 1,
		});
		const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/preview");
		expect(response.json()).toMatchObject({
			pendingRetryCount: null,
			selectionCountsComplete: false,
			display: { shown: 200, hidden: 1, limit: 200, complete: false },
			warnings: [
				"Display capped at 200 of 201 known preview items; retry-backed selection counts are incomplete because durable retry state could not be loaded.",
			],
		});
	});

	it("warns when executing retries exceed the rendered preview cap", async () => {
		const details = Array.from({ length: 200 }, (_, index) => ({
			instanceId: "radarr-1",
			arrItemId: index + 1,
			itemType: "movie",
			title: `Movie ${index + 1}`,
			ruleId: "rule-1",
			rule: "Cleanup",
			reason: "Durable retry is already executing",
			action: "skipped" as const,
			sizeOnDisk: "1000",
			year: 2024,
			rating: 8,
		}));
		executorMocks.executeCleanupPreview.mockResolvedValueOnce({
			isDryRun: true,
			status: "partial",
			itemsEvaluated: 0,
			itemsFlagged: 0,
			pendingRetryCount: 0,
			previewItemCount: 201,
			itemsRemoved: 0,
			itemsUnmonitored: 0,
			itemsFilesDeleted: 0,
			itemsSkipped: 201,
			details,
			durationMs: 1,
		});

		const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/preview");

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			pendingRetryCount: 0,
			selectionCountsComplete: true,
			display: { shown: 200, hidden: 1, limit: 200, complete: false },
			warnings: ["Display capped at 200 of 201 preview items; selection counts remain complete."],
		});
		expect(response.json().items).toHaveLength(200);
	});
});
