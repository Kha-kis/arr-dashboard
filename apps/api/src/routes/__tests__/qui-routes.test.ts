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
	bulkAction: vi.fn(),
	createNotificationTarget: vi.fn(),
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
		quiActionLog: {
			create: vi.fn().mockResolvedValue({ id: "row-x" }),
			updateMany: vi.fn().mockResolvedValue({ count: 0 }),
			findUnique: vi.fn().mockResolvedValue(null),
			findMany: vi.fn().mockResolvedValue([]),
		},
		// Phase 5.1 — webhook config persists `hashedQuiWebhookSecret` on the
		// User row; Phase 5.1/5.2 events live in QuiEventLog.
		user: {
			findUniqueOrThrow: vi.fn().mockResolvedValue({ hashedQuiWebhookSecret: null }),
			update: vi.fn().mockResolvedValue({}),
		},
		quiEventLog: {
			findMany: vi.fn().mockResolvedValue([]),
			findUnique: vi.fn().mockResolvedValue(null),
		},
		// SystemSettings — read by `resolvePublicBaseUrl` to honor the
		// admin-configured external URL when building the webhook URL we
		// surface to operators. `null` means "no override; fall back to
		// app.config.APP_URL" — which is the default the route handler
		// exercises in most tests.
		systemSettings: {
			findUnique: vi.fn().mockResolvedValue(null),
		},
		// $transaction(operations[]) — returns the resolved values of each op.
		// Our route only reads `.id` from each so the trivial stub suffices.
		$transaction: vi.fn((ops: unknown[]) =>
			Promise.resolve(ops.map((_, i) => ({ id: `row-${i}` }))),
		),
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
	// Phase 5.1 — webhook-config routes resolve the public base URL via
	// `app.config.APP_URL`. The real plugin wires this from validated env;
	// the test stub just needs a string the route can substring-match.
	app.decorate("config", { APP_URL: "http://localhost:3000" });

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

// ────────────────────────────────────────────────────────────────────────
// Phase 4.1 — single-torrent action route
// ────────────────────────────────────────────────────────────────────────

