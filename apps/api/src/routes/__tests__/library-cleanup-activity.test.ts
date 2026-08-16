import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerLibraryCleanupRoutes } from "../library-cleanup.js";
import { createInjectAuthenticated, setupAuthInjection } from "./test-helpers.js";

function auditEvent(
	eventOrder: number,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		eventOrder,
		id: `event-${eventOrder}`,
		configId: "config-a",
		eventKey: `approval-1:attempt-1:${eventOrder}`,
		actionId: "approval-1",
		correlationId: "attempt-1",
		actionSequence: eventOrder,
		actorType: "operator",
		actorId: "user-a",
		eventType: eventOrder === 1 ? "proposal_created" : "succeeded",
		trigger: "approval",
		targetKind: "approval",
		targetId: "approval-1",
		targetInstanceId: "sonarr-main",
		targetItemType: "series",
		targetArrItemId: 42,
		targetArrEpisodeId: 9001,
		targetScope: "episode",
		title: "Signal Harbor S01E02 · First Light",
		ruleId: "rule-episode",
		ruleName: "Watched episodes",
		action: "delete",
		reason: eventOrder === 1 ? "Proposal created" : "Exact episode deleted",
		outcome: eventOrder === 1 ? "info" : "success",
		evidence: JSON.stringify({ authority: "verified" }),
		details: null,
		fingerprint: `fingerprint-${eventOrder}`,
		createdAt: new Date(Date.parse("2026-08-12T12:00:00.000Z") + eventOrder * 1000),
		...overrides,
	};
}

describe("library cleanup activity routes", () => {
	let app: FastifyInstance;
	let groupBy: ReturnType<typeof vi.fn>;
	let findMany: ReturnType<typeof vi.fn>;
	let queryRaw: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		groupBy = vi.fn();
		findMany = vi.fn();
		queryRaw = vi.fn();
		app = Fastify({ logger: false });
		setupAuthInjection(app, { id: "user-a", username: "admin" });
		app.decorate("prisma", {
			$queryRaw: queryRaw,
			libraryCleanupAuditEvent: { groupBy, findMany },
		} as never);
		await app.register(registerLibraryCleanupRoutes);
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
	});

	it("returns bounded user-scoped action timelines separately from run logs", async () => {
		queryRaw.mockResolvedValue([{ total: 1n }]);
		groupBy.mockResolvedValue([
			{
				actionId: "approval-1",
				_count: { _all: 202 },
				_min: { createdAt: new Date("2026-08-12T12:00:00.000Z") },
				_max: { eventOrder: 202 },
			},
		]);
		findMany.mockResolvedValue([auditEvent(202), auditEvent(201)]);

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/library-cleanup/activity?page=2&pageSize=25",
		);

		expect(response.statusCode).toBe(200);
		expect(groupBy).toHaveBeenCalledWith(
			expect.objectContaining({
				by: ["actionId"],
				where: { config: { userId: "user-a" } },
				orderBy: { _max: { eventOrder: "desc" } },
				skip: 25,
				take: 25,
			}),
		);
		expect(findMany).toHaveBeenCalledWith({
			where: {
				config: { userId: "user-a" },
				actionId: "approval-1",
				eventOrder: { lte: 202 },
			},
			orderBy: { eventOrder: "desc" },
			take: 200,
		});
		expect(response.json()).toMatchObject({
			total: 1,
			page: 2,
			pageSize: 25,
			items: [
				{
					actionId: "approval-1",
					targetScope: "episode",
					arrEpisodeId: 9001,
					eventCount: 202,
					eventsTruncated: true,
					olderEventsCursor: "201",
					events: [
						{ id: "201", sequence: 201, actorType: "operator" },
						{ id: "202", sequence: 202, actorType: "operator" },
					],
				},
			],
		});
	});

	it("uses an exclusive database-order cursor and encodes no cross-user access", async () => {
		findMany.mockResolvedValue([auditEvent(250), auditEvent(249), auditEvent(248)]);

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/library-cleanup/activity/approval%2Fone/events?cursor=251&pageSize=2",
		);

		expect(response.statusCode).toBe(200);
		expect(findMany).toHaveBeenCalledWith({
			where: {
				config: { userId: "user-a" },
				actionId: "approval/one",
				eventOrder: { lt: 251 },
			},
			orderBy: { eventOrder: "desc" },
			take: 3,
		});
		expect(response.json()).toMatchObject({
			items: [{ id: "249" }, { id: "250" }],
			olderEventsCursor: "249",
		});
	});

	it("rejects an invalid durable cursor before querying audit history", async () => {
		const response = await createInjectAuthenticated(app)(
			"GET",
			"/library-cleanup/activity/approval-1/events?cursor=0&pageSize=201",
		);

		expect(response.statusCode).toBe(400);
		expect(findMany).not.toHaveBeenCalled();
	});
});
