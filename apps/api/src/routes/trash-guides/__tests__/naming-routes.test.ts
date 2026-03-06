/**
 * Tests for naming-routes route handlers.
 *
 * Covers: GET /presets, POST /preview, POST /apply,
 * POST /rollback, GET/POST/DELETE /configs, and ARR response validation.
 */

import { vi, describe, it, expect, beforeEach, afterAll } from "vitest";

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

const { mockRequireInstance, mockCacheManager, mockFetcher } = vi.hoisted(() => ({
	mockRequireInstance: vi.fn(),
	mockCacheManager: {
		isFresh: vi.fn(),
		get: vi.fn(),
		set: vi.fn(),
	},
	mockFetcher: {
		fetchNamingData: vi.fn(),
	},
}));

vi.mock("../../../lib/arr/instance-helpers.js", () => ({
	requireInstance: mockRequireInstance,
}));

vi.mock("../../../lib/trash-guides/cache-manager.js", () => ({
	createCacheManager: vi.fn().mockReturnValue(mockCacheManager),
	CacheCorruptionError: class CacheCorruptionError extends Error {},
}));

vi.mock("../../../lib/trash-guides/github-fetcher.js", () => ({
	createTrashFetcher: vi.fn().mockReturnValue(mockFetcher),
}));

vi.mock("../../../lib/trash-guides/repo-config.js", () => ({
	getRepoConfig: vi.fn().mockResolvedValue({}),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import Fastify from "fastify";
import { namingRoutes } from "../naming-routes.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const RADARR_INSTANCE = {
	id: "inst-radarr",
	userId: "user-1",
	service: "RADARR",
	label: "My Radarr",
	baseUrl: "http://localhost:7878",
};

const RADARR_NAMING_DATA = {
	_service: "RADARR" as const,
	folder: { "TRaSH Recommended": "{Movie CleanTitle} ({Release Year})" },
	file: { "TRaSH Recommended": "{Movie CleanTitle} {(Release Year)} {imdb-{ImdbId}}" },
};

const VALID_ARR_NAMING_CONFIG = {
	id: 1,
	renameMovies: false,
	standardMovieFormat: "old format",
	movieFolderFormat: "old folder",
};

// ---------------------------------------------------------------------------
// Fastify setup
// ---------------------------------------------------------------------------

let app: ReturnType<typeof Fastify>;
let mockRawRequest: ReturnType<typeof vi.fn>;

beforeEach(async () => {
	vi.clearAllMocks();

	mockRawRequest = vi.fn();
	mockRequireInstance.mockResolvedValue(RADARR_INSTANCE);
	mockCacheManager.isFresh.mockResolvedValue(true);
	mockCacheManager.get.mockResolvedValue([RADARR_NAMING_DATA]);

	app = Fastify();

	// Fake auth
	app.decorateRequest("currentUser", null);
	app.addHook("preHandler", async (req: any) => {
		req.currentUser = { id: "user-1" };
	});

	// Mock Prisma
	(app as any).prisma = {
		namingConfig: {
			findUnique: vi.fn().mockResolvedValue(null),
			upsert: vi.fn().mockImplementation(async ({ create }: any) => ({
				...create,
				createdAt: new Date(),
				updatedAt: new Date(),
			})),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			delete: vi.fn().mockResolvedValue({}),
		},
		namingDeployHistory: {
			create: vi.fn().mockImplementation(async ({ data }: any) => ({
				id: "history-1",
				...data,
				deployedAt: new Date(),
			})),
			findFirst: vi.fn().mockResolvedValue(null),
			findMany: vi.fn().mockResolvedValue([]),
			count: vi.fn().mockResolvedValue(0),
			update: vi.fn().mockResolvedValue({}),
		},
	};

	// Mock ARR client factory
	(app as any).arrClientFactory = { rawRequest: mockRawRequest };

	// Mock log
	(app as any).log = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	};

	await app.register(namingRoutes, { prefix: "/api/trash-guides/naming" });
	await app.ready();
});

afterAll(async () => {
	await app?.close();
});

// ===========================================================================
// Helpers
// ===========================================================================

function makeJsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const radarrSelectedPresets = {
	serviceType: "RADARR" as const,
	filePreset: "TRaSH Recommended",
	folderPreset: null,
};

// ===========================================================================
// GET /presets
// ===========================================================================

describe("GET /presets", () => {
	it("returns presets for RADARR", async () => {
		const res = await app.inject({
			method: "GET",
			url: "/api/trash-guides/naming/presets?serviceType=RADARR",
		});

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.success).toBe(true);
		expect(body.presets).toBeDefined();
		expect(body.presets.serviceType).toBe("RADARR");
	});

	it("returns null when no naming data available", async () => {
		mockCacheManager.get.mockResolvedValueOnce([]);

		const res = await app.inject({
			method: "GET",
			url: "/api/trash-guides/naming/presets?serviceType=RADARR",
		});

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.presets).toBeNull();
	});
});