describe("POST /qui/instances/:id/qbit/:instanceId/torrents/:hash/actions/:action", () => {
	it("invokes qui.bulkAction with [hash] and returns success", async () => {
		mockQuiClient.bulkAction.mockResolvedValue(undefined);
		const res = await injectAuthenticated(
			"POST",
			`/qui/instances/qui-1/qbit/3/torrents/${VALID_HASH}/actions/pause`,
			{ body: {} },
		);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.status).toBe("success");
		expect(body.logRowCount).toBe(1);
		// qui call shape pins the bulk-action contract — if a future refactor
		// changes field names, the wire format breaks and qui returns 400.
		expect(mockQuiClient.bulkAction).toHaveBeenCalledWith({
			qbitInstanceId: 3,
			hashes: [VALID_HASH],
			action: "pause",
			tags: undefined,
		});
	});

	it("returns 502 with the qui error message when bulkAction throws", async () => {
		mockQuiClient.bulkAction.mockRejectedValue(
			new Error("qui request to /api/instances/3/torrents/bulk-action failed: 502 Bad Gateway"),
		);
		const res = await injectAuthenticated(
			"POST",
			`/qui/instances/qui-1/qbit/3/torrents/${VALID_HASH}/actions/pause`,
			{ body: {} },
		);
		// The route surfaces upstream failure as 502 and includes the
		// underlying message so the UI can render a meaningful toast.
		expect(res.statusCode).toBe(502);
		const body = JSON.parse(res.payload);
		expect(body.message).toMatch(/502 Bad Gateway/);
	});

	it("returns 400 on an unknown action", async () => {
		const res = await injectAuthenticated(
			"POST",
			`/qui/instances/qui-1/qbit/3/torrents/${VALID_HASH}/actions/explode`,
			{ body: {} },
		);
		// Action enum is locked at the Zod boundary; arr-dashboard never
		// forwards an unsupported verb to qui's much-larger action vocabulary.
		expect(res.statusCode).toBe(400);
	});

	it("returns 400 on an invalid hash format", async () => {
		const res = await injectAuthenticated(
			"POST",
			"/qui/instances/qui-1/qbit/3/torrents/not-a-hash/actions/pause",
			{ body: {} },
		);
		expect(res.statusCode).toBe(400);
	});

	it("returns 400 on a non-numeric qbit instanceId", async () => {
		const res = await injectAuthenticated(
			"POST",
			`/qui/instances/qui-1/qbit/abc/torrents/${VALID_HASH}/actions/pause`,
			{ body: {} },
		);
		expect(res.statusCode).toBe(400);
	});

	it("returns 404 for a non-owned qui instance (cross-user isolation)", async () => {
		mockRequireQuiInstance.mockRejectedValue(new InstanceNotFoundError("qui-999"));
		const res = await injectAuthenticated(
			"POST",
			`/qui/instances/qui-999/qbit/3/torrents/${VALID_HASH}/actions/pause`,
			{ body: {} },
		);
		expect(res.statusCode).toBe(404);
		// Tenant-isolation invariant: the qui client must never be created
		// for an instance the caller doesn't own — otherwise we'd leak the
		// decrypted API key into a mutation request scoped to someone else.
		expect(mockQuiClient.bulkAction).not.toHaveBeenCalled();
	});

	it("forwards setTags `tags` body field to the qui client", async () => {
		mockQuiClient.bulkAction.mockResolvedValue(undefined);
		const res = await injectAuthenticated(
			"POST",
			`/qui/instances/qui-1/qbit/3/torrents/${VALID_HASH}/actions/setTags`,
			{ body: { tags: "verified,seedonly" } },
		);
		expect(res.statusCode).toBe(200);
		expect(mockQuiClient.bulkAction).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "setTags",
				tags: "verified,seedonly",
			}),
		);
	});

	it("rejects setTags without a `tags` body (discriminated invariant)", async () => {
		// setTags is the only action whose body matters. Empty body should
		// fail at the route layer, not at qui — otherwise we write a
		// misleading audit row with payload: null for a tag-set request.
		const res = await injectAuthenticated(
			"POST",
			`/qui/instances/qui-1/qbit/3/torrents/${VALID_HASH}/actions/setTags`,
			{ body: {} },
		);
		expect(res.statusCode).toBe(400);
		expect(mockQuiClient.bulkAction).not.toHaveBeenCalled();
	});
});

// ────────────────────────────────────────────────────────────────────────
// Phase 4.2 — bulk-action route (same service, hashes[] in body)
// ────────────────────────────────────────────────────────────────────────

describe("POST /qui/instances/:id/qbit/:instanceId/torrents/bulk-action/:action", () => {
	const HASH_A = VALID_HASH;
	const HASH_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

	it("forwards the full hashes[] to qui.bulkAction in one call", async () => {
		mockQuiClient.bulkAction.mockResolvedValue(undefined);
		const res = await injectAuthenticated(
			"POST",
			"/qui/instances/qui-1/qbit/3/torrents/bulk-action/pause",
			{ body: { hashes: [HASH_A, HASH_B] } },
		);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.status).toBe("success");
		expect(body.logRowCount).toBe(2);
		// The route must hand qui ALL hashes in one POST — splitting into
		// N single-hash calls would defeat the audit-log batch boundary
		// (one requestedAt timestamp per bulk action vs N timestamps).
		expect(mockQuiClient.bulkAction).toHaveBeenCalledOnce();
		expect(mockQuiClient.bulkAction).toHaveBeenCalledWith({
			qbitInstanceId: 3,
			hashes: [HASH_A, HASH_B],
			action: "pause",
			tags: undefined,
		});
	});

	it("returns 400 on empty hashes[]", async () => {
		const res = await injectAuthenticated(
			"POST",
			"/qui/instances/qui-1/qbit/3/torrents/bulk-action/pause",
			{ body: { hashes: [] } },
		);
		expect(res.statusCode).toBe(400);
		expect(mockQuiClient.bulkAction).not.toHaveBeenCalled();
	});

	it("rejects more than 500 hashes (server-side cap)", async () => {
		const hashes = Array.from({ length: 501 }, (_, i) => i.toString(16).padStart(40, "0"));
		const res = await injectAuthenticated(
			"POST",
			"/qui/instances/qui-1/qbit/3/torrents/bulk-action/pause",
			{ body: { hashes } },
		);
		// Cap exists because qui's bulk-action accepts arbitrary array sizes
		// but our audit-log $transaction grows linearly with hash count;
		// rejecting too-large requests at the boundary prevents one massive
		// audit-row insert from blocking other writes.
		expect(res.statusCode).toBe(400);
	});

	it("rejects bulk requests with non-hex hashes", async () => {
		// Pre-fix versions only required `min(1)` per hash element; bulk
		// could pass arbitrary strings through to qui + the audit log.
		// The route schema now requires the qBit info-hash format for
		// every element.
		const res = await injectAuthenticated(
			"POST",
			"/qui/instances/qui-1/qbit/3/torrents/bulk-action/pause",
			{ body: { hashes: [VALID_HASH, "not-a-hash"] } },
		);
		expect(res.statusCode).toBe(400);
		expect(mockQuiClient.bulkAction).not.toHaveBeenCalled();
	});
});

