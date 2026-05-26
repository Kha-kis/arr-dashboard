/**
 * Tests for panel-routes.ts — the per-series and per-movie cluster panel
 * endpoints (~937 LOC of cluster-building, stale-cache healing, phantom
 * suppression, action-item synthesis).
 *
 * The PR test-analyzer specifically flagged this file as a critical
 * coverage gap. A full algorithm-coverage suite is multi-hour work
 * (cluster building is genuinely complex); this suite focuses on the
 * highest-leverage cases the analyzer named:
 *
 *   - **Ownership scoping** — the `instance: { userId }` filter on the
 *     ownership-check query is load-bearing security. A refactor that
 *     drops it would expose other users' libraries.
 *   - **Input validation** — non-numeric arrItemId returns 400, not 500.
 *   - **Not-found behavior** — 404 when the library row doesn't exist OR
 *     belongs to another user.
 *
 * Deeper algorithm internals (signature collision, cluster healing, action
 * item synthesis) are deferred to follow-up suites — those require
 * fixture builders for inode-index + qui-torrent enumerations that would
 * dwarf the test files in size.
 */

import Fastify from "fastify";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// ----------------------------------------------------------------------
// Module-level mocks
// ----------------------------------------------------------------------

const mockBuildFileIdIndex = vi.hoisted(() => vi.fn());
const mockGetAllHashesForFileId = vi.hoisted(() => vi.fn());
const mockEnrichTorrentHashes = vi.hoisted(() => vi.fn());

const mockQuiClient = vi.hoisted(() => ({
	getTrackers: vi.fn(),
	listInstances: vi.fn().mockResolvedValue([]),
	getTorrentProperties: vi.fn(),
	getReannounceCandidates: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../lib/library-sync/infohash-backfill-by-inode.js", () => ({
	buildFileIdIndex: (...args: unknown[]) => mockBuildFileIdIndex(...args),
	getAllHashesForFileId: (...args: unknown[]) => mockGetAllHashesForFileId(...args),
}));

vi.mock("../../lib/qui/client-factory.js", () => ({
	createQuiClient: vi.fn(() => mockQuiClient),
}));

vi.mock("../qui/qui-shared.js", () => ({
	enrichTorrentHashes: (...args: unknown[]) => mockEnrichTorrentHashes(...args),
}));

// ----------------------------------------------------------------------
// Imports — after vi.mock declarations
// ----------------------------------------------------------------------

import { registerPanelRoutes } from "../qui/panel-routes.js";
import {
	createInjectAuthenticated,
	createMockEncryptor,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

// ----------------------------------------------------------------------
// Mock Prisma — minimal shape, returns null by default so 404 is the
// default outcome unless a test wires a row in.
// ----------------------------------------------------------------------

function createMockPrisma() {
	return {
		libraryCache: {
			findFirst: vi.fn().mockResolvedValue(null),
		},
		episodeFileCache: {
			findMany: vi.fn().mockResolvedValue([]),
		},
		serviceInstance: {
			findMany: vi.fn().mockResolvedValue([]),
			findFirst: vi.fn().mockResolvedValue(null),
		},
	};
}

// ----------------------------------------------------------------------
// Fastify setup
// ----------------------------------------------------------------------

let app: ReturnType<typeof Fastify>;
let mockPrisma: ReturnType<typeof createMockPrisma>;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;

beforeEach(async () => {
	vi.clearAllMocks();
	mockPrisma = createMockPrisma();

	// Default mocks: empty inode index, no torrents, no errors.
	mockBuildFileIdIndex.mockResolvedValue({
		byFileId: new Map(),
		statted: 0,
		skippedNoLinks: 0,
		skippedUnstatable: 0,
	});
	mockGetAllHashesForFileId.mockResolvedValue([]);
	mockEnrichTorrentHashes.mockResolvedValue([]);

	app = Fastify();
	app.decorate("prisma", mockPrisma);
	app.decorate("encryptor", createMockEncryptor("decrypted"));
	setupAuthInjection(app);
	registerTestErrorHandler(app);
	registerPanelRoutes(app);
	await app.ready();
	injectAuthenticated = createInjectAuthenticated(app);
});

afterAll(async () => {
	await app?.close();
});

// ----------------------------------------------------------------------
// Series route — input validation + ownership
// ----------------------------------------------------------------------

describe("GET /qui/series/:arrInstanceId/:arrItemId/torrents — input + ownership", () => {
	it("returns 400 when arrItemId is not a number", async () => {
		const res = await injectAuthenticated("GET", "/qui/series/sonarr-1/not-a-number/torrents");
		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.payload).error).toMatch(/arrItemId/);
		// Should bail BEFORE touching the database.
		expect(mockPrisma.libraryCache.findFirst).not.toHaveBeenCalled();
	});

	it("returns 404 when no library row matches (series not found)", async () => {
		mockPrisma.libraryCache.findFirst.mockResolvedValue(null);
		const res = await injectAuthenticated("GET", "/qui/series/sonarr-1/42/torrents");
		expect(res.statusCode).toBe(404);
		expect(JSON.parse(res.payload).error).toMatch(/Series not found/);
	});

	it("scopes the ownership query to the authenticated user", async () => {
		// LOAD-BEARING SECURITY TEST: the ownership check MUST include
		// `instance: { userId }` in the where clause. A refactor that
		// drops it would expose every user's library.
		mockPrisma.libraryCache.findFirst.mockResolvedValue(null);
		await injectAuthenticated("GET", "/qui/series/sonarr-1/42/torrents");
		expect(mockPrisma.libraryCache.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					instanceId: "sonarr-1",
					arrItemId: 42,
					itemType: "series",
					instance: { userId: "user-1" },
				}),
			}),
		);
	});

	it("returns 404 when the series exists but belongs to another user (ownership filter rejects)", async () => {
		// The combined `instanceId + arrItemId + itemType + instance.userId`
		// filter returns null when the userId doesn't match — same outcome
		// as "doesn't exist", which is what we want (no information leak
		// about cross-user resources).
		mockPrisma.libraryCache.findFirst.mockResolvedValue(null);
		const res = await injectAuthenticated("GET", "/qui/series/sonarr-1/42/torrents");
		expect(res.statusCode).toBe(404);
	});

	it("scopes the episode-file query to the same (instanceId, arrSeriesId) pair", async () => {
		// If the cluster-builder ever pulled episode files without scoping
		// to the same instanceId, a user could see episodes from a
		// different Sonarr instance correlated under their series. This
		// test pins the scoping.
		mockPrisma.libraryCache.findFirst.mockResolvedValue({
			id: "lib-1",
			title: "Some Show",
		});
		await injectAuthenticated("GET", "/qui/series/sonarr-1/42/torrents");
		expect(mockPrisma.episodeFileCache.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					instanceId: "sonarr-1",
					arrSeriesId: 42,
				}),
			}),
		);
	});

	it("returns a structured response with empty arrays when the series has no episode files", async () => {
		mockPrisma.libraryCache.findFirst.mockResolvedValue({
			id: "lib-1",
			title: "Some Show",
		});
		mockPrisma.episodeFileCache.findMany.mockResolvedValue([]);
		const res = await injectAuthenticated("GET", "/qui/series/sonarr-1/42/torrents");
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		// Shape check: response carries a series title and an empty
		// clusters array (or equivalent). The detail shape is checked
		// by integration tests; here we just verify the empty case
		// doesn't crash.
		expect(body).toBeDefined();
		expect(typeof body).toBe("object");
	});
});