// ===========================================================================
// POST /preview
// ===========================================================================

describe("POST /preview", () => {
	it("returns preview with field comparisons", async () => {
		mockRawRequest.mockResolvedValueOnce(makeJsonResponse(VALID_ARR_NAMING_CONFIG));

		const res = await app.inject({
			method: "POST",
			url: "/api/trash-guides/naming/preview",
			payload: { instanceId: "inst-radarr", selectedPresets: radarrSelectedPresets },
		});

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.success).toBe(true);
		expect(body.preview.comparisons).toHaveLength(1);
		expect(body.preview.changedCount).toBe(1);
	});

	it("returns 502 on invalid ARR response (bad JSON)", async () => {
		mockRawRequest.mockResolvedValueOnce(
			new Response("<html>502 Bad Gateway</html>", { status: 200 }),
		);

		const res = await app.inject({
			method: "POST",
			url: "/api/trash-guides/naming/preview",
			payload: { instanceId: "inst-radarr", selectedPresets: radarrSelectedPresets },
		});

		expect(res.statusCode).toBe(502);
	});

	it("returns 502 on invalid ARR response (missing required fields)", async () => {
		mockRawRequest.mockResolvedValueOnce(
			makeJsonResponse({ notAValidConfig: true }),
		);

		const res = await app.inject({
			method: "POST",
			url: "/api/trash-guides/naming/preview",
			payload: { instanceId: "inst-radarr", selectedPresets: radarrSelectedPresets },
		});

		expect(res.statusCode).toBe(502);
		const body = JSON.parse(res.payload);
		expect(body.error).toContain("Invalid naming config response");
	});

	it("returns 400 on service mismatch", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/api/trash-guides/naming/preview",
			payload: {
				instanceId: "inst-radarr",
				selectedPresets: {
					serviceType: "SONARR",
					standardEpisodePreset: "Default",
					dailyEpisodePreset: null,
					animeEpisodePreset: null,
					seriesFolderPreset: null,
					seasonFolderPreset: null,
				},
			},
		});

		expect(res.statusCode).toBe(400);
	});
});

// ===========================================================================
// POST /apply
// ===========================================================================