// ────────────────────────────────────────────────────────────────────────
// Phase 4.1 — action log feed
// ────────────────────────────────────────────────────────────────────────

describe("GET /qui/actions", () => {
	it("returns rows scoped to the caller's userId, newest first", async () => {
		mockPrisma.quiActionLog.findMany.mockResolvedValue([
			{
				id: "log-1",
				userId: "user-1",
				serviceInstanceId: "qui-1",
				qbitInstanceId: 3,
				torrentHash: VALID_HASH,
				action: "pause",
				status: "success",
				error: null,
				payload: null,
				requestedAt: new Date("2026-05-14T10:00:00Z"),
				completedAt: new Date("2026-05-14T10:00:01Z"),
				serviceInstance: { label: "qui main" },
			},
		]);
		const res = await injectAuthenticated("GET", "/qui/actions");
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.entries).toHaveLength(1);
		expect(body.entries[0].action).toBe("pause");
		expect(body.entries[0].status).toBe("success");
		expect(body.entries[0].serviceInstanceLabel).toBe("qui main");
		// The findMany filter MUST include userId — otherwise the feed
		// would surface other tenants' actions. Verified explicitly.
		expect(mockPrisma.quiActionLog.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ userId: "user-1" }),
			}),
		);
	});

	it("ignores a cursor that does not belong to the caller (no enumeration)", async () => {
		// Simulate: cursor "log-other" exists but is owned by a different user.
		// The route's anchor check must reject it; the resulting query is
		// run without `cursorRequestedAt`, i.e. from the top of the user's
		// own feed — NOT from the foreign cursor's timestamp.
		mockPrisma.quiActionLog.findUnique.mockResolvedValue({
			requestedAt: new Date("2099-01-01T00:00:00Z"),
			userId: "user-foreign",
		});
		mockPrisma.quiActionLog.findMany.mockResolvedValue([]);
		const res = await injectAuthenticated("GET", "/qui/actions?cursor=log-other");
		expect(res.statusCode).toBe(200);
		const findManyArgs = mockPrisma.quiActionLog.findMany.mock.calls[0]?.[0];
		expect(findManyArgs.where).not.toHaveProperty("requestedAt");
	});

	it("filters by action when ?action=pause is provided", async () => {
		mockPrisma.quiActionLog.findMany.mockResolvedValue([]);
		await injectAuthenticated("GET", "/qui/actions?action=pause");
		const args = mockPrisma.quiActionLog.findMany.mock.calls[0]?.[0];
		expect(args.where).toMatchObject({ action: "pause" });
	});

	it("rejects an unknown ?action value", async () => {
		const res = await injectAuthenticated("GET", "/qui/actions?action=explode");
		expect(res.statusCode).toBe(400);
	});
});

// ────────────────────────────────────────────────────────────────────────
// Phase 5.1 — webhook config (GET / rotate / register)
// ────────────────────────────────────────────────────────────────────────