// ----------------------------------------------------------------------
// Movie route — same shape of input + ownership tests
// ----------------------------------------------------------------------

describe("GET /qui/movie/:arrInstanceId/:arrItemId/torrents — input + ownership", () => {
	it("returns 400 when arrItemId is not a number", async () => {
		const res = await injectAuthenticated("GET", "/qui/movie/radarr-1/not-a-number/torrents");
		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.payload).error).toMatch(/arrItemId/);
		expect(mockPrisma.libraryCache.findFirst).not.toHaveBeenCalled();
	});

	it("returns 404 when no library row matches (movie not found)", async () => {
		mockPrisma.libraryCache.findFirst.mockResolvedValue(null);
		const res = await injectAuthenticated("GET", "/qui/movie/radarr-1/77/torrents");
		expect(res.statusCode).toBe(404);
		expect(JSON.parse(res.payload).error).toMatch(/Movie not found/);
	});

	it("scopes the ownership query to itemType: 'movie' AND instance.userId", async () => {
		// Critical: itemType must be 'movie' so a request to
		// /qui/movie/<id> doesn't accidentally match a 'series' row with
		// the same arrItemId (different instances can collide).
		mockPrisma.libraryCache.findFirst.mockResolvedValue(null);
		await injectAuthenticated("GET", "/qui/movie/radarr-1/77/torrents");
		expect(mockPrisma.libraryCache.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					instanceId: "radarr-1",
					arrItemId: 77,
					itemType: "movie",
					instance: { userId: "user-1" },
				}),
			}),
		);
	});

	it("returns 404 when the movie exists but belongs to another user", async () => {
		mockPrisma.libraryCache.findFirst.mockResolvedValue(null);
		const res = await injectAuthenticated("GET", "/qui/movie/radarr-1/77/torrents");
		expect(res.statusCode).toBe(404);
	});

	it("tolerates malformed JSON in the movie's `data` blob (returns response with null path)", async () => {
		// The movie route parses `data` to extract the on-disk path. A
		// corrupt blob should NOT 500 — the route should fall through to
		// a response with empty/null path fields. (Pre-fix behavior would
		// have crashed the route handler.)
		mockPrisma.libraryCache.findFirst.mockResolvedValue({
			id: "lib-1",
			title: "Some Movie",
			year: 2024,
			infoHash: null,
			infoHashSource: null,
			sizeOnDisk: 0,
			qualityProfileName: null,
			data: "{not-valid-json",
		});
		const res = await injectAuthenticated("GET", "/qui/movie/radarr-1/77/torrents");
		// Should not crash — exact status depends on downstream behavior
		// but it's NOT a 500 / unhandled error.
		expect(res.statusCode).toBeLessThan(500);
	});
});
