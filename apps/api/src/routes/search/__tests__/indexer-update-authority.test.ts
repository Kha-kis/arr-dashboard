import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const helpers = vi.hoisted(() => ({
	getClientForInstance: vi.fn(),
	isProwlarrClient: vi.fn(),
}));
const api = vi.hoisted(() => ({
	updateProwlarrIndexerWithSdk: vi.fn(),
	fetchProwlarrIndexerDetailsWithSdk: vi.fn(),
}));
vi.mock("../../../lib/arr/client-helpers.js", () => ({ ...helpers }));
vi.mock("../../../lib/search/prowlarr-api.js", async (importOriginal) => ({
	...(await importOriginal<object>()),
	...api,
}));

import Fastify from "fastify";
import { IndexerUpdateDispatchError } from "../../../lib/search/prowlarr-api.js";
import { registerIndexerRoutes } from "../indexer-routes.js";

const validBody = { changes: { enable: false } };
const details = {
	id: 7,
	name: "synthetic",
	enable: false,
	instanceId: "owned-instance",
	instanceName: "synthetic",
};

let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
	vi.clearAllMocks();
	app = Fastify();
	app.decorateRequest("currentUser", null);
	app.addHook("preHandler", async (request: any) => {
		request.currentUser = { id: "user-1" };
	});
	helpers.getClientForInstance.mockResolvedValue({
		success: true,
		client: { indexer: {} },
		instance: { id: "owned-instance", label: "synthetic", baseUrl: "http://example.invalid" },
	});
	helpers.isProwlarrClient.mockReturnValue(true);
	api.fetchProwlarrIndexerDetailsWithSdk.mockResolvedValue(details);
	await app.register(registerIndexerRoutes, { prefix: "/api" });
	await app.ready();
});

afterEach(async () => {
	await app.close();
});

describe("Prowlarr update target authority", () => {
	it.each([
		["body instance selector", { instanceId: "other-instance", ...validBody }],
		["nested full indexer", { ...validBody, indexer: details }],
		["empty change set", { changes: {} }],
	])("rejects %s before provider access", async (_name, payload) => {
		const response = await app.inject({
			method: "PUT",
			url: "/api/search/indexers/owned-instance/7",
			payload,
		});
		expect(response.statusCode).toBe(400);
		expect(helpers.getClientForInstance).not.toHaveBeenCalled();
		expect(api.updateProwlarrIndexerWithSdk).not.toHaveBeenCalled();
	});

	it("uses the URL-owned instance for a valid update", async () => {
		const response = await app.inject({
			method: "PUT",
			url: "/api/search/indexers/owned-instance/7",
			payload: validBody,
		});
		expect(response.statusCode).toBe(200);
		expect(helpers.getClientForInstance).toHaveBeenCalledOnce();
		expect(helpers.getClientForInstance.mock.calls[0]?.[2]).toBe("owned-instance");
		expect(api.updateProwlarrIndexerWithSdk).toHaveBeenCalledOnce();
	});

	it("does not claim verification after an accepted write if the readback fails", async () => {
		api.fetchProwlarrIndexerDetailsWithSdk.mockResolvedValueOnce(null);
		const response = await app.inject({
			method: "PUT",
			url: "/api/search/indexers/owned-instance/7",
			payload: validBody,
		});
		expect(response.statusCode).toBe(202);
		expect(JSON.parse(response.payload)).toEqual({ status: "applied-unverified" });
		expect(api.updateProwlarrIndexerWithSdk).toHaveBeenCalledOnce();
	});

	it("does not claim verification when readback retains the old requested value", async () => {
		api.fetchProwlarrIndexerDetailsWithSdk.mockResolvedValueOnce({ ...details, enable: true });
		const response = await app.inject({
			method: "PUT",
			url: "/api/search/indexers/owned-instance/7",
			payload: validBody,
		});
		expect(response.statusCode).toBe(202);
		expect(JSON.parse(response.payload)).toEqual({ status: "applied-unverified" });
	});

	it("does not claim verification when a changed field is absent from readback", async () => {
		const response = await app.inject({
			method: "PUT",
			url: "/api/search/indexers/owned-instance/7",
			payload: { changes: { fields: [{ name: "host", value: "changed" }] } },
		});
		expect(response.statusCode).toBe(202);
		expect(JSON.parse(response.payload)).toEqual({ status: "applied-unverified" });
	});

	it("serializes concurrent indexer writes across configured aliases", async () => {
		let releaseFirst!: () => void;
		const firstWrite = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		api.updateProwlarrIndexerWithSdk.mockImplementationOnce(() => firstWrite);
		const first = app.inject({
			method: "PUT",
			url: "/api/search/indexers/owned-instance/7",
			payload: validBody,
		});
		try {
			await vi.waitFor(() => expect(api.updateProwlarrIndexerWithSdk).toHaveBeenCalledTimes(1));
			const second = app.inject({
				method: "PUT",
				url: "/api/search/indexers/alias-instance/7",
				payload: { changes: { priority: 8 } },
			});
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(api.updateProwlarrIndexerWithSdk).toHaveBeenCalledTimes(1);
			releaseFirst();
			await Promise.all([first, second]);
			expect(api.updateProwlarrIndexerWithSdk).toHaveBeenCalledTimes(2);
		} finally {
			releaseFirst();
		}
	});

	it("does not retry an ambiguous provider write", async () => {
		api.updateProwlarrIndexerWithSdk.mockRejectedValueOnce(
			new IndexerUpdateDispatchError(new Error("synthetic lost response")),
		);
		const response = await app.inject({
			method: "PUT",
			url: "/api/search/indexers/owned-instance/7",
			payload: validBody,
		});
		expect(response.statusCode).toBe(202);
		expect(JSON.parse(response.payload)).toEqual({ status: "outcome-unknown" });
		expect(api.updateProwlarrIndexerWithSdk).toHaveBeenCalledOnce();
		expect(api.fetchProwlarrIndexerDetailsWithSdk).not.toHaveBeenCalled();
	});
});
