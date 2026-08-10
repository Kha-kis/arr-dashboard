import Fastify, { type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deploymentHistoryRoutes } from "../deployment-history-routes.js";

const USER_ID = "user-1";
const HISTORY_ID = "deployment-1";

function deploymentHistory(overrides: Record<string, unknown> = {}) {
	return {
		id: HISTORY_ID,
		userId: USER_ID,
		instanceId: "instance-1",
		status: "SUCCESS",
		rolledBack: false,
		undeployStatus: null,
		undeployAttemptedAt: null,
		undeployProgress: null,
		templateSnapshot: JSON.stringify({ customFormats: [{ name: "Owned CF" }] }),
		instance: { id: "instance-1", userId: USER_ID, service: "RADARR" },
		template: {
			id: "template-1",
			name: "Template",
			userId: USER_ID,
			configData: JSON.stringify({ customFormats: [{ name: "Owned CF" }] }),
		},
		...overrides,
	};
}

describe("POST /history/:historyId/undeploy state coordination", () => {
	let app: ReturnType<typeof Fastify>;
	let findFirst: ReturnType<typeof vi.fn>;
	let findMany: ReturnType<typeof vi.fn>;
	let updateMany: ReturnType<typeof vi.fn>;
	let createClient: ReturnType<typeof vi.fn>;
	let getAll: ReturnType<typeof vi.fn>;
	let deleteFormat: ReturnType<typeof vi.fn>;
	let events: string[];

	beforeEach(async () => {
		events = [];
		findFirst = vi.fn().mockResolvedValue(deploymentHistory());
		findMany = vi.fn().mockResolvedValue([]);
		updateMany = vi.fn().mockImplementation(async ({ data }) => {
			events.push(`db:${data.undeployStatus}`);
			return { count: 1 };
		});
		getAll = vi.fn().mockImplementation(async () => {
			events.push("arr:getAll");
			return [{ id: 42, name: "Owned CF" }];
		});
		deleteFormat = vi.fn().mockImplementation(async () => {
			events.push("arr:delete");
		});

		app = Fastify({ logger: false });
		app.decorateRequest("currentUser", null);
		app.addHook("preHandler", async (request: FastifyRequest) => {
			request.currentUser = { id: USER_ID } as never;
		});
		app.decorate("prisma", {
			templateDeploymentHistory: {
				findFirst,
				findMany,
				updateMany,
			},
		} as never);
		createClient = vi.fn().mockImplementation(() => {
			events.push("arr:createClient");
			return {
				system: { get: vi.fn().mockResolvedValue({}) },
				customFormat: { getAll, delete: deleteFormat },
			};
		});
		app.decorate("arrClientFactory", { create: createClient } as never);

		await app.register(deploymentHistoryRoutes, {
			prefix: "/api/trash-guides/deployment",
		});
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
	});

	it("claims undeploy before creating a client or reading from ARR", async () => {
		const response = await app.inject({
			method: "POST",
			url: `/api/trash-guides/deployment/history/${HISTORY_ID}/undeploy`,
		});

		expect(response.statusCode).toBe(200);
		const claim = updateMany.mock.calls[0]?.[0];
		expect(claim).toEqual({
			where: {
				id: HISTORY_ID,
				userId: USER_ID,
				rolledBack: false,
				OR: [{ undeployStatus: null }, { undeployStatus: "PARTIAL" }],
			},
			data: {
				undeployStatus: "IN_PROGRESS",
				undeployAttemptedAt: expect.any(Date),
				undeployProgress: expect.any(String),
			},
		});
		expect(events.indexOf("db:IN_PROGRESS")).toBeLessThan(events.indexOf("arr:createClient"));
		expect(events.indexOf("db:IN_PROGRESS")).toBeLessThan(events.indexOf("arr:getAll"));
		expect(events.at(-1)).toBe("db:COMPLETED");
	});

	it("persists retryable PARTIAL progress when a Custom Format deletion fails", async () => {
		deleteFormat.mockRejectedValueOnce(new Error("ARR delete failed"));

		const response = await app.inject({
			method: "POST",
			url: `/api/trash-guides/deployment/history/${HISTORY_ID}/undeploy`,
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual(expect.objectContaining({ success: false }));
		const attemptedAt = updateMany.mock.calls[0]?.[0].data.undeployAttemptedAt;
		const partialWrite = updateMany.mock.calls.find(
			([args]) => args.data.undeployStatus === "PARTIAL",
		)?.[0];
		expect(partialWrite).toEqual({
			where: {
				id: HISTORY_ID,
				userId: USER_ID,
				undeployStatus: "IN_PROGRESS",
				undeployAttemptedAt: attemptedAt,
			},
			data: {
				status: "PARTIAL_UNDEPLOY",
				undeployStatus: "PARTIAL",
				undeployProgress: expect.any(String),
				errors: expect.any(String),
			},
		});
	});

	it("persists retryable PARTIAL state after an unexpected upstream failure", async () => {
		getAll.mockRejectedValueOnce(new Error("ARR read failed"));

		const response = await app.inject({
			method: "POST",
			url: `/api/trash-guides/deployment/history/${HISTORY_ID}/undeploy`,
		});

		expect(response.statusCode).toBe(500);
		const partialWrite = updateMany.mock.calls.find(
			([args]) => args.data.undeployStatus === "PARTIAL",
		)?.[0];
		expect(partialWrite).toBeDefined();
		expect(JSON.parse(partialWrite.data.undeployProgress)).toEqual([
			expect.objectContaining({ status: "PARTIAL", errors: ["ARR read failed"] }),
		]);
	});

	it("fails closed without ARR access when another undeploy owns the claim", async () => {
		updateMany.mockResolvedValueOnce({ count: 0 });

		const response = await app.inject({
			method: "POST",
			url: `/api/trash-guides/deployment/history/${HISTORY_ID}/undeploy`,
		});

		expect(response.statusCode).toBe(409);
		expect(createClient).not.toHaveBeenCalled();
		expect(updateMany).toHaveBeenCalledTimes(1);
	});

	it("fails closed when another active deployment cannot be evaluated safely", async () => {
		findMany.mockResolvedValueOnce([
			{ templateSnapshot: "not-json", template: { configData: null } },
		]);

		const response = await app.inject({
			method: "POST",
			url: `/api/trash-guides/deployment/history/${HISTORY_ID}/undeploy`,
		});

		expect(response.statusCode).toBe(500);
		expect(deleteFormat).not.toHaveBeenCalled();
		expect(createClient).not.toHaveBeenCalled();
		expect(updateMany.mock.calls.some(([args]) => args.data.undeployStatus === "PARTIAL")).toBe(
			true,
		);
	});

	it("falls back to PARTIAL when terminal persistence fails after ARR mutation", async () => {
		updateMany
			.mockResolvedValueOnce({ count: 1 })
			.mockRejectedValueOnce(new Error("terminal DB failed"))
			.mockResolvedValueOnce({ count: 1 });

		const response = await app.inject({
			method: "POST",
			url: `/api/trash-guides/deployment/history/${HISTORY_ID}/undeploy`,
		});

		expect(response.statusCode).toBe(207);
		expect(deleteFormat).toHaveBeenCalledTimes(1);
		expect(updateMany.mock.calls[2]?.[0]).toEqual(
			expect.objectContaining({ data: expect.objectContaining({ undeployStatus: "PARTIAL" }) }),
		);
	});
});