describe("POST /apply", () => {
	it("applies naming presets and creates history", async () => {
		mockRawRequest
			.mockResolvedValueOnce(makeJsonResponse(VALID_ARR_NAMING_CONFIG)) // GET
			.mockResolvedValueOnce(makeJsonResponse({ ...VALID_ARR_NAMING_CONFIG, standardMovieFormat: "new" })); // PUT

		const res = await app.inject({
			method: "POST",
			url: "/api/trash-guides/naming/apply",
			payload: { instanceId: "inst-radarr", selectedPresets: radarrSelectedPresets },
		});

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.success).toBe(true);
		expect(body.fieldCount).toBe(1);
		expect(body.historyId).toBe("history-1");

		// Verify history was created with snapshot
		expect((app as any).prisma.namingDeployHistory.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					instanceId: "inst-radarr",
					userId: "user-1",
					status: "SUCCESS",
					previousConfig: expect.any(String),
				}),
			}),
		);
	});

	it("records FAILED history on PUT failure", async () => {
		mockRawRequest
			.mockResolvedValueOnce(makeJsonResponse(VALID_ARR_NAMING_CONFIG)) // GET
			.mockResolvedValueOnce(new Response("Server error", { status: 500 })); // PUT fails

		const res = await app.inject({
			method: "POST",
			url: "/api/trash-guides/naming/apply",
			payload: { instanceId: "inst-radarr", selectedPresets: radarrSelectedPresets },
		});

		expect(res.statusCode).toBe(502);

		// Verify history was updated to FAILED
		expect((app as any).prisma.namingDeployHistory.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "history-1" },
				data: expect.objectContaining({ status: "FAILED" }),
			}),
		);
	});

	it("retries PUT on network error and succeeds", async () => {
		mockRawRequest
			.mockResolvedValueOnce(makeJsonResponse(VALID_ARR_NAMING_CONFIG)) // GET
			.mockRejectedValueOnce(new Error("ECONNRESET")) // First PUT fails
			.mockResolvedValueOnce(makeJsonResponse({ ...VALID_ARR_NAMING_CONFIG, standardMovieFormat: "new" })); // Retry succeeds

		const res = await app.inject({
			method: "POST",
			url: "/api/trash-guides/naming/apply",
			payload: { instanceId: "inst-radarr", selectedPresets: radarrSelectedPresets },
		});

		expect(res.statusCode).toBe(200);
		expect(mockRawRequest).toHaveBeenCalledTimes(3); // GET + 2 PUTs
	});

	it("records FAILED when both PUT attempts fail", async () => {
		mockRawRequest
			.mockResolvedValueOnce(makeJsonResponse(VALID_ARR_NAMING_CONFIG)) // GET
			.mockRejectedValueOnce(new Error("ECONNRESET")) // First PUT
			.mockRejectedValueOnce(new Error("ECONNRESET")); // Retry

		const res = await app.inject({
			method: "POST",
			url: "/api/trash-guides/naming/apply",
			payload: { instanceId: "inst-radarr", selectedPresets: radarrSelectedPresets },
		});

		expect(res.statusCode).toBe(502);
		expect((app as any).prisma.namingDeployHistory.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "FAILED" }),
			}),
		);
	});

	it("passes enableRename through to resolved payload", async () => {
		mockRawRequest
			.mockResolvedValueOnce(makeJsonResponse(VALID_ARR_NAMING_CONFIG)) // GET
			.mockResolvedValueOnce(makeJsonResponse(VALID_ARR_NAMING_CONFIG)); // PUT

		const res = await app.inject({
			method: "POST",
			url: "/api/trash-guides/naming/apply",
			payload: {
				instanceId: "inst-radarr",
				selectedPresets: radarrSelectedPresets,
				enableRename: true,
			},
		});

		expect(res.statusCode).toBe(200);

		// Check that the PUT body includes renameMovies
		const putCall = mockRawRequest.mock.calls.find(
			(call: any[]) => call[2]?.method === "PUT",
		);
		expect(putCall).toBeDefined();
		expect(putCall![2].body.renameMovies).toBe(true);
	});

	it("handles P2002 unique constraint race on config upsert", async () => {
		mockRawRequest
			.mockResolvedValueOnce(makeJsonResponse(VALID_ARR_NAMING_CONFIG))
			.mockResolvedValueOnce(makeJsonResponse(VALID_ARR_NAMING_CONFIG));

		// Make the config upsert throw P2002
		const p2002Error = new Error("Unique constraint") as Error & { code: string };
		p2002Error.code = "P2002";
		(app as any).prisma.namingConfig.upsert.mockRejectedValueOnce(p2002Error);

		const res = await app.inject({
			method: "POST",
			url: "/api/trash-guides/naming/apply",
			payload: { instanceId: "inst-radarr", selectedPresets: radarrSelectedPresets },
		});

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.warning).toBe("CONFIG_SAVE_FAILED");
	});
});

// ===========================================================================
// POST /rollback
// ===========================================================================