describe("GET /qui/webhook-config", () => {
	it("reports hasSecret=false when the user has never rotated", async () => {
		mockPrisma.user.findUniqueOrThrow.mockResolvedValue({ hashedQuiWebhookSecret: null });
		const res = await injectAuthenticated("GET", "/qui/webhook-config");
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.hasSecret).toBe(false);
		expect(body.webhookUrl).toMatch(/\/api\/webhooks\/qui$/);
		// CRITICAL — GET never returns the plaintext secret. The plaintext
		// only exists at rotation time; persisting/echoing it from the DB
		// would break the "shown once" invariant the operator relies on.
		expect(body).not.toHaveProperty("secret");
	});

	it("reports hasSecret=true when a hash is stored, still without plaintext", async () => {
		mockPrisma.user.findUniqueOrThrow.mockResolvedValue({
			hashedQuiWebhookSecret: "deadbeef".repeat(8),
		});
		const res = await injectAuthenticated("GET", "/qui/webhook-config");
		const body = JSON.parse(res.payload);
		expect(body.hasSecret).toBe(true);
		expect(body).not.toHaveProperty("secret");
	});
});

describe("POST /qui/webhook-config/rotate", () => {
	it("generates a fresh secret + persists its hash + returns plaintext exactly once", async () => {
		const res = await injectAuthenticated("POST", "/qui/webhook-config/rotate", { body: {} });
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.hasSecret).toBe(true);
		expect(typeof body.secret).toBe("string");
		expect(body.secret.length).toBeGreaterThanOrEqual(40);
		// User.update must persist the *hash*, never the plaintext. Verifying
		// this explicitly because an accidental "store plaintext" regression
		// would be a silent leak — caller-side tests would still pass.
		expect(mockPrisma.user.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					hashedQuiWebhookSecret: expect.any(String),
				}),
			}),
		);
		const persisted = mockPrisma.user.update.mock.calls[0]?.[0].data.hashedQuiWebhookSecret;
		expect(persisted).not.toEqual(body.secret); // hash != plaintext
		// SHA-256 hex digests are exactly 64 chars; anything else means we're
		// not actually hashing the value before persisting it.
		expect(persisted).toMatch(/^[a-f0-9]{64}$/);
	});
});

describe("POST /qui/instances/:id/webhook-config/register", () => {
	it("rejects with 409 when no secret has been generated yet", async () => {
		mockPrisma.user.findUniqueOrThrow.mockResolvedValue({ hashedQuiWebhookSecret: null });
		mockRequireQuiInstance.mockResolvedValue(makeQuiInstance());
		const res = await injectAuthenticated("POST", "/qui/instances/qui-1/webhook-config/register", {
			body: { secret: "x".repeat(32) },
		});
		// 409 because the resource state ("no secret configured") conflicts
		// with the request preconditions. The frontend uses this to prompt
		// "Rotate first" instead of failing silently.
		expect(res.statusCode).toBe(409);
		expect(mockQuiClient.createNotificationTarget).not.toHaveBeenCalled();
	});

	it("rejects with 400 when the inline secret is missing or too short", async () => {
		mockPrisma.user.findUniqueOrThrow.mockResolvedValue({
			hashedQuiWebhookSecret: "deadbeef".repeat(8),
		});
		mockRequireQuiInstance.mockResolvedValue(makeQuiInstance());
		const res = await injectAuthenticated("POST", "/qui/instances/qui-1/webhook-config/register", {
			body: { secret: "short" },
		});
		// The 16-char floor mirrors the receiver's secret-length guard —
		// rejecting at registration prevents the operator from wiring up an
		// unguessable-yet-truncated value that the receiver would refuse anyway.
		expect(res.statusCode).toBe(400);
		expect(mockQuiClient.createNotificationTarget).not.toHaveBeenCalled();
	});

	it("forwards the registration to qui with URL containing the operator-supplied secret", async () => {
		mockPrisma.user.findUniqueOrThrow.mockResolvedValue({
			hashedQuiWebhookSecret: "deadbeef".repeat(8),
		});
		mockRequireQuiInstance.mockResolvedValue(makeQuiInstance());
		mockQuiClient.createNotificationTarget.mockResolvedValue({ id: "target-42" });
		const res = await injectAuthenticated("POST", "/qui/instances/qui-1/webhook-config/register", {
			body: { secret: "a".repeat(32), eventTypes: ["torrent_added"] },
		});
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.payload)).toMatchObject({ ok: true, quiTargetId: "target-42" });
		// The URL must end with the secret as a query param so qui's
		// ApiKeyQuery security scheme picks it up. URL-encoding is applied
		// at the route layer; the secret is hex-clean here so we just check
		// the substring.
		const call = mockQuiClient.createNotificationTarget.mock.calls[0]?.[0];
		expect(call.name).toBe("arr-dashboard");
		expect(call.url).toContain("/api/webhooks/qui?secret=");
		expect(call.url).toContain("a".repeat(32));
		expect(call.eventTypes).toEqual(["torrent_added"]);
		expect(call.enabled).toBe(true);
	});

	it("returns 502 when qui rejects the registration call", async () => {
		mockPrisma.user.findUniqueOrThrow.mockResolvedValue({
			hashedQuiWebhookSecret: "deadbeef".repeat(8),
		});
		mockRequireQuiInstance.mockResolvedValue(makeQuiInstance());
		mockQuiClient.createNotificationTarget.mockRejectedValue(new Error("qui refused: 409"));
		const res = await injectAuthenticated("POST", "/qui/instances/qui-1/webhook-config/register", {
			body: { secret: "a".repeat(32) },
		});
		// 502 (bad gateway) rather than 500 — the upstream is the failure
		// site, not arr-dashboard itself. Frontend renders the qui-side
		// error message verbatim so the operator can fix the qui config.
		expect(res.statusCode).toBe(502);
	});
});

