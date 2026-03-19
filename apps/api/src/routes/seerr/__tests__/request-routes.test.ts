import { vi, describe, it, expect, beforeEach, afterAll } from "vitest";

// ---------------------------------------------------------------------------
// Module-level mocks — vi.hoisted ensures these exist before vi.mock factories
// ---------------------------------------------------------------------------

const { mockClient } = vi.hoisted(() => ({
	mockClient: {
		getRequests: vi.fn(),
		getRequestCount: vi.fn(),
		getRequest: vi.fn(),
		approveRequest: vi.fn(),
		declineRequest: vi.fn(),
		deleteRequest: vi.fn(),
		retryRequest: vi.fn(),
		enrichRequestsWithMedia: vi.fn(),
	},
}));

vi.mock("../../../lib/seerr/seerr-client.js", () => ({
	requireSeerrClient: vi.fn().mockResolvedValue(mockClient),
}));

vi.mock("../../../lib/seerr/seerr-action-logger.js", () => ({
	logSeerrAction: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import Fastify from "fastify";
import { registerRequestRoutes } from "../request-routes.js";
import { requireSeerrClient } from "../../../lib/seerr/seerr-client.js";
import { logSeerrAction } from "../../../lib/seerr/seerr-action-logger.js";

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

const sampleRequest = {
	id: 1,
	status: 1,
	createdAt: "2024-01-01",
	updatedAt: "2024-01-01",
	type: "movie",
	is4k: false,
	serverId: 1,
	profileId: 1,
	rootFolder: "/movies",
	media: { id: 1, tmdbId: 123, tvdbId: null, status: 1, mediaType: "movie" },
	requestedBy: { id: 1, displayName: "user" },
	modifiedBy: null,
	seasons: [],
};

const samplePageResult = {
	pageInfo: { pages: 1, pageSize: 20, results: 1, page: 1 },
	results: [sampleRequest],
};

// ---------------------------------------------------------------------------
// Fastify setup
// ---------------------------------------------------------------------------

let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
	vi.clearAllMocks();

	// Reset requireSeerrClient to default resolved mock client
	vi.mocked(requireSeerrClient).mockResolvedValue(mockClient as any);

	app = Fastify();

	// Fake auth — every request gets a currentUser
	app.decorateRequest("currentUser", null);
	app.addHook("preHandler", async (req: any) => {
		req.currentUser = { id: "user-1" };
	});

	await app.register(registerRequestRoutes, { prefix: "/api/seerr/requests" });
	await app.ready();
});

afterAll(async () => {
	await app?.close();
});

// ===========================================================================
// GET /:instanceId — List requests (paginated)
// ===========================================================================

describe("GET /:instanceId", () => {
	it("returns paginated requests with default params", async () => {
		mockClient.getRequests.mockResolvedValueOnce(samplePageResult);
		mockClient.enrichRequestsWithMedia.mockResolvedValueOnce(samplePageResult);

		const res = await app.inject({
			method: "GET",
			url: "/api/seerr/requests/inst-1",
		});

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.payload)).toEqual(samplePageResult);

		expect(mockClient.getRequests).toHaveBeenCalledWith({
			take: 20,
			skip: 0,
			filter: "all",
			sort: "added",
		});
		expect(mockClient.enrichRequestsWithMedia).toHaveBeenCalledWith(samplePageResult);
	});

	it("forwards custom filter/sort/take params", async () => {
		mockClient.getRequests.mockResolvedValueOnce(samplePageResult);
		mockClient.enrichRequestsWithMedia.mockResolvedValueOnce(samplePageResult);

		await app.inject({
			method: "GET",
			url: "/api/seerr/requests/inst-1?filter=pending&sort=modified&take=10",
		});

		expect(mockClient.getRequests).toHaveBeenCalledWith({
			filter: "pending",
			sort: "modified",
			take: 10,
			skip: 0,
		});
	});

	it("returns error when requireSeerrClient rejects", async () => {
		const error = Object.assign(new Error("Instance not found"), { statusCode: 404 });
		vi.mocked(requireSeerrClient).mockRejectedValueOnce(error);

		const res = await app.inject({
			method: "GET",
			url: "/api/seerr/requests/inst-missing",
		});

		expect(res.statusCode).toBe(404);
	});
});

// ===========================================================================
// GET /:instanceId/count — Aggregated counts
// ===========================================================================

describe("GET /:instanceId/count", () => {
	it("returns count object", async () => {
		const counts = {
			total: 10,
			movie: 5,
			tv: 3,
			pending: 2,
			approved: 4,
			declined: 1,
			processing: 0,
			available: 3,
		};
		mockClient.getRequestCount.mockResolvedValueOnce(counts);

		const res = await app.inject({
			method: "GET",
			url: "/api/seerr/requests/inst-1/count",
		});

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.payload)).toEqual(counts);
	});

	it("handles missing instance", async () => {
		const error = Object.assign(new Error("Instance not found"), { statusCode: 404 });
		vi.mocked(requireSeerrClient).mockRejectedValueOnce(error);

		const res = await app.inject({
			method: "GET",
			url: "/api/seerr/requests/inst-missing/count",
		});

		expect(res.statusCode).toBe(404);
	});
});

