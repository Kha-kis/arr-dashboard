/**
 * QUI Route Integration Tests
 *
 * Covers all 8 endpoints in routes/qui.ts. Uses the same Fastify inject
 * pattern as services.test.ts — real route plugins, mocked Prisma + client.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { mockRequireQuiInstance, mockListQuiInstances } = vi.hoisted(() => ({
	mockRequireQuiInstance: vi.fn(),
	mockListQuiInstances: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../lib/qui/instance-helpers.js", () => ({
	requireQuiInstance: (...args: unknown[]) => mockRequireQuiInstance(...args),
	listQuiInstances: (...args: unknown[]) => mockListQuiInstances(...args),
}));

const mockQuiClient = vi.hoisted(() => ({
	getTorrentByHash: vi.fn(),
	listInstances: vi.fn(),
	getTrackers: vi.fn(),
	getCrossSeedMatches: vi.fn(),
	testConnection: vi.fn(),
}));

vi.mock("../../lib/qui/client-factory.js", () => ({
	createQuiClient: vi.fn(() => mockQuiClient),
}));

import Fastify from "fastify";
import { InstanceNotFoundError } from "../../lib/errors.js";
import { registerQuiRoutes } from "../qui.js";
import {
	createInjectAuthenticated,
	createMockEncryptor,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

function makeQuiInstance(overrides: Record<string, unknown> = {}) {
	return {
		id: "qui-1",
		userId: "user-1",
		service: "QUI",
		label: "qui main",
		baseUrl: "http://qui.test",
		encryptedApiKey: "enc",
		encryptionIv: "iv",
		externalUrl: null,
		isDefault: false,
		enabled: true,
		storageGroupId: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	};
}

function createMockPrisma() {
	return {
		serviceInstance: {
			findMany: vi.fn().mockResolvedValue([]),
			findFirst: vi.fn().mockResolvedValue(null),
		},
		libraryCache: {
			findFirst: vi.fn().mockResolvedValue(null),
			update: vi.fn().mockResolvedValue({}),
		},
	};
}

const VALID_HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

let app: ReturnType<typeof Fastify>;
let mockPrisma: ReturnType<typeof createMockPrisma>;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;

beforeEach(async () => {
	vi.clearAllMocks();

	mockPrisma = createMockPrisma();
	mockRequireQuiInstance.mockResolvedValue(makeQuiInstance());
	mockListQuiInstances.mockResolvedValue([]);

	app = Fastify();
	app.decorate("prisma", mockPrisma);
	app.decorate("encryptor", createMockEncryptor("test-api-key"));
	app.decorate("arrClientFactory", { rawRequest: vi.fn() });

	setupAuthInjection(app);
	registerTestErrorHandler(app);

	await app.register(registerQuiRoutes);
	await app.ready();

	injectAuthenticated = createInjectAuthenticated(app);
});

afterAll(async () => {
	await app?.close();
});

describe("GET /qui/instances", () => {
	it("returns empty array when no QUI instances exist", async () => {
		const res = await injectAuthenticated("GET", "/qui/instances");
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.payload).instances).toEqual([]);
	});

	it("returns user's QUI instances without sensitive fields", async () => {
		mockListQuiInstances.mockResolvedValue([makeQuiInstance()]);
		const res = await injectAuthenticated("GET", "/qui/instances");
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.instances).toHaveLength(1);
		expect(body.instances[0]).toHaveProperty("id", "qui-1");
		expect(body.instances[0]).toHaveProperty("label", "qui main");
		expect(body.instances[0]).toHaveProperty("baseUrl", "http://qui.test");
		expect(body.instances[0]).not.toHaveProperty("encryptedApiKey");
	});
});

describe("GET /qui/instances/:id/qbit", () => {
	it("returns qBittorrent instances for a valid QUI instance", async () => {
		mockQuiClient.listInstances.mockResolvedValue([{ id: 1, name: "qbit-main", connected: true }]);
		const res = await injectAuthenticated("GET", "/qui/instances/qui-1/qbit");
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.payload).instances).toEqual([
			{ id: 1, name: "qbit-main", connected: true },
		]);
	});

	it("returns 404 for non-owned instance", async () => {
		mockRequireQuiInstance.mockRejectedValue(new InstanceNotFoundError("qui-999"));
		const res = await injectAuthenticated("GET", "/qui/instances/qui-999/qbit");
		expect(res.statusCode).toBe(404);
	});
});

describe("GET /qui/instances/:id/torrents/by-hash/:hash", () => {
	it("returns torrent for valid hash", async () => {
		mockQuiClient.getTorrentByHash.mockResolvedValue({
			hash: VALID_HASH,
			name: "Test Torrent",
			state: "uploading",
			ratio: 1.5,
		});
		const res = await injectAuthenticated(
			"GET",
			`/qui/instances/qui-1/torrents/by-hash/${VALID_HASH}`,
		);
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.payload).torrent.state).toBe("uploading");
	});

	it("returns 400 for invalid hash", async () => {
		const res = await injectAuthenticated(
			"GET",
			"/qui/instances/qui-1/torrents/by-hash/not-a-hash",
		);
		expect(res.statusCode).toBe(400);
	});
});

describe("GET /qui/instances/:id/qbit/:instanceId/torrents/:hash/trackers", () => {
	it("returns trackers filtered to real trackers only", async () => {
		mockQuiClient.getTrackers.mockResolvedValue([
			{ url: "http://tracker.example:6969/announce", status: 1, health: "healthy" },
		]);
		const res = await injectAuthenticated(
			"GET",
			`/qui/instances/qui-1/qbit/1/torrents/${VALID_HASH}/trackers`,
		);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.trackers).toHaveLength(1);
	});

	it("returns 400 for invalid hash", async () => {
		const res = await injectAuthenticated(
			"GET",
			"/qui/instances/qui-1/qbit/1/torrents/short/trackers",
		);
		expect(res.statusCode).toBe(400);
	});

	it("returns 400 for non-numeric qbit instanceId", async () => {
		const res = await injectAuthenticated(
			"GET",
			`/qui/instances/qui-1/qbit/abc/torrents/${VALID_HASH}/trackers`,
		);
		expect(res.statusCode).toBe(400);
	});
});

describe("GET /qui/instances/:id/qbit/:instanceId/torrents/:hash/cross-seed", () => {
	it("returns cross-seed matches", async () => {
		mockQuiClient.getCrossSeedMatches.mockResolvedValue([
			{
				tracker: "http://tracker.example/announce",
				infoHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
				matchType: "content_path",
				trackerHealth: "healthy",
			},
		]);
		const res = await injectAuthenticated(
			"GET",
			`/qui/instances/qui-1/qbit/1/torrents/${VALID_HASH}/cross-seed`,
		);
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.payload).matches).toHaveLength(1);
	});
});

describe("POST /qui/instances/:id/test", () => {
	it("returns connection test result for saved instance", async () => {
		mockQuiClient.testConnection.mockResolvedValue({ ok: true });
		const res = await injectAuthenticated("POST", "/qui/instances/qui-1/test");
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.payload).ok).toBe(true);
	});

	it("returns failure reason for unreachable instance", async () => {
		mockQuiClient.testConnection.mockResolvedValue({
			ok: false,
			reason: "Connection refused",
		});
		const res = await injectAuthenticated("POST", "/qui/instances/qui-1/test");
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.ok).toBe(false);
		expect(body.reason).toBe("Connection refused");
	});
});

describe("POST /qui/test", () => {
	it("tests connection with inline credentials", async () => {
		mockQuiClient.testConnection.mockResolvedValue({ ok: true });
		const res = await injectAuthenticated("POST", "/qui/test", {
			body: {
				baseUrl: "https://qui.example.com",
				apiKey: "test-api-key",
			},
		});
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.payload).ok).toBe(true);
	});

	it("returns 400 for invalid baseUrl", async () => {
		const res = await injectAuthenticated("POST", "/qui/test", {
			body: {
				baseUrl: "not-a-url",
				apiKey: "test-api-key",
			},
		});
		expect(res.statusCode).toBe(400);
	});
});

describe("POST /qui/library-item/torrent-state", () => {
	it("returns supported:false for artist type", async () => {
		const res = await injectAuthenticated("POST", "/qui/library-item/torrent-state", {
			body: {
				arrInstanceId: "inst-1",
				arrItemId: 1,
				itemType: "artist",
			},
		});
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.supported).toBe(false);
	});

	it("returns supported:false for author type", async () => {
		const res = await injectAuthenticated("POST", "/qui/library-item/torrent-state", {
			body: {
				arrInstanceId: "inst-1",
				arrItemId: 1,
				itemType: "author",
			},
		});
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.supported).toBe(false);
	});

	it("returns empty response for movie not in cache", async () => {
		mockPrisma.libraryCache.findFirst.mockResolvedValue(null);
		const res = await injectAuthenticated("POST", "/qui/library-item/torrent-state", {
			body: {
				arrInstanceId: "inst-1",
				arrItemId: 1,
				itemType: "movie",
			},
		});
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.supported).toBe(true);
		expect(body.infoHash).toBe(null);
		expect(body.torrent).toBe(null);
	});

	it("scopes the cache lookup by userId via the instance relation (cross-user isolation)", async () => {
		// SECURITY regression guard: without `instance: { userId }` in the where
		// clause, a caller passing another user's arrInstanceId could read that
		// user's infoHash AND trigger a write-through update on their row.
		// Asserting the exact where shape prevents anyone "simplifying" it back
		// to the unscoped form during refactors.
		mockPrisma.libraryCache.findFirst.mockResolvedValue(null);
		await injectAuthenticated("POST", "/qui/library-item/torrent-state", {
			body: { arrInstanceId: "inst-of-other-user", arrItemId: 42, itemType: "movie" },
		});
		expect(mockPrisma.libraryCache.findFirst).toHaveBeenCalledWith({
			where: {
				instanceId: "inst-of-other-user",
				arrItemId: 42,
				itemType: "movie",
				instance: { userId: "user-1" }, // current user from setupAuthInjection
			},
		});
	});

	it("returns torrent state for movie with cached infoHash and QUI instance", async () => {
		mockPrisma.libraryCache.findFirst.mockResolvedValue({
			id: "cache-1",
			infoHash: VALID_HASH,
		});
		// Mock default QUI instance lookup
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(makeQuiInstance());
		mockQuiClient.getTorrentByHash.mockResolvedValue({
			hash: VALID_HASH,
			name: "Test Movie",
			state: "uploading",
			ratio: 2.5,
			instanceId: 1,
		});
		mockQuiClient.getCrossSeedMatches.mockResolvedValue([
			{
				tracker: "http://tracker.example/announce",
				infoHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
				matchType: "content_path",
				trackerHealth: "healthy",
			},
		]);

		const res = await injectAuthenticated("POST", "/qui/library-item/torrent-state", {
			body: {
				arrInstanceId: "inst-1",
				arrItemId: 1,
				itemType: "movie",
			},
		});
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.supported).toBe(true);
		expect(body.torrent).toBeDefined();
		expect(body.siblings).toHaveLength(1);
	});

	it("write-throughs normalized torrent state to LibraryCache", async () => {
		// Phase 2.1: per-item endpoint must persist state to LibraryCache so
		// the Library filter sees recently-viewed items even before the
		// 10-minute periodic sync ticks. Asserts the normalizer runs (uploading
		// + stalledUP both → seeding) and ratio + syncedAt are recorded.
		mockPrisma.libraryCache.findFirst.mockResolvedValue({
			id: "cache-1",
			infoHash: VALID_HASH,
		});
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(makeQuiInstance());
		mockQuiClient.getTorrentByHash.mockResolvedValue({
			hash: VALID_HASH,
			state: "stalledUP",
			ratio: 1.42,
			instanceId: 1,
		});
		mockQuiClient.getCrossSeedMatches.mockResolvedValue([]);

		const res = await injectAuthenticated("POST", "/qui/library-item/torrent-state", {
			body: { arrInstanceId: "inst-1", arrItemId: 1, itemType: "movie" },
		});
		expect(res.statusCode).toBe(200);
		expect(mockPrisma.libraryCache.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "cache-1" },
				data: expect.objectContaining({
					torrentState: "seeding",
					torrentRatio: 1.42,
					torrentSyncedAt: expect.any(Date),
				}),
			}),
		);
	});

	it("handles series cache lookup successfully", async () => {
		mockPrisma.libraryCache.findFirst.mockResolvedValue({
			id: "cache-2",
			infoHash: VALID_HASH,
		});
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(makeQuiInstance());
		mockQuiClient.getTorrentByHash.mockResolvedValue({
			hash: VALID_HASH,
			name: "Test Series Torrent",
			state: "seeding",
			ratio: 1.0,
		});
		mockQuiClient.getCrossSeedMatches.mockResolvedValue([]);

		const res = await injectAuthenticated("POST", "/qui/library-item/torrent-state", {
			body: {
				arrInstanceId: "inst-2",
				arrItemId: 5,
				itemType: "series",
			},
		});
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.supported).toBe(true);
		expect(body.torrent.state).toBe("seeding");
	});

	it("returns infoHash but no torrent when QUI instance is not configured", async () => {
		mockPrisma.libraryCache.findFirst.mockResolvedValue({
			id: "cache-1",
			infoHash: VALID_HASH,
		});
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(null);

		const res = await injectAuthenticated("POST", "/qui/library-item/torrent-state", {
			body: {
				arrInstanceId: "inst-1",
				arrItemId: 1,
				itemType: "movie",
			},
		});
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.supported).toBe(true);
		expect(body.infoHash).toBe(VALID_HASH);
		expect(body.torrent).toBe(null);
	});

	it("does lazy backfill when infoHash is missing from cache", async () => {
		mockPrisma.libraryCache.findFirst.mockResolvedValue({
			id: "cache-1",
			infoHash: null,
		});
		// Mock Radarr instance for backfill
		mockPrisma.serviceInstance.findFirst.mockResolvedValueOnce({
			id: "inst-1",
			baseUrl: "http://radarr.test",
			encryptedApiKey: "enc",
			encryptionIv: "iv",
			service: "RADARR",
			label: "radarr main",
		});
		// Mock history response
		const arrClientFactory = (
			app as unknown as { arrClientFactory: { rawRequest: ReturnType<typeof vi.fn> } }
		).arrClientFactory;
		// Subpath /history/movie returns a flat array, not paginated `{ records: [] }`.
		arrClientFactory.rawRequest.mockResolvedValueOnce({
			ok: true,
			json: async () => [{ downloadId: VALID_HASH.toUpperCase() }],
		});
		// Mock QUI instance
		mockPrisma.serviceInstance.findFirst.mockResolvedValueOnce(makeQuiInstance());
		mockQuiClient.getTorrentByHash.mockResolvedValue({
			hash: VALID_HASH,
			name: "Backfilled Torrent",
			state: "downloading",
			ratio: 0.5,
		});
		mockQuiClient.getCrossSeedMatches.mockResolvedValue([]);

		const res = await injectAuthenticated("POST", "/qui/library-item/torrent-state", {
			body: {
				arrInstanceId: "inst-1",
				arrItemId: 1,
				itemType: "movie",
			},
		});
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.supported).toBe(true);
		expect(body.infoHash).toBe(VALID_HASH.toLowerCase());
		expect(body.torrent.state).toBe("downloading");
		expect(mockPrisma.libraryCache.update).toHaveBeenCalled();
	});
});
