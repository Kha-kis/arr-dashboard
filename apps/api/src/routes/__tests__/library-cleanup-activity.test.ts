import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const executorMocks = vi.hoisted(() => ({
	buildEvalContextWithHealth: vi.fn(),
	CleanupPolicyMutationConflictError: class CleanupPolicyMutationConflictError extends Error {},
	CleanupRunAlreadyInProgressError: class CleanupRunAlreadyInProgressError extends Error {},
	executeApprovedItems: vi.fn(),
	executeCleanupPreview: vi.fn(),
	executeCleanupRun: vi.fn(),
	executeRetryItems: vi.fn(),
	extractSeriesTmdbId: vi.fn(),
	prefetchFreshPlexEpisodeWatchData: vi.fn(),
	withCleanupPolicyMutationLease: vi.fn(),
	episodeCoordinateKey: vi.fn(),
}));

vi.mock("../../lib/library-cleanup/cleanup-executor.js", () => executorMocks);

import { registerLibraryCleanupRoutes } from "../library-cleanup.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

function event(
	id: number,
	actionId: string,
	eventType: string,
	createdAt: string,
	sequence: number,
	outcome: "info" | "success" | "blocked" | "failed" = "info",
) {
	return {
		id,
		configId: "config-1",
		actionId,
		correlationId: "run-1",
		eventKey: `${actionId}:${eventType}`,
		sequence,
		eventType,
		outcome,
		trigger: "scheduled",
		actorType: "scheduler",
		actorId: null,
		approvalId: null,
		runLogId: "run-1",
		instanceId: "radarr-1",
		arrItemId: actionId === "action-1" ? 42 : 43,
		itemType: "movie",
		targetScope: "series",
		arrEpisodeId: null,
		title: actionId === "action-1" ? "Example One" : "Example Two",
		ruleId: "rule-1",
		ruleName: "Unwatched",
		action: "delete",
		reason: eventType === "safety_blocked" ? "Shared media safety blocked deletion" : "Matched",
		evidence: '{"verified":true}',
		details: null,
		createdAt: new Date(createdAt),
	};
}