// ===========================================================================
// GET /:instanceId/:requestId — Single request (enriched)
// ===========================================================================

describe("GET /:instanceId/:requestId", () => {
	it("returns enriched single request", async () => {
		const enrichedRequest = { ...sampleRequest, media: { ...sampleRequest.media, title: "Test Movie" } };
		mockClient.getRequest.mockResolvedValueOnce(sampleRequest);
		mockClient.enrichRequestsWithMedia.mockResolvedValueOnce({
			pageInfo: { pages: 1, pageSize: 1, results: 1, page: 1 },
			results: [enrichedRequest],
		});

		const res = await app.inject({
			method: "GET",
			url: "/api/seerr/requests/inst-1/1",
		});

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.payload)).toEqual(enrichedRequest);

		expect(mockClient.enrichRequestsWithMedia).toHaveBeenCalledWith({
			pageInfo: { pages: 1, pageSize: 1, results: 1, page: 1 },
			results: [sampleRequest],
		});
	});

	it("returns 404 when getRequest throws not found", async () => {
		const error = Object.assign(new Error("Request not found"), { statusCode: 404 });
		mockClient.getRequest.mockRejectedValueOnce(error);

		const res = await app.inject({
			method: "GET",
			url: "/api/seerr/requests/inst-1/999",
		});

		expect(res.statusCode).toBe(404);
	});

	it("returns 400 on invalid requestId (non-numeric)", async () => {
		const res = await app.inject({
			method: "GET",
			url: "/api/seerr/requests/inst-1/abc",
		});

		expect(res.statusCode).toBe(400);
	});
});

// ===========================================================================
// POST /:instanceId/:requestId/approve
// ===========================================================================

describe("POST /:instanceId/:requestId/approve", () => {
	it("approves and returns result with success audit log", async () => {
		const approveResult = { id: 1, status: 2 };
		mockClient.approveRequest.mockResolvedValueOnce(approveResult);

		const res = await app.inject({
			method: "POST",
			url: "/api/seerr/requests/inst-1/1/approve",
		});

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.payload)).toEqual(approveResult);

		expect(logSeerrAction).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({
				instanceId: "inst-1",
				userId: "user-1",
				action: "approve_request",
				targetType: "request",
				targetId: "1",
			}),
		);
		// success: true is implicit (no success field when successful)
		expect(logSeerrAction).toHaveBeenCalledTimes(1);
		const callArgs = vi.mocked(logSeerrAction).mock.calls[0]![2];
		expect(callArgs).not.toHaveProperty("success");
	});

	it("logs failure when approveRequest throws, re-throws error", async () => {
		const error = Object.assign(new Error("Approve failed"), { statusCode: 500 });
		mockClient.approveRequest.mockRejectedValueOnce(error);

		const res = await app.inject({
			method: "POST",
			url: "/api/seerr/requests/inst-1/1/approve",
		});

		expect(res.statusCode).toBe(500);
		expect(logSeerrAction).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({
				action: "approve_request",
				targetId: "1",
				success: false,
			}),
		);
	});

	it("returns 400 on invalid requestId", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/api/seerr/requests/inst-1/abc/approve",
		});

		expect(res.statusCode).toBe(400);
		expect(mockClient.approveRequest).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// POST /:instanceId/:requestId/decline
// ===========================================================================

describe("POST /:instanceId/:requestId/decline", () => {
	it("declines and returns result with audit log", async () => {
		const declineResult = { id: 1, status: 3 };
		mockClient.declineRequest.mockResolvedValueOnce(declineResult);

		const res = await app.inject({
			method: "POST",
			url: "/api/seerr/requests/inst-1/1/decline",
		});

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.payload)).toEqual(declineResult);

		expect(logSeerrAction).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({
				instanceId: "inst-1",
				userId: "user-1",
				action: "decline_request",
				targetType: "request",
				targetId: "1",
			}),
		);
	});

	it("logs failure and re-throws on decline error", async () => {
		const error = Object.assign(new Error("Decline failed"), { statusCode: 500 });
		mockClient.declineRequest.mockRejectedValueOnce(error);

		const res = await app.inject({
			method: "POST",
			url: "/api/seerr/requests/inst-1/1/decline",
		});

		expect(res.statusCode).toBe(500);
		expect(logSeerrAction).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({
				action: "decline_request",
				targetId: "1",
				success: false,
			}),
		);
	});
});

// ===========================================================================
// DELETE /:instanceId/:requestId
// ===========================================================================

