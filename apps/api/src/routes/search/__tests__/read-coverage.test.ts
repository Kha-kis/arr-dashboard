import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { executeOnInstances } = vi.hoisted(() => ({ executeOnInstances: vi.fn() }));
vi.mock("../../../lib/arr/client-helpers.js", () => ({
	executeOnInstances,
	isProwlarrClient: vi.fn(),
	getClientForInstance: vi.fn(),
}));

import Fastify from "fastify";
import { registerIndexerRoutes } from "../indexer-routes.js";
import { registerQueryRoutes } from "../query-routes.js";

let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
	vi.clearAllMocks();
	app = Fastify();
	app.decorateRequest("currentUser", null);
	app.addHook("preHandler", async (request: any) => {
		request.currentUser = { id: "user-1" };
	});
	await app.register(registerIndexerRoutes, { prefix: "/api" });
	await app.register(registerQueryRoutes, { prefix: "/api" });
	await app.ready();
});

afterAll(async () => {
	await app?.close();
});

const failedRead = {
	instances: [
		{
			instanceId: "prowlarr-1",
			instanceName: "Prowlarr",
			service: "prowlarr",
			success: false,
			statusCode: 502,
			error: "provider unavailable",
		},
	],
	aggregated: [],
	totalCount: 0,
	errorCount: 1,
};

describe("Prowlarr read coverage", () => {
	it("counts a selected instance that disappeared before search without disclosing it", async () => {
		executeOnInstances.mockResolvedValueOnce({
			instances: [],
			aggregated: [],
			totalCount: 0,
			errorCount: 0,
		});
		const response = await app.inject({
			method: "POST",
			url: "/api/search/query",
			payload: {
				query: "synthetic",
				filters: [{ instanceId: "stale-selected-id", indexerIds: [1] }],
			},
		});
		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.payload)).toMatchObject({
			instances: [],
			totalCount: 0,
			failedInstanceCount: 1,
		});
		expect(response.payload).not.toContain("stale-selected-id");
	});

	it.each([
		{ method: "GET" as const, url: "/api/search/indexers", payload: undefined },
		{ method: "POST" as const, url: "/api/search/query", payload: { query: "synthetic" } },
	])("marks a miswired Prowlarr client unavailable for $url", async ({ method, url, payload }) => {
		executeOnInstances.mockImplementationOnce(async (_app, _userId, _options, operation) => {
			await expect(operation({}, { id: "prowlarr-1" })).rejects.toThrow("Prowlarr");
			return failedRead;
		});
		const response = await app.inject({ method, url, payload });
		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.payload).failedInstanceCount).toBe(1);
	});

	it("does not report a failed indexer read as a verified empty list", async () => {
		executeOnInstances.mockResolvedValueOnce(failedRead);
		const response = await app.inject({ method: "GET", url: "/api/search/indexers" });
		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.payload)).toMatchObject({
			failedInstanceCount: 1,
			instances: [{ success: false, data: [] }],
		});
	});

	it("does not report a failed search as verified no results", async () => {
		executeOnInstances.mockResolvedValueOnce(failedRead);
		const response = await app.inject({
			method: "POST",
			url: "/api/search/query",
			payload: { query: "synthetic" },
		});
		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.payload)).toMatchObject({
			failedInstanceCount: 1,
			instances: [{ success: false, data: [] }],
		});
	});
});
