import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockClient, requireClient } = vi.hoisted(() => ({
	mockClient: {
		getMediaSummary: vi.fn(),
		getOpenIssueCounts: vi.fn(),
	},
	requireClient: vi.fn(),
}));

vi.mock("../../../lib/seerr/seerr-client.js", () => ({
	requireSeerrClient: requireClient,
}));

import Fastify from "fastify";
import { registerLibraryEnrichmentRoutes } from "../library-enrichment-routes.js";

let app: ReturnType<typeof Fastify>;
let logs: Array<Record<string, unknown>>;
const timingMessage = "seerr library-enrichment: aggregate phase timing";
const mediaSummary = { voteAverage: 7, backdropPath: null, posterPath: null };

beforeEach(async () => {
	vi.resetAllMocks();
	requireClient.mockResolvedValue(mockClient);
	logs = [];
	app = Fastify({
		logger: {
			stream: new Writable({
				write(chunk, _encoding, callback) {
					logs.push(JSON.parse(chunk.toString()));
					callback();
				},
			}),
		},
	});
	app.decorateRequest("currentUser", null);
	app.addHook("preHandler", async (request: any) => {
		request.currentUser = { id: "user-1" };
	});
	await app.register(registerLibraryEnrichmentRoutes, { prefix: "/api/seerr/library-enrichment" });
	await app.ready();
});

afterEach(async () => {
	await app?.close();
	vi.restoreAllMocks();
});

describe("Seerr Library issue-count availability", () => {
	it("measures only aggregate elapsed phases after a successful deduplicated read", async () => {
		let now = 100;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		requireClient.mockImplementation(async () => {
			now = 111;
			return mockClient;
		});
		mockClient.getMediaSummary.mockImplementation(async () => {
			await Promise.resolve();
			now = 140;
			return mediaSummary;
		});
		mockClient.getOpenIssueCounts.mockImplementation(async () => {
			await Promise.resolve();
			now = 183;
			return new Map([["movie:123", 2]]);
		});
		const response = await app.inject({
			method: "GET",
			url: "/api/seerr/library-enrichment/seerr-1?tmdbIds=123,123,456&types=movie,movie,tv",
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			items: {
				"movie:123": { ...mediaSummary, openIssueCount: 2 },
				"tv:456": { ...mediaSummary, openIssueCount: 0 },
			},
		});
		expect(requireClient).toHaveBeenCalledTimes(1);
		expect(requireClient.mock.calls[0]?.slice(1)).toEqual([
			"user-1",
			"seerr-1",
			{ prisma: app.prisma },
		]);
		expect(mockClient.getMediaSummary).toHaveBeenCalledTimes(2);
		expect(mockClient.getOpenIssueCounts).toHaveBeenCalledTimes(1);
		const events = logs.filter((entry) => entry.msg === timingMessage);
		expect(events).toHaveLength(1);
		const { level, time, pid, hostname, reqId, msg, ...measurements } = events[0]!;
		expect(measurements).toEqual({
			itemCount: 3,
			uniqueItemCount: 2,
			admissionMs: 11,
			mediaSummariesMs: 29,
			issueCountsMs: 43,
			totalMs: 83,
			enrichmentFailures: 0,
			issueCountsAvailable: true,
			enrichmentStatus: "available",
		});
	});

	it("times failed phases without publishing private error fields or false issue zeros", async () => {
		let now = 200;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		requireClient.mockImplementation(async () => {
			now = 207;
			return mockClient;
		});
		mockClient.getMediaSummary.mockImplementation(async (type: string) => {
			await Promise.resolve();
			now = 227;
			if (type === "movie") throw new Error("synthetic provider-body-secret");
			return mediaSummary;
		});
		mockClient.getOpenIssueCounts.mockImplementation(async () => {
			await Promise.resolve();
			now = 267;
			throw new Error("synthetic issue-body-secret");
		});
		const response = await app.inject({
			method: "GET",
			url: "/api/seerr/library-enrichment/seerr-1?tmdbIds=123,456&types=movie,tv",
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			items: { "tv:456": { ...mediaSummary, openIssueCount: null } },
			issueCountsAvailable: false,
			enrichmentFailures: 1,
		});
		const events = logs.filter((entry) => entry.msg === timingMessage);
		expect(events).toHaveLength(1);
		const { level, time, pid, hostname, reqId, msg, ...measurements } = events[0]!;
		expect(measurements).toEqual({
			itemCount: 2,
			uniqueItemCount: 2,
			admissionMs: 7,
			mediaSummariesMs: 20,
			issueCountsMs: 40,
			totalMs: 67,
			enrichmentFailures: 1,
			issueCountsAvailable: false,
			enrichmentStatus: "partial",
		});
	});

	it("does not report a completed enrichment for a rejected query or start provider reads", async () => {
		const response = await app.inject({
			method: "GET",
			url: "/api/seerr/library-enrichment/seerr-1?tmdbIds=123,456&types=movie",
		});
		expect(response.statusCode).toBe(400);
		expect(requireClient).not.toHaveBeenCalled();
		expect(mockClient.getMediaSummary).not.toHaveBeenCalled();
		expect(mockClient.getOpenIssueCounts).not.toHaveBeenCalled();
		expect(logs.filter((entry) => entry.msg === timingMessage)).toHaveLength(0);
	});

	it("marks all issue counts unknown when the paginator refuses an incomplete walk", async () => {
		mockClient.getMediaSummary.mockResolvedValueOnce({
			voteAverage: 7,
			backdropPath: null,
			posterPath: null,
		});
		mockClient.getOpenIssueCounts.mockRejectedValueOnce(new Error("pagination incomplete"));

		const response = await app.inject({
			method: "GET",
			url: "/api/seerr/library-enrichment/seerr-1?tmdbIds=123&types=movie",
		});

		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.payload)).toMatchObject({
			issueCountsAvailable: false,
			items: { "movie:123": { openIssueCount: null } },
		});
	});

	it("does not publish zero when the issue-count read failed", async () => {
		mockClient.getMediaSummary.mockResolvedValueOnce({
			voteAverage: 7,
			backdropPath: null,
			posterPath: null,
		});
		mockClient.getOpenIssueCounts.mockRejectedValueOnce(new Error("provider unavailable"));

		const response = await app.inject({
			method: "GET",
			url: "/api/seerr/library-enrichment/seerr-1?tmdbIds=123&types=movie",
		});

		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.payload)).toMatchObject({
			issueCountsAvailable: false,
			items: { "movie:123": { openIssueCount: null } },
		});
	});
});
