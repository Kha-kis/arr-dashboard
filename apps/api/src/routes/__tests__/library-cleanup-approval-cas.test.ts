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

vi.mock("../../lib/library-cleanup/cleanup-executor.js", () => executorMocks);

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
	const mockPreviewItem = (overrides: Record<string, unknown> = {}) => {
		executorMocks.executeCleanupPreview.mockResolvedValueOnce({
			isDryRun: true,
			status: "completed",
			itemsEvaluated: 1,
			itemsFlagged: 1,
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
					reason: "Matched",
					action: "delete",
					sizeOnDisk: "1000",
					year: 2024,
					rating: 8,
					...overrides,
				},
			],
			durationMs: 1,
		});
	};

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
			libraryCleanupApproval: {
				updateMany,
				findMany: vi.fn(
					async ({ where }: { where: { status?: string; OR?: Array<{ status: string }> } }) => [
						{
							id: "retry-1",
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
						},
					],
				),
				count: vi.fn().mockResolvedValue(1),
			},
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue([{ id: "radarr-1", label: "Radarr" }]),
				findFirst: vi.fn().mockResolvedValue({ id: "qui-1" }),
			},
			libraryCache: {
				findMany: vi.fn().mockResolvedValue([]),
			},
			episodeFileCache: {
				findMany: vi.fn().mockResolvedValue([]),
			},
		} as never);
		app.decorate("arrClientFactory", {} as never);
		app.decorate("encryptor", {} as never);
		await app.register(registerLibraryCleanupRoutes);
		await app.ready();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
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
				expiresAt: { gt: expect.any(Date) },
			},
			data: {
				status: "approved",
				executionToken: expect.any(String),
				reviewedAt: expect.any(Date),
			},
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
		expect(updateMany.mock.calls[1]?.[0].data.executionToken).toBe(secondToken);
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

	it("uses the qUI sync timestamp as cached preview provenance", async () => {
		const observedAt = new Date();
		vi.mocked(app.prisma.libraryCache.findMany).mockResolvedValueOnce([
			{
				instanceId: "radarr-1",
				arrItemId: 101,
				itemType: "movie",
				infoHash: "cached-hash",
				torrentState: "paused",
				torrentSyncedAt: observedAt,
				cachedAt: new Date(observedAt.getTime() - 5 * 60_000),
			},
		] as never);
		mockPreviewItem();

		const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/preview");

		expect(response.statusCode).toBe(200);
		expect(response.json().items[0]).toMatchObject({
			quiStatus: "paused_or_error",
			quiStatusSource: "cached",
			quiStatusObservedAt: observedAt.toISOString(),
		});
	});

	it("forwards sanitized provider evidence in preview responses", async () => {
		const providerEvidence = {
			version: 1,
			fingerprint: "a".repeat(64),
			sources: [],
		};
		executorMocks.executeCleanupPreview.mockReset().mockResolvedValueOnce({
			isDryRun: true,
			status: "completed",
			itemsEvaluated: 0,
			itemsFlagged: 0,
			itemsRemoved: 0,
			itemsUnmonitored: 0,
			itemsFilesDeleted: 0,
			itemsSkipped: 0,
			details: [],
			durationMs: 1,
			providerEvidence,
		});

		const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/preview");

		expect(response.statusCode).toBe(200);
		expect(response.json().providerEvidence).toEqual(providerEvidence);
	});

	it.each([
		["a null state that was never published", null],
		["a positive state without provenance", "seeding"],
	] as const)("does not surface %s as cached qUI evidence", async (_label, torrentState) => {
		vi.mocked(app.prisma.libraryCache.findMany).mockResolvedValueOnce([
			{
				instanceId: "radarr-1",
				arrItemId: 101,
				itemType: "movie",
				infoHash: "cached-hash",
				torrentState,
				torrentSyncedAt: null,
				cachedAt: new Date(),
			},
		] as never);
		mockPreviewItem();

		const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/preview");

		expect(response.statusCode).toBe(200);
		expect(response.json().items[0]).toMatchObject({
			quiStatus: "no_signal",
			quiStatusSource: null,
			quiStatusObservedAt: null,
		});
	});

	it("surfaces fresh complete-inventory absence as a cached no-match observation", async () => {
		const observedAt = new Date();
		vi.mocked(app.prisma.libraryCache.findMany).mockResolvedValueOnce([
			{
				instanceId: "radarr-1",
				arrItemId: 101,
				itemType: "movie",
				infoHash: "cached-hash",
				torrentState: null,
				torrentSyncedAt: observedAt,
			},
		] as never);
		mockPreviewItem();

		const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/preview");

		expect(response.statusCode).toBe(200);
		expect(response.json().items[0]).toMatchObject({
			quiStatus: "not_in_qui",
			quiStatusSource: "cached",
			quiStatusObservedAt: observedAt.toISOString(),
		});
	});

	it("does not label an ambiguous aggregate qUI state as inactive", async () => {
		vi.mocked(app.prisma.libraryCache.findMany).mockResolvedValueOnce([
			{
				instanceId: "radarr-1",
				arrItemId: 101,
				itemType: "movie",
				infoHash: "cached-hash",
				torrentState: "unknown",
				torrentSyncedAt: new Date(),
			},
		] as never);
		mockPreviewItem();

		const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/preview");

		expect(response.statusCode).toBe(200);
		expect(response.json().items[0]).toMatchObject({
			quiStatus: "no_signal",
			quiStatusSource: null,
			quiStatusObservedAt: null,
		});
	});

	it("ignores retained cache observations when no qUI is enabled", async () => {
		vi.mocked(app.prisma.serviceInstance.findFirst).mockResolvedValueOnce(null);
		mockPreviewItem();

		const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/preview");

		expect(response.statusCode).toBe(200);
		expect(response.json().items[0]).toMatchObject({
			quiStatus: "no_signal",
			quiStatusSource: null,
			quiStatusObservedAt: null,
		});
		expect(app.prisma.libraryCache.findMany).not.toHaveBeenCalled();
	});

	it.each([
		[30 * 60_000, "paused_or_error", "cached"],
		[30 * 60_000 + 1, "no_signal", null],
	] as const)(
		"applies the 30-minute qUI cache boundary at age %i ms",
		async (ageMs, expectedStatus, expectedSource) => {
			const now = new Date("2026-07-30T12:30:00.000Z");
			vi.spyOn(Date, "now").mockReturnValue(now.getTime());
			const observedAt = new Date(now.getTime() - ageMs);
			vi.mocked(app.prisma.libraryCache.findMany).mockResolvedValueOnce([
				{
					instanceId: "radarr-1",
					arrItemId: 101,
					itemType: "movie",
					infoHash: "cached-hash",
					torrentState: "paused",
					torrentSyncedAt: observedAt,
				},
			] as never);
			mockPreviewItem();

			const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/preview");

			expect(response.statusCode).toBe(200);
			expect(response.json().items[0]).toMatchObject({
				quiStatus: expectedStatus,
				quiStatusSource: expectedSource,
				quiStatusObservedAt: expectedSource ? observedAt.toISOString() : null,
			});
		},
	);

	it("uses episode-file cache provenance for episode preview status", async () => {
		const observedAt = new Date();
		vi.mocked(app.prisma.episodeFileCache.findMany).mockResolvedValueOnce([
			{
				instanceId: "sonarr-1",
				arrEpisodeFileId: 301,
				infoHash: "episode-hash",
				torrentState: "seeding",
				torrentSyncedAt: observedAt,
			},
		] as never);
		mockPreviewItem({
			instanceId: "sonarr-1",
			arrItemId: 201,
			itemType: "series",
			targetScope: "episode",
			arrEpisodeId: 901,
			episodeFileId: 301,
		});

		const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/preview");

		expect(response.statusCode).toBe(200);
		expect(response.json().items[0]).toMatchObject({
			quiStatus: "seeding",
			quiStatusSource: "cached",
			quiStatusObservedAt: observedAt.toISOString(),
		});
		expect(app.prisma.libraryCache.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: expect.objectContaining({ instanceId: { in: [] } }) }),
		);
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
				retryState: "complete",
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
			totalFlagged: 201,
			selectionCountsComplete: true,
			warnings: [
				"Existing warning",
				"Display capped at 200 of 201 preview items; selection counts remain complete.",
			],
			display: { shown: 200, hidden: 1, limit: 200, complete: false },
			selection: {
				selectedFresh: 100,
				deferredBudget: 101,
				total: 201,
			},
		});
		expect(response.json().items).toHaveLength(200);
	});

	it("preserves an unknown retry count and qualifies capped totals during an outage", async () => {
		const details = Array.from({ length: 200 }, (_, index) => ({
			instanceId: "radarr-1",
			arrItemId: index + 1,
			itemType: "movie",
			title: `Movie ${index + 1}`,
			ruleId: "rule-1",
			rule: "Cleanup",
			reason: "Durable cleanup retry state could not be loaded",
			action: "skipped" as const,
			previewDisposition: "deferred" as const,
			plannedAction: "delete" as const,
			sizeOnDisk: "1000",
			year: 2024,
			rating: 8,
		}));
		executorMocks.executeCleanupPreview.mockResolvedValueOnce({
			isDryRun: true,
			status: "partial",
			itemsEvaluated: 250,
			itemsFlagged: 250,
			pendingRetryCount: null,
			previewItemCount: 250,
			previewSelection: {
				selectedFresh: 0,
				selectedRetries: 0,
				deferredBudget: 0,
				deferredApproval: 0,
				deferredRetryFairness: 0,
				deferredInFlightTarget: 0,
				deferredDuplicateTarget: 0,
				inFlight: 0,
				blocked: 0,
				retryStateUnavailable: 250,
				retryState: "unavailable",
				total: 250,
			},
			itemsRemoved: 0,
			itemsUnmonitored: 0,
			itemsFilesDeleted: 0,
			itemsSkipped: 250,
			details,
			durationMs: 1,
			warnings: ["Durable cleanup retry state could not be loaded."],
		});

		const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/preview");

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			pendingRetryCount: null,
			selectionCountsComplete: false,
			selection: {
				retryState: "unavailable",
				retryStateUnavailable: 250,
			},
			display: { shown: 200, hidden: 50, limit: 200, complete: false },
			warnings: [
				"Durable cleanup retry state could not be loaded.",
				"Display capped at 200 of 250 known preview items; retry-backed selection counts are incomplete because durable retry state could not be loaded.",
			],
		});
		expect(response.json().warnings.join(" ")).not.toContain("selection counts remain complete");
	});

	it("serializes approval pending and in-flight retry counts without folding pending into total", async () => {
		executorMocks.executeCleanupPreview.mockResolvedValueOnce({
			isDryRun: true,
			status: "partial",
			itemsEvaluated: 1,
			itemsFlagged: 1,
			pendingRetryCount: 1,
			previewItemCount: 2,
			previewSelection: {
				selectedFresh: 1,
				selectedRetries: 0,
				deferredBudget: 0,
				deferredApproval: 0,
				deferredRetryFairness: 0,
				deferredInFlightTarget: 0,
				deferredDuplicateTarget: 0,
				inFlight: 1,
				blocked: 0,
				retryStateUnavailable: 0,
				retryState: "complete",
				total: 2,
			},
			itemsRemoved: 0,
			itemsUnmonitored: 0,
			itemsFilesDeleted: 0,
			itemsSkipped: 1,
			details: [
				{
					instanceId: "radarr-1",
					arrItemId: 101,
					itemType: "movie",
					title: "Fresh movie",
					ruleId: "rule-1",
					rule: "Cleanup",
					reason: "Selected for the next approval run",
					action: "delete",
					previewDisposition: "selected",
					plannedAction: "delete",
					sizeOnDisk: "1000",
					year: 2024,
					rating: 8,
				},
				{
					instanceId: "radarr-1",
					arrItemId: 202,
					itemType: "movie",
					title: "Executing retry",
					ruleId: "rule-1",
					rule: "Cleanup",
					reason: "Another cleanup run is already executing this durable retry",
					action: "skipped",
					previewDisposition: "in_flight",
					plannedAction: "delete",
					isRetryAttempt: true,
					sizeOnDisk: "1000",
					year: 2024,
					rating: 8,
				},
			],
			durationMs: 1,
			warnings: ["1 durable cleanup retry is pending outside the approval-run budget."],
		});

		const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/preview");

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			pendingRetryCount: 1,
			selectionCountsComplete: true,
			selection: {
				selectedFresh: 1,
				selectedRetries: 0,
				inFlight: 1,
				total: 2,
			},
			display: { shown: 2, hidden: 0, limit: 200, complete: true },
			items: [
				expect.objectContaining({ arrItemId: 101, selectionStatus: "selected" }),
				expect.objectContaining({
					arrItemId: 202,
					selectionStatus: "in_flight",
					isRetryAttempt: true,
				}),
			],
		});
	});

	it("preserves the configured retry action for older preview clients", async () => {
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
					previewDisposition: "selected",
					plannedAction: "delete",
					isRetryAttempt: true,
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
			warnings: [],
			items: [
				{
					action: "delete",
					plannedAction: "delete",
					isRetryAttempt: true,
					selectionStatus: "selected",
				},
			],
		});
		expect(response.json().items).toHaveLength(1);
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
			warnings: ["Display capped at 200 of 201 preview items; selection counts remain complete."],
			display: { shown: 200, hidden: 1, limit: 200, complete: false },
		});
		expect(response.json().items).toHaveLength(200);
	});
});