describe("POST /rollback", () => {
	it("rolls back successfully and creates history", async () => {
		const historyRecord = {
			id: "history-1",
			instanceId: "inst-radarr",
			userId: "user-1",
			status: "SUCCESS",
			previousConfig: JSON.stringify(VALID_ARR_NAMING_CONFIG),
			rolledBack: false,
			changedFields: 1,
			totalFields: 1,
			selectedPresets: JSON.stringify(radarrSelectedPresets),
		};

		(app as any).prisma.namingDeployHistory.findFirst.mockResolvedValueOnce(historyRecord);
		mockRawRequest.mockResolvedValueOnce(makeJsonResponse(VALID_ARR_NAMING_CONFIG)); // PUT

		const res = await app.inject({
			method: "POST",
			url: "/api/trash-guides/naming/rollback",
			payload: { historyId: "history-1" },
		});

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.success).toBe(true);
		expect(body.fieldCount).toBe(1);

		// Verify the original was marked as rolled back
		expect((app as any).prisma.namingDeployHistory.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "history-1" },
				data: expect.objectContaining({ rolledBack: true }),
			}),
		);

		// Verify a new ROLLED_BACK history was created
		expect((app as any).prisma.namingDeployHistory.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "ROLLED_BACK" }),
			}),
		);
	});

	it("returns 400 when already rolled back", async () => {
		(app as any).prisma.namingDeployHistory.findFirst.mockResolvedValueOnce({
			id: "history-1",
			rolledBack: true,
			previousConfig: JSON.stringify(VALID_ARR_NAMING_CONFIG),
		});

		const res = await app.inject({
			method: "POST",
			url: "/api/trash-guides/naming/rollback",
			payload: { historyId: "history-1" },
		});

		expect(res.statusCode).toBe(400);
		const body = JSON.parse(res.payload);
		expect(body.error).toContain("already been rolled back");
	});

	it("returns 400 when no previous config snapshot", async () => {
		(app as any).prisma.namingDeployHistory.findFirst.mockResolvedValueOnce({
			id: "history-1",
			rolledBack: false,
			previousConfig: null,
		});

		const res = await app.inject({
			method: "POST",
			url: "/api/trash-guides/naming/rollback",
			payload: { historyId: "history-1" },
		});

		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.payload).error).toContain("No previous config snapshot");
	});

	it("returns 404 for non-existent historyId", async () => {
		(app as any).prisma.namingDeployHistory.findFirst.mockResolvedValueOnce(null);

		const res = await app.inject({
			method: "POST",
			url: "/api/trash-guides/naming/rollback",
			payload: { historyId: "nonexistent" },
		});

		expect(res.statusCode).toBe(404);
	});
});

// ===========================================================================
// GET /configs
// ===========================================================================

describe("GET /configs", () => {
	it("returns saved config", async () => {
		(app as any).prisma.namingConfig.findUnique.mockResolvedValueOnce({
			instanceId: "inst-radarr",
			serviceType: "RADARR",
			selectedPresets: JSON.stringify(radarrSelectedPresets),
			syncStrategy: "manual",
			lastDeployedAt: new Date(),
			lastDeployedHash: "abc",
			lastDeployStatus: "SUCCESS",
			lastDeployError: null,
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		const res = await app.inject({
			method: "GET",
			url: "/api/trash-guides/naming/configs?instanceId=inst-radarr",
		});

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.config).not.toBeNull();
		expect(body.config.serviceType).toBe("RADARR");
		expect(body.config.lastDeployStatus).toBe("SUCCESS");
	});

	it("returns null for unknown instance", async () => {
		const res = await app.inject({
			method: "GET",
			url: "/api/trash-guides/naming/configs?instanceId=inst-radarr",
		});

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.config).toBeNull();
	});
});

// ===========================================================================
// POST /configs
// ===========================================================================

describe("POST /configs", () => {
	it("creates new config", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/api/trash-guides/naming/configs",
			payload: {
				instanceId: "inst-radarr",
				selectedPresets: radarrSelectedPresets,
			},
		});

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.success).toBe(true);
		expect(body.config).toBeDefined();
	});

	it("upserts existing config", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/api/trash-guides/naming/configs",
			payload: {
				instanceId: "inst-radarr",
				selectedPresets: radarrSelectedPresets,
				syncStrategy: "auto",
			},
		});

		expect(res.statusCode).toBe(200);
		expect((app as any).prisma.namingConfig.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { instanceId: "inst-radarr" },
				update: expect.objectContaining({ syncStrategy: "auto" }),
			}),
		);
	});
});

// ===========================================================================
// DELETE /configs/:instanceId
// ===========================================================================