describe("library cleanup activity route", () => {
	let app: ReturnType<typeof Fastify>;
	const findMany = vi.fn();
	const groupBy = vi.fn();
	const queryRaw = vi.fn();
	const auditCreate = vi.fn().mockResolvedValue({});
	let availableEvents: ReturnType<typeof event>[] = [];
	const approvalFindMany = vi.fn();
	const approvalFindFirst = vi.fn();
	const approvalUpdateMany = vi.fn();
	let expiredCount = 0;
	const approval = {
		id: "approval-expired",
		configId: "config-1",
		instanceId: "radarr-1",
		arrItemId: 44,
		itemType: "movie",
		targetScope: "series",
		arrEpisodeId: null,
		title: "Expired Example",
		matchedRuleId: "rule-1",
		matchedRuleName: "Unwatched",
		reason: "Matched",
		action: "delete",
		sizeOnDisk: 1000n,
		year: 2024,
		rating: 8,
		status: "pending",
		lastExecutionError: null,
		reviewedAt: null,
		executedAt: null,
		createdAt: new Date("2026-07-29T12:00:00Z"),
		expiresAt: new Date("2026-07-30T12:00:00Z"),
	};

	beforeEach(async () => {
		vi.clearAllMocks();
		expiredCount = 0;
		approvalUpdateMany.mockImplementation(
			async ({ where }: { where: { expiresAt?: { lte?: Date } } }) => ({
				count: where.expiresAt?.lte ? expiredCount : 1,
			}),
		);
		executorMocks.executeApprovedItems.mockResolvedValue({ removed: 1, failed: 0, errors: [] });
		approvalFindFirst.mockImplementation(
			async ({
				where,
			}: {
				where: { status: string; executionToken?: string; reviewedAt?: Date };
			}) => ({
				...approval,
				status: where.status,
				executionToken: where.executionToken ?? null,
				reviewedAt: where.reviewedAt ?? new Date(),
			}),
		);
		approvalFindMany.mockImplementation(
			async ({ where }: { where: { expiresAt?: unknown; status?: string; OR?: unknown } }) =>
				where.expiresAt || where.OR
					? [approval]
					: [{ ...approval, status: where.status ?? "expired" }],
		);
		availableEvents = [
			event(1, "action-1", "candidate_selected", "2026-07-30T12:01:00Z", 10),
			event(2, "action-1", "terminal_succeeded", "2026-07-30T12:02:00Z", 40, "success"),
			event(3, "action-2", "safety_blocked", "2026-07-30T12:03:00Z", 20, "blocked"),
		];
		findMany.mockImplementation(
			async ({
				where,
				orderBy,
				take,
			}: {
				where: { actionId: string; id?: { lt: number } };
				orderBy: { id: "asc" | "desc" };
				take: number;
			}) =>
				availableEvents
					.filter((candidate) => candidate.actionId === where.actionId)
					.filter((candidate) => where.id == null || candidate.id < where.id.lt)
					.sort((left, right) => (orderBy.id === "asc" ? left.id - right.id : right.id - left.id))
					.slice(0, take),
		);
		groupBy.mockResolvedValue([
			{
				actionId: "action-2",
				_max: { id: 3 },
				_min: { createdAt: new Date("2026-07-30T12:03:00Z") },
				_count: { _all: 1 },
			},
			{
				actionId: "action-1",
				_max: { id: 2 },
				_min: { createdAt: new Date("2026-07-30T12:01:00Z") },
				_count: { _all: 2 },
			},
		]);
		queryRaw.mockResolvedValue([{ total: 2n }]);
		app = Fastify();
		setupAuthInjection(app);
		registerTestErrorHandler(app);
		app.decorate("prisma", {
			$queryRaw: queryRaw,
			libraryCleanupAuditEvent: {
				findMany,
				groupBy,
				create: auditCreate,
				deleteMany: vi.fn(),
			},
			libraryCleanupApproval: {
				findFirst: approvalFindFirst,
				findMany: approvalFindMany,
				updateMany: approvalUpdateMany,
				count: vi.fn().mockResolvedValue(1),
			},
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue([{ id: "radarr-1", label: "Radarr" }]),
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

	it("groups events by stable action and scopes the query to the authenticated user", async () => {
		const response = await createInjectAuthenticated(app)(
			"GET",
			"/library-cleanup/activity?page=1&pageSize=20",
		);

		expect(response.statusCode).toBe(200);
		expect(findMany).toHaveBeenCalledTimes(2);
		expect(findMany).toHaveBeenCalledWith({
			where: { config: { userId: "user-1" }, actionId: "action-2" },
			orderBy: { id: "desc" },
			take: 200,
		});
		expect(response.json()).toMatchObject({
			total: 2,
			items: [
				{
					actionId: "action-2",
					latestOutcome: "blocked",
					actionableReason: "Shared media safety blocked deletion",
				},
				{
					actionId: "action-1",
					latestOutcome: "success",
					events: [
						{ id: "1", eventType: "candidate_selected", evidence: { verified: true } },
						{ id: "2", eventType: "terminal_succeeded" },
					],
				},
			],
		});
		expect(response.json().items[0]).not.toHaveProperty("isDryRun");
	});

	it("uses durable event ids when multiple attempts share the same timestamp", async () => {
		const sameSecond = "2026-07-30T12:03:00Z";
		availableEvents = [
			event(10, "action-1", "retry_pending", sameSecond, 80, "failed"),
			event(11, "action-1", "execution_claimed", sameSecond, 40),
			event(12, "action-1", "terminal_succeeded", sameSecond, 80, "success"),
		];
		groupBy.mockResolvedValue([
			{
				actionId: "action-1",
				_max: { id: 12 },
				_min: { createdAt: new Date(sameSecond) },
				_count: { _all: 3 },
			},
		]);
		queryRaw.mockResolvedValue([{ total: 1n }]);

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/library-cleanup/activity?page=1&pageSize=20",
		);

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			items: [
				{
					latestOutcome: "success",
					events: [
						{ id: "10", eventType: "retry_pending" },
						{ id: "11", eventType: "execution_claimed" },
						{ id: "12", eventType: "terminal_succeeded" },
					],
				},
			],
		});
	});

	it("paginates a large history by action before loading only the requested timelines", async () => {
		const actionIds = Array.from({ length: 20 }, (_, index) => `action-${49_981 + index}`);
		groupBy.mockResolvedValue(
			actionIds.map((actionId, index) => ({
				actionId,
				_max: { id: 100_000 - index },
				_min: { createdAt: new Date("2026-07-30T12:03:00Z") },
				_count: { _all: 1 },
			})),
		);
		queryRaw.mockResolvedValue([{ total: 50_000n }]);
		availableEvents = actionIds.map((actionId, index) => ({
			...event(200_000 + index, actionId, "terminal_succeeded", "2026-07-30T12:03:00Z", index),
			actionId,
		}));

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/library-cleanup/activity?page=2500&pageSize=20",
		);

		expect(response.statusCode).toBe(200);
		expect(groupBy).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { config: { userId: "user-1" } },
				skip: 49_980,
				take: 20,
			}),
		);
		expect(findMany).toHaveBeenCalledTimes(20);
		expect(response.json()).toMatchObject({ total: 50_000, page: 2500, pageSize: 20 });
		expect(response.json().items).toHaveLength(20);
	});

	it("caps a single timeline with thousands of events in deterministic chronological order", async () => {
		availableEvents = Array.from({ length: 5_000 }, (_, index) =>
			event(
				index + 1,
				"action-huge",
				index === 4_999 ? "retry_pending" : "mutation_prepared",
				"2026-07-30T12:03:00Z",
				index + 1,
				index === 4_999 ? "failed" : "info",
			),
		);
		groupBy.mockResolvedValue([
			{
				actionId: "action-huge",
				_max: { id: 5_000 },
				_min: { createdAt: new Date("2026-07-30T12:03:00Z") },
				_count: { _all: 5_000 },
			},
		]);
		queryRaw.mockResolvedValue([{ total: 1n }]);

		const response = await createInjectAuthenticated(app)("GET", "/library-cleanup/activity");

		expect(response.statusCode).toBe(200);
		expect(findMany).toHaveBeenCalledWith({
			where: { config: { userId: "user-1" }, actionId: "action-huge" },
			orderBy: { id: "desc" },
			take: 200,
		});
		const [timeline] = response.json().items;
		expect(timeline).toMatchObject({
			eventCount: 5_000,
			eventsTruncated: true,
			olderEventsCursor: "4801",
		});
		expect(timeline.events).toHaveLength(200);
		expect(timeline.events[0].id).toBe("4801");
		expect(timeline.events[199].id).toBe("5000");
	});

	it("loads every retained event beyond 200 without duplicates or ordering loss", async () => {
		availableEvents = Array.from({ length: 450 }, (_, index) =>
			event(
				index + 1,
				"action-long",
				`audit_event_${index + 1}`,
				"2026-07-30T12:03:00Z",
				index + 1,
			),
		);
		groupBy.mockResolvedValue([
			{
				actionId: "action-long",
				_max: { id: 450 },
				_min: { createdAt: new Date("2026-07-30T12:03:00Z") },
				_count: { _all: 450 },
			},
		]);
		queryRaw.mockResolvedValue([{ total: 1n }]);

		const initialResponse = await createInjectAuthenticated(app)(
			"GET",
			"/library-cleanup/activity?page=1&pageSize=20",
		);
		const [initialTimeline] = initialResponse.json().items;
		expect(initialTimeline.events.map((item: { id: string }) => item.id)).toEqual(
			Array.from({ length: 200 }, (_, index) => String(index + 251)),
		);
		expect(initialTimeline.olderEventsCursor).toBe("251");

		const secondResponse = await createInjectAuthenticated(app)(
			"GET",
			"/library-cleanup/activity/action-long/events?cursor=251&pageSize=200",
		);
		expect(secondResponse.statusCode).toBe(200);
		expect(findMany).toHaveBeenLastCalledWith({
			where: {
				config: { userId: "user-1" },
				actionId: "action-long",
				id: { lt: 251 },
			},
			orderBy: { id: "desc" },
			take: 201,
		});
		const secondPage = secondResponse.json();
		expect(secondPage.items.map((item: { id: string }) => item.id)).toEqual(
			Array.from({ length: 200 }, (_, index) => String(index + 51)),
		);
		expect(secondPage.olderEventsCursor).toBe("51");

		const finalResponse = await createInjectAuthenticated(app)(
			"GET",
			"/library-cleanup/activity/action-long/events?cursor=51&pageSize=200",
		);
		expect(finalResponse.statusCode).toBe(200);
		const finalPage = finalResponse.json();
		expect(finalPage.items.map((item: { id: string }) => item.id)).toEqual(
			Array.from({ length: 50 }, (_, index) => String(index + 1)),
		);
		expect(finalPage.olderEventsCursor).toBeNull();

		const allIds = [...finalPage.items, ...secondPage.items, ...initialTimeline.events].map(
			(item: { id: string }) => item.id,
		);
		expect(allIds).toEqual(Array.from({ length: 450 }, (_, index) => String(index + 1)));
		expect(new Set(allIds).size).toBe(450);
	});

	it("rejects invalid event cursors and caps event page sizes", async () => {
		const invalidCursor = await createInjectAuthenticated(app)(
			"GET",
			"/library-cleanup/activity/action-1/events?cursor=not-an-id",
		);
		expect(invalidCursor.statusCode).toBe(400);

		const oversizedPage = await createInjectAuthenticated(app)(
			"GET",
			"/library-cleanup/activity/action-1/events?cursor=2&pageSize=201",
		);
		expect(oversizedPage.statusCode).toBe(400);
	});

	it("derives expired presentation without authoritative writes or audit side effects", async () => {
		expiredCount = 1;
		approvalUpdateMany.mockRejectedValue(new Error("writes unavailable"));
		auditCreate.mockRejectedValue(new Error("audit unavailable"));
		const response = await createInjectAuthenticated(app)(
			"GET",
			"/library-cleanup/approval-queue?status=expired",
		);

		expect(response.statusCode).toBe(200);
		expect(approvalUpdateMany).not.toHaveBeenCalled();
		expect(auditCreate).not.toHaveBeenCalled();
		expect(response.json()).toMatchObject({
			items: [{ id: "approval-expired", status: "expired" }],
		});
	});

	it("does not let a stale client reject an expired pending approval", async () => {
		approvalUpdateMany.mockResolvedValueOnce({ count: 0 });
		approvalFindFirst.mockResolvedValueOnce(null);

		const response = await createInjectAuthenticated(app)(
			"POST",
			"/library-cleanup/approval-queue/approval-expired/reject",
		);

		expect(response.statusCode).toBe(404);
		expect(approvalUpdateMany).toHaveBeenCalledWith({
			where: {
				id: "approval-expired",
				config: { userId: "user-1" },
				status: "pending",
				expiresAt: { gt: expect.any(Date) },
			},
			data: { status: "rejected", executionToken: null, reviewedAt: expect.any(Date) },
		});
		expect(auditCreate).not.toHaveBeenCalled();
	});

	it("does not let a stale bulk request reject expired pending approvals", async () => {
		approvalUpdateMany.mockResolvedValueOnce({ count: 0 });
		approvalFindFirst.mockResolvedValue(null);

		const response = await createInjectAuthenticated(app)(
			"POST",
			"/library-cleanup/approval-queue/bulk",
			{ body: { ids: ["approval-expired"], action: "rejected" } },
		);

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ updated: 0 });
		expect(approvalUpdateMany).toHaveBeenCalledWith({
			where: {
				id: { in: ["approval-expired"] },
				config: { userId: "user-1" },
				status: "pending",
				expiresAt: { gt: expect.any(Date) },
			},
			data: { status: "rejected", executionToken: null, reviewedAt: expect.any(Date) },
		});
		expect(auditCreate).not.toHaveBeenCalled();
	});

	it.each([
		["approve", "POST", "/library-cleanup/approval-queue/approval-expired/approve", undefined, 200],
		["reject", "POST", "/library-cleanup/approval-queue/approval-expired/reject", undefined, 204],
		[
			"bulk reject",
			"POST",
			"/library-cleanup/approval-queue/bulk",
			{ ids: ["approval-expired"], action: "rejected" },
			200,
		],
	] as const)(
		"keeps the authoritative %s result when audit enrichment reads fail",
		async (_label, method, url, body, expectedStatus) => {
			approvalFindFirst.mockRejectedValue(new Error("audit enrichment unavailable"));

			const response = await createInjectAuthenticated(app)(
				method,
				url,
				body ? { body } : undefined,
			);

			expect(response.statusCode).toBe(expectedStatus);
		},
	);

	it("executes an approved action when the audit append fails", async () => {
		auditCreate.mockRejectedValue(new Error("audit append unavailable"));

		const response = await createInjectAuthenticated(app)(
			"POST",
			"/library-cleanup/approval-queue/approval-expired/approve",
		);

		expect(response.statusCode).toBe(200);
		expect(executorMocks.executeApprovedItems).toHaveBeenCalledOnce();
	});
});