// ────────────────────────────────────────────────────────────────────────
// Phase 5.1/5.2 — event log feed
// ────────────────────────────────────────────────────────────────────────

describe("GET /qui/events", () => {
	it("returns events scoped to the caller's userId, newest first", async () => {
		mockPrisma.quiEventLog.findMany.mockResolvedValue([
			{
				id: "evt-1",
				userId: "user-1",
				serviceInstanceId: "qui-1",
				eventType: "torrent_added",
				torrentHash: VALID_HASH,
				payload: JSON.stringify({ type: "torrent_added", payload: { hash: VALID_HASH } }),
				receivedAt: new Date("2026-05-14T10:00:00Z"),
			},
		]);
		const res = await injectAuthenticated("GET", "/qui/events");
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.entries).toHaveLength(1);
		expect(body.entries[0].eventType).toBe("torrent_added");
		expect(body.entries[0].torrentHash).toBe(VALID_HASH);
		// Payload is reconstituted from its stored JSON string — we want
		// callers to get a structured object, not raw text. Verifies the
		// safeJsonParse helper is wired in.
		expect(body.entries[0].payload).toEqual({
			type: "torrent_added",
			payload: { hash: VALID_HASH },
		});
		expect(mockPrisma.quiEventLog.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: expect.objectContaining({ userId: "user-1" }) }),
		);
	});

	it("ignores a cursor that belongs to a different user (cross-tenant defense)", async () => {
		// Cursor anchor exists but is owned by user-foreign. The route's
		// userId check must reject it; the resulting findMany call runs
		// without a receivedAt filter, i.e. from the top of user-1's feed.
		mockPrisma.quiEventLog.findUnique.mockResolvedValue({
			receivedAt: new Date("2099-01-01T00:00:00Z"),
			userId: "user-foreign",
		});
		mockPrisma.quiEventLog.findMany.mockResolvedValue([]);
		const res = await injectAuthenticated("GET", "/qui/events?cursor=evt-other");
		expect(res.statusCode).toBe(200);
		const findManyArgs = mockPrisma.quiEventLog.findMany.mock.calls[0]?.[0];
		expect(findManyArgs.where).not.toHaveProperty("receivedAt");
	});

	it("paginates with a nextCursor when more rows exist than the limit", async () => {
		const rows = Array.from({ length: 51 }, (_, i) => ({
			id: `evt-${i}`,
			userId: "user-1",
			serviceInstanceId: null,
			eventType: "torrent_added",
			torrentHash: null,
			payload: "null",
			receivedAt: new Date(Date.now() - i * 1000),
		}));
		mockPrisma.quiEventLog.findMany.mockResolvedValue(rows);
		const res = await injectAuthenticated("GET", "/qui/events?limit=50");
		const body = JSON.parse(res.payload);
		// 51 rows came back (take = limit+1 sentinel), so we serve 50 and
		// flag that more exist via nextCursor — the LAST returned row's id.
		expect(body.entries).toHaveLength(50);
		expect(body.nextCursor).toBe("evt-49");
	});
});