describe("DELETE /:instanceId/:requestId", () => {
	it("deletes and returns 204 with audit log", async () => {
		mockClient.deleteRequest.mockResolvedValueOnce(undefined);

		const res = await app.inject({
			method: "DELETE",
			url: "/api/seerr/requests/inst-1/1",
		});

		expect(res.statusCode).toBe(204);
		expect(res.payload).toBe("");

		expect(logSeerrAction).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({
				instanceId: "inst-1",
				userId: "user-1",
				action: "delete_request",
				targetType: "request",
				targetId: "1",
			}),
		);
	});

	it("logs failure and re-throws on delete error", async () => {
		const error = Object.assign(new Error("Delete failed"), { statusCode: 500 });
		mockClient.deleteRequest.mockRejectedValueOnce(error);

		const res = await app.inject({
			method: "DELETE",
			url: "/api/seerr/requests/inst-1/1",
		});

		expect(res.statusCode).toBe(500);
		expect(logSeerrAction).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({
				action: "delete_request",
				targetId: "1",
				success: false,
			}),
		);
	});
});

// ===========================================================================
// POST /:instanceId/:requestId/retry
// ===========================================================================

describe("POST /:instanceId/:requestId/retry", () => {
	it("retries and returns result with audit log", async () => {
		const retryResult = { id: 1, status: 1 };
		mockClient.retryRequest.mockResolvedValueOnce(retryResult);

		const res = await app.inject({
			method: "POST",
			url: "/api/seerr/requests/inst-1/1/retry",
		});

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.payload)).toEqual(retryResult);

		expect(logSeerrAction).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({
				instanceId: "inst-1",
				userId: "user-1",
				action: "retry_request",
				targetType: "request",
				targetId: "1",
			}),
		);
	});

	it("logs failure and re-throws on retry error", async () => {
		const error = Object.assign(new Error("Retry failed"), { statusCode: 500 });
		mockClient.retryRequest.mockRejectedValueOnce(error);

		const res = await app.inject({
			method: "POST",
			url: "/api/seerr/requests/inst-1/1/retry",
		});

		expect(res.statusCode).toBe(500);
		expect(logSeerrAction).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({
				action: "retry_request",
				targetId: "1",
				success: false,
			}),
		);
	});
});

// ===========================================================================
// POST /:instanceId/bulk — Bulk approve/decline/delete
// ===========================================================================

describe("POST /:instanceId/bulk", () => {
	it("returns all successes when every request succeeds", async () => {
		mockClient.approveRequest.mockResolvedValue({ status: 2 });

		const res = await app.inject({
			method: "POST",
			url: "/api/seerr/requests/inst-1/bulk",
			payload: { action: "approve", requestIds: [1, 2, 3] },
		});

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.totalSuccess).toBe(3);
		expect(body.totalFailed).toBe(0);
		expect(body.results).toHaveLength(3);
		expect(body.results.every((r: any) => r.success)).toBe(true);

		// Audit logged for each request
		expect(logSeerrAction).toHaveBeenCalledTimes(3);
	});

	it("handles partial failure — some succeed, some fail", async () => {
		mockClient.approveRequest
			.mockResolvedValueOnce({ status: 2 })
			.mockRejectedValueOnce(new Error("Upstream timeout"));

		const res = await app.inject({
			method: "POST",
			url: "/api/seerr/requests/inst-1/bulk",
			payload: { action: "approve", requestIds: [1, 2] },
		});

		expect(res.statusCode).toBe(207);
		const body = JSON.parse(res.payload);
		expect(body.totalSuccess).toBe(1);
		expect(body.totalFailed).toBe(1);

		expect(body.results[0]).toEqual({ requestId: 1, success: true });
		expect(body.results[1]).toEqual(
			expect.objectContaining({ requestId: 2, success: false, error: "Upstream timeout" }),
		);

		// Both success and failure logged
		expect(logSeerrAction).toHaveBeenCalledTimes(2);
	});

	it("rejects invalid action with 400", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/api/seerr/requests/inst-1/bulk",
			payload: { action: "invalid", requestIds: [1] },
		});

		expect(res.statusCode).toBe(400);
		expect(mockClient.approveRequest).not.toHaveBeenCalled();
		expect(mockClient.declineRequest).not.toHaveBeenCalled();
		expect(mockClient.deleteRequest).not.toHaveBeenCalled();
	});

	it("rejects empty requestIds with 400", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/api/seerr/requests/inst-1/bulk",
			payload: { action: "approve", requestIds: [] },
		});

		expect(res.statusCode).toBe(400);
	});

	it("rejects requestIds exceeding max of 50 with 400", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/api/seerr/requests/inst-1/bulk",
			payload: {
				action: "approve",
				requestIds: Array.from({ length: 51 }, (_, i) => i + 1),
			},
		});

		expect(res.statusCode).toBe(400);
	});
});