describe("DELETE /configs/:instanceId", () => {
	it("deletes config", async () => {
		const res = await app.inject({
			method: "DELETE",
			url: "/api/trash-guides/naming/configs/inst-radarr",
		});

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.success).toBe(true);
	});

	it("returns 404 for unknown config", async () => {
		const p2025Error = new Error("Not found") as Error & { code: string };
		p2025Error.code = "P2025";
		(app as any).prisma.namingConfig.delete.mockRejectedValueOnce(p2025Error);

		const res = await app.inject({
			method: "DELETE",
			url: "/api/trash-guides/naming/configs/unknown",
		});

		expect(res.statusCode).toBe(404);
	});
});

// ===========================================================================
// GET /history
// ===========================================================================

describe("GET /history", () => {
	const makeHistoryRecord = (overrides?: Record<string, unknown>) => ({
		id: "hist-1",
		instanceId: "inst-radarr",
		userId: "user-1",
		deployedAt: new Date("2026-03-01T12:00:00Z"),
		status: "SUCCESS",
		selectedPresets: JSON.stringify(radarrSelectedPresets),
		resolvedPayload: "{}",
		deployedHash: "abc123",
		previousConfig: "{}",
		changedFields: 1,
		totalFields: 2,
		errorMessage: null,
		rolledBack: false,
		rolledBackAt: null,
		...overrides,
	});

	it("returns paginated history records", async () => {
		const records = [makeHistoryRecord(), makeHistoryRecord({ id: "hist-2" })];
		(app as any).prisma.namingDeployHistory.findMany.mockResolvedValueOnce(records);
		(app as any).prisma.namingDeployHistory.count.mockResolvedValueOnce(2);

		const res = await app.inject({
			method: "GET",
			url: "/api/trash-guides/naming/history?instanceId=inst-radarr",
		});

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.success).toBe(true);
		expect(body.data.history).toHaveLength(2);
		expect(body.data.pagination).toEqual({
			total: 2,
			limit: 20,
			offset: 0,
			hasMore: false,
		});
	});

	it("returns empty array when no history", async () => {
		const res = await app.inject({
			method: "GET",
			url: "/api/trash-guides/naming/history?instanceId=inst-radarr",
		});

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.data.history).toHaveLength(0);
		expect(body.data.pagination.total).toBe(0);
	});

	it("validates required instanceId", async () => {
		const res = await app.inject({
			method: "GET",
			url: "/api/trash-guides/naming/history",
		});

		expect(res.statusCode).toBe(400);
	});

	it("respects limit and offset params", async () => {
		(app as any).prisma.namingDeployHistory.findMany.mockResolvedValueOnce([]);
		(app as any).prisma.namingDeployHistory.count.mockResolvedValueOnce(50);

		const res = await app.inject({
			method: "GET",
			url: "/api/trash-guides/naming/history?instanceId=inst-radarr&limit=10&offset=20",
		});

		expect(res.statusCode).toBe(200);
		expect((app as any).prisma.namingDeployHistory.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				take: 10,
				skip: 20,
			}),
		);
		const body = JSON.parse(res.payload);
		expect(body.data.pagination).toEqual({
			total: 50,
			limit: 10,
			offset: 20,
			hasMore: true,
		});
	});
});

// ===========================================================================
// ARR response validation
// ===========================================================================

describe("ARR response validation", () => {
	it("rejects non-JSON response with 502", async () => {
		mockRawRequest.mockResolvedValueOnce(
			new Response("This is not JSON", { status: 200 }),
		);

		const res = await app.inject({
			method: "POST",
			url: "/api/trash-guides/naming/preview",
			payload: { instanceId: "inst-radarr", selectedPresets: radarrSelectedPresets },
		});

		expect(res.statusCode).toBe(502);
		const body = JSON.parse(res.payload);
		expect(body.error).toContain("invalid response");
	});

	it("rejects response missing id field with 502", async () => {
		mockRawRequest.mockResolvedValueOnce(
			makeJsonResponse({ renameMovies: true, standardMovieFormat: "format" }),
		);

		const res = await app.inject({
			method: "POST",
			url: "/api/trash-guides/naming/preview",
			payload: { instanceId: "inst-radarr", selectedPresets: radarrSelectedPresets },
		});

		expect(res.statusCode).toBe(502);
		const body = JSON.parse(res.payload);
		expect(body.error).toContain("Invalid naming config response");
	});
});
