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
	getTorrentProperties: vi.fn(),
	getTorrentFiles: vi.fn(),
	listCategories: vi.fn(),
	listTags: vi.fn(),
	getCapabilities: vi.fn(),
	getTransferInfo: vi.fn(),
	getFileMediaInfo: vi.fn(),
	getReannounceCandidates: vi.fn().mockResolvedValue([]),
	renameTorrent: vi.fn(),
	addTrackers: vi.fn(),
	removeTrackers: vi.fn(),
	editTracker: vi.fn(),
	createNotificationTarget: vi.fn(),
	triggerDirScan: vi.fn(),
}));

vi.mock("../../lib/qui/client-factory.js", () => ({
	createQuiClient: vi.fn(() => mockQuiClient),
}));

// Mocked backfill sweeps for the /qui/backfill/run-now route test. Each
// sweep returns its real result shape so the route's aggregate-flatten
// logic can be exercised end-to-end. The sweeps themselves are unit-
// tested elsewhere; here we only care about the response-shape contract
// between the route and the client.
const { mockRunPathBackfillSweep, mockRunEpisodeFileSync, mockRunEpisodeBackfillSweep } =
	vi.hoisted(() => ({
		mockRunPathBackfillSweep: vi.fn(),
		mockRunEpisodeFileSync: vi.fn(),
		mockRunEpisodeBackfillSweep: vi.fn(),
	}));

vi.mock("../../lib/library-sync/infohash-backfill-by-path.js", () => ({
	runPathBackfillSweep: (...args: unknown[]) => mockRunPathBackfillSweep(...args),
}));

vi.mock("../../lib/library-sync/episode-file-backfill.js", () => ({
	runEpisodeFileSync: (...args: unknown[]) => mockRunEpisodeFileSync(...args),
	runEpisodeBackfillSweep: (...args: unknown[]) => mockRunEpisodeBackfillSweep(...args),
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
	it("returns trackers filtered to real trackers only, with passkey URLs stripped to hostnames (#491)", async () => {
		// Mock the INTERNAL shape `getTrackers` resolves to (carries the raw
		// announce URL with passkey embedded). The route is responsible for
		// stripping it before serializing — this test pins that contract end
		// to end so any future regression to a passthrough trips it.
		mockQuiClient.getTrackers.mockResolvedValue([
			{
				url: "https://tracker.example.org/abcdef0123456789abcdef0123456789abcdef01/announce",
				status: 2,
				health: "working",
				msg: "",
				numSeeds: 1,
				numLeeches: 0,
				numPeers: 1,
				tier: 0,
			},
			// Pseudo-tracker (DHT/PeX/LSD) — must be filtered out.
			{
				url: "** [DHT] **",
				status: 0,
				health: "working",
				msg: "",
				numSeeds: 0,
				numLeeches: 0,
				numPeers: 0,
			},
		]);
		const res = await injectAuthenticated(
			"GET",
			`/qui/instances/qui-1/qbit/1/torrents/${VALID_HASH}/trackers`,
		);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.trackers).toHaveLength(1);

		// Positive contract: the route exposes hostname, never the raw URL.
		expect(body.trackers[0].hostname).toBe("tracker.example.org");
		expect(body.trackers[0]).not.toHaveProperty("url");

		// Defense-in-depth on the whole payload: no URL form, no `/announce`,
		// no `passkey=` anywhere — catches a regression that re-introduces the
		// raw URL via a sibling field, error path, or future extension.
		expect(res.payload).not.toMatch(/https?:\/\//i);
		expect(res.payload).not.toMatch(/\/announce/);
		expect(res.payload).not.toMatch(/passkey/i);
		// The passkey itself (40-hex from the mock) must not appear anywhere.
		expect(res.payload).not.toContain("abcdef0123456789abcdef0123456789abcdef01");
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
		// The real `getCrossSeedMatches` applies the wire transform that strips
		// passkeys from tracker URLs (see wireCrossSeedMatchSchema in
		// client-factory.ts), so by the time the route sees the match the
		// `tracker` field is already a bare hostname. The mock returns the
		// post-transform shape — anything URL-shaped here would be a bug.
		mockQuiClient.getCrossSeedMatches.mockResolvedValue([
			{
				tracker: "tracker.example.com",
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

		// Defense-in-depth: pin that the route never serializes a tracker URL
		// with a passkey query param or an `/announce`-shaped path. The pattern
		// requires URL form (scheme present) so it doesn't collide with the
		// legitimate 40-hex `hash`/`infoHash` field. If a future change adds a
		// raw-URL passthrough or someone "fixes" the mock to feed in
		// pre-transform data, this assertion fires and reopens issue #486-style
		// silent regression for tracker credentials.
		expect(res.payload).not.toMatch(/https?:\/\/[^"\s]*?(\/announce|passkey=)/i);
		expect(res.payload).not.toMatch(/"passkey"/i);
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
		// `pause` carries no per-action extras, so `extras` is undefined.
		expect(mockQuiClient.bulkAction).toHaveBeenCalledWith({
			qbitInstanceId: 3,
			hashes: [VALID_HASH],
			action: "pause",
			extras: undefined,
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
		// setTags payload travels in `extras` (per-action body). Confirms the
		// post-refactor wire shape: the route validates body against
		// `quiActionPayloadSchemas.setTags`, threads the result through
		// executeQuiAction's `payload`, and the client spreads it under
		// `extras` into qui's POST body.
		expect(mockQuiClient.bulkAction).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "setTags",
				extras: { tags: "verified,seedonly" },
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
			extras: undefined,
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

/**
 * Cross-seed search for stuck library items via qui's dir-scan webhook.
 * The route's job is glue: look up the library row by (arrInstanceId,
 * arrItemId, itemType), extract the on-disk path, hand it to qui's
 * triggerDirScan, and relay qui's status/body to the caller. These
 * tests pin each branch: success path, ownership/lookup failures,
 * malformed library data, missing qui instance, and qui-side errors.
 */
describe("POST /qui/dirscan/trigger", () => {
	const movieLibraryRow = {
		id: "lc-1",
		title: "Some Movie",
		itemType: "movie",
		infoHash: null,
		data: JSON.stringify({
			path: "/data/media/movies/Some Movie (2024)",
			movieFile: { relativePath: "Some Movie (2024).mkv" },
		}),
	};

	const validBody = {
		arrInstanceId: "radarr-1",
		arrItemId: 42,
		itemType: "movie",
	};

	it("triggers qui dir-scan and returns the run id on success", async () => {
		mockPrisma.libraryCache.findFirst.mockResolvedValue(movieLibraryRow);
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(makeQuiInstance());
		mockQuiClient.triggerDirScan.mockResolvedValue({
			runId: 99,
			directoryId: 1,
			directoryPath: "/data/media/movies",
			scanRoot: "/data/media/movies/Some Movie (2024)/Some Movie (2024).mkv",
		});

		const res = await injectAuthenticated("POST", "/qui/dirscan/trigger", { body: validBody });
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.runId).toBe(99);
		expect(body.scanRoot).toBe("/data/media/movies/Some Movie (2024)/Some Movie (2024).mkv");
		// The path qui was given must be derived from movieFile.path + relativePath.
		expect(mockQuiClient.triggerDirScan).toHaveBeenCalledWith(
			"/data/media/movies/Some Movie (2024)/Some Movie (2024).mkv",
		);
	});

	it("returns 400 when arrInstanceId is missing (input validation)", async () => {
		const res = await injectAuthenticated("POST", "/qui/dirscan/trigger", {
			body: {
				arrItemId: 42,
				itemType: "movie",
			},
		});
		expect(res.statusCode).toBe(400);
	});

	it("returns 400 when arrItemId is not a number", async () => {
		const res = await injectAuthenticated("POST", "/qui/dirscan/trigger", {
			body: {
				arrInstanceId: "radarr-1",
				arrItemId: "not-a-number",
				itemType: "movie",
			},
		});
		expect(res.statusCode).toBe(400);
	});

	it("returns 404 when the library row doesn't exist for this user (ownership)", async () => {
		// findFirst returns null — no library row matches (instance, item, type)
		// for this user. Critical: the lookup scopes by userId via the
		// instance.userId clause, so a caller can't probe other users' items.
		mockPrisma.libraryCache.findFirst.mockResolvedValue(null);
		const res = await injectAuthenticated("POST", "/qui/dirscan/trigger", { body: validBody });
		expect(res.statusCode).toBe(404);
		expect(JSON.parse(res.payload).error).toContain("not found");
	});

	it("returns 422 when the library row's data lacks the path metadata", async () => {
		// Library row exists but the cached *arr JSON is malformed or pre-file —
		// can't derive a path to scan. 422 (unprocessable) rather than 500,
		// because the data is just incomplete, not an unexpected error.
		mockPrisma.libraryCache.findFirst.mockResolvedValue({
			...movieLibraryRow,
			data: JSON.stringify({
				/* no path field */
			}),
		});
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(makeQuiInstance());
		const res = await injectAuthenticated("POST", "/qui/dirscan/trigger", { body: validBody });
		expect(res.statusCode).toBe(422);
	});

	it("returns 404 when no qui instance is available for this user", async () => {
		mockPrisma.libraryCache.findFirst.mockResolvedValue(movieLibraryRow);
		// No qui instance — user hasn't configured one or has it disabled.
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(null);
		const res = await injectAuthenticated("POST", "/qui/dirscan/trigger", { body: validBody });
		expect(res.statusCode).toBe(404);
		expect(JSON.parse(res.payload).error).toContain("qui instance");
	});

	it("relays qui's 404 verbatim when no configured dir-scan covers the path", async () => {
		mockPrisma.libraryCache.findFirst.mockResolvedValue(movieLibraryRow);
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(makeQuiInstance());
		// qui's WebhookTriggerScan returns 404 when no configured dir-scan
		// directory has a prefix that covers the requested path. We surface
		// that status code AND the message so the UI can render guidance
		// ("set up Dir-Scan in qui's UI for this library path").
		const quiErr = Object.assign(new Error("No matching directory found for the given path"), {
			statusCode: 404,
		});
		mockQuiClient.triggerDirScan.mockRejectedValue(quiErr);
		const res = await injectAuthenticated("POST", "/qui/dirscan/trigger", { body: validBody });
		expect(res.statusCode).toBe(404);
		expect(JSON.parse(res.payload).error).toContain("No matching directory");
	});

	it("relays qui's 409 verbatim when a scan is already in progress", async () => {
		mockPrisma.libraryCache.findFirst.mockResolvedValue(movieLibraryRow);
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(makeQuiInstance());
		const quiErr = Object.assign(new Error("A scan is already in progress for this directory"), {
			statusCode: 409,
		});
		mockQuiClient.triggerDirScan.mockRejectedValue(quiErr);
		const res = await injectAuthenticated("POST", "/qui/dirscan/trigger", { body: validBody });
		expect(res.statusCode).toBe(409);
	});

	it("falls back to 502 when qui throws without a statusCode (unreachable / unknown)", async () => {
		mockPrisma.libraryCache.findFirst.mockResolvedValue(movieLibraryRow);
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(makeQuiInstance());
		// Plain Error with no statusCode — network error, unknown failure.
		// We map to 502 (bad gateway) which is the convention for "upstream
		// service unreachable or returned an unexpected shape".
		mockQuiClient.triggerDirScan.mockRejectedValue(new Error("connect ECONNREFUSED"));
		const res = await injectAuthenticated("POST", "/qui/dirscan/trigger", { body: validBody });
		expect(res.statusCode).toBe(502);
	});

	it("uses the series folder path for series item types (recursive scan)", async () => {
		// Sonarr series rows store the show's root folder, not per-episode
		// paths. qui's dir-scan walks recursively from the scan root, so
		// passing the series folder triggers a search across every episode
		// file inside — same outcome as scanning individual episode paths
		// but with one API call.
		mockPrisma.libraryCache.findFirst.mockResolvedValue({
			id: "lc-2",
			title: "Some Show",
			itemType: "series",
			infoHash: null,
			data: JSON.stringify({ path: "/data/media/tv/Some Show" }),
		});
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(makeQuiInstance());
		mockQuiClient.triggerDirScan.mockResolvedValue({
			runId: 100,
			directoryId: 1,
			directoryPath: "/data/media/tv",
			scanRoot: "/data/media/tv/Some Show",
		});
		const res = await injectAuthenticated("POST", "/qui/dirscan/trigger", {
			body: {
				arrInstanceId: "sonarr-1",
				arrItemId: 7,
				itemType: "series",
			},
		});
		expect(res.statusCode).toBe(200);
		expect(mockQuiClient.triggerDirScan).toHaveBeenCalledWith("/data/media/tv/Some Show");
	});
});

// ────────────────────────────────────────────────────────────────────────
// Phase 6 — torrent mutation routes (rename + tracker CRUD)
//
// These bypass the bulk-action transport because qui exposes them as
// individual endpoints. Audit-log shape uses synthetic `action` values
// prefixed `nonBulk.` to stay distinct from the bulk-action enum.
// ────────────────────────────────────────────────────────────────────────

describe("POST /qui/instances/:id/qbit/:instanceId/torrents/:hash/rename", () => {
	it("calls renameTorrent with the new name and returns success", async () => {
		mockRequireQuiInstance.mockResolvedValue(makeQuiInstance());
		mockQuiClient.renameTorrent.mockResolvedValue(undefined);
		const res = await injectAuthenticated(
			"POST",
			`/qui/instances/qui-1/qbit/3/torrents/${VALID_HASH}/rename`,
			{ body: { name: "Better Linux ISO Name" } },
		);
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.payload).status).toBe("success");
		expect(mockQuiClient.renameTorrent).toHaveBeenCalledWith(
			3,
			VALID_HASH,
			"Better Linux ISO Name",
		);
	});

	it("rejects an empty name (Zod min(1))", async () => {
		mockRequireQuiInstance.mockResolvedValue(makeQuiInstance());
		const res = await injectAuthenticated(
			"POST",
			`/qui/instances/qui-1/qbit/3/torrents/${VALID_HASH}/rename`,
			{ body: { name: "" } },
		);
		expect(res.statusCode).toBe(400);
		expect(mockQuiClient.renameTorrent).not.toHaveBeenCalled();
	});

	it("rejects a name longer than 1024 chars (Zod max bound)", async () => {
		mockRequireQuiInstance.mockResolvedValue(makeQuiInstance());
		const res = await injectAuthenticated(
			"POST",
			`/qui/instances/qui-1/qbit/3/torrents/${VALID_HASH}/rename`,
			{ body: { name: "x".repeat(1025) } },
		);
		expect(res.statusCode).toBe(400);
		expect(mockQuiClient.renameTorrent).not.toHaveBeenCalled();
	});

	it("rejects a non-numeric qbit instance id", async () => {
		mockRequireQuiInstance.mockResolvedValue(makeQuiInstance());
		const res = await injectAuthenticated(
			"POST",
			`/qui/instances/qui-1/qbit/abc/torrents/${VALID_HASH}/rename`,
			{ body: { name: "ok" } },
		);
		expect(res.statusCode).toBe(400);
		expect(mockQuiClient.renameTorrent).not.toHaveBeenCalled();
	});

	it("returns 502 with qui error message when qui rejects the rename", async () => {
		mockRequireQuiInstance.mockResolvedValue(makeQuiInstance());
		mockQuiClient.renameTorrent.mockRejectedValue(
			new Error("qui request to /api/torrents/rename failed: 409 Conflict"),
		);
		const res = await injectAuthenticated(
			"POST",
			`/qui/instances/qui-1/qbit/3/torrents/${VALID_HASH}/rename`,
			{ body: { name: "ok" } },
		);
		expect(res.statusCode).toBe(502);
		expect(JSON.parse(res.payload).message).toMatch(/409 Conflict/);
	});

	it("returns 404 when the qui instance is not found / not owned", async () => {
		mockRequireQuiInstance.mockRejectedValue(new InstanceNotFoundError("qui-missing"));
		const res = await injectAuthenticated(
			"POST",
			`/qui/instances/qui-missing/qbit/3/torrents/${VALID_HASH}/rename`,
			{ body: { name: "ok" } },
		);
		expect(res.statusCode).toBe(404);
		expect(mockQuiClient.renameTorrent).not.toHaveBeenCalled();
	});
});

describe("POST /qui/instances/:id/qbit/:instanceId/torrents/:hash/trackers/add", () => {
	it("calls addTrackers with the supplied URLs", async () => {
		mockRequireQuiInstance.mockResolvedValue(makeQuiInstance());
		mockQuiClient.addTrackers.mockResolvedValue(undefined);
		const urls = [
			"https://tracker.example.com/announce",
			"https://backup-tracker.example.com/announce",
		];
		const res = await injectAuthenticated(
			"POST",
			`/qui/instances/qui-1/qbit/3/torrents/${VALID_HASH}/trackers/add`,
			{ body: { urls } },
		);
		expect(res.statusCode).toBe(200);
		expect(mockQuiClient.addTrackers).toHaveBeenCalledWith(3, VALID_HASH, urls);
	});

	it("rejects an empty url list (Zod min(1))", async () => {
		mockRequireQuiInstance.mockResolvedValue(makeQuiInstance());
		const res = await injectAuthenticated(
			"POST",
			`/qui/instances/qui-1/qbit/3/torrents/${VALID_HASH}/trackers/add`,
			{ body: { urls: [] } },
		);
		expect(res.statusCode).toBe(400);
		expect(mockQuiClient.addTrackers).not.toHaveBeenCalled();
	});

	it("rejects a url list longer than 50 entries (Zod max bound)", async () => {
		mockRequireQuiInstance.mockResolvedValue(makeQuiInstance());
		const urls = Array.from({ length: 51 }, (_, i) => `https://t${i}.example.com/announce`);
		const res = await injectAuthenticated(
			"POST",
			`/qui/instances/qui-1/qbit/3/torrents/${VALID_HASH}/trackers/add`,
			{ body: { urls } },
		);
		expect(res.statusCode).toBe(400);
		expect(mockQuiClient.addTrackers).not.toHaveBeenCalled();
	});

	it("returns 502 with qui error when addTrackers throws", async () => {
		mockRequireQuiInstance.mockResolvedValue(makeQuiInstance());
		mockQuiClient.addTrackers.mockRejectedValue(new Error("qui addTrackers exploded"));
		const res = await injectAuthenticated(
			"POST",
			`/qui/instances/qui-1/qbit/3/torrents/${VALID_HASH}/trackers/add`,
			{ body: { urls: ["https://tracker.example.com/announce"] } },
		);
		expect(res.statusCode).toBe(502);
		expect(JSON.parse(res.payload).message).toMatch(/exploded/);
	});
});

describe("POST /qui/instances/:id/qbit/:instanceId/torrents/:hash/trackers/remove", () => {
	// Remove takes HOSTNAMES, not URLs. The route resolves hostname → full
	// URL server-side so the URL (with its passkey) never leaves the API
	// process. This is a load-bearing safety property.

	it("resolves hostname to full URL and removes the matching tracker", async () => {
		mockRequireQuiInstance.mockResolvedValue(makeQuiInstance());
		mockQuiClient.getTrackers.mockResolvedValue([
			{
				url: "https://tracker.example.com/announce?passkey=SECRET",
				status: 2,
				msg: "",
				numSeeds: 5,
				numLeeches: 0,
				numPeers: 0,
			},
			{
				url: "https://other-tracker.example.com/announce",
				status: 2,
				msg: "",
				numSeeds: 1,
				numLeeches: 0,
				numPeers: 0,
			},
		]);
		mockQuiClient.removeTrackers.mockResolvedValue(undefined);

		const res = await injectAuthenticated(
			"POST",
			`/qui/instances/qui-1/qbit/3/torrents/${VALID_HASH}/trackers/remove`,
			{ body: { hostnames: ["tracker.example.com"] } },
		);

		expect(res.statusCode).toBe(200);
		// Route should pass the FULL announce URL (passkey and all) to
		// the qui client — that URL only ever lives in this process.
		expect(mockQuiClient.removeTrackers).toHaveBeenCalledWith(3, VALID_HASH, [
			"https://tracker.example.com/announce?passkey=SECRET",
		]);
	});

	it("returns 404 when no tracker matches the supplied hostname", async () => {
		// Trying to remove a hostname that doesn't exist on the torrent —
		// the route should bail with 404, not silently no-op.
		mockRequireQuiInstance.mockResolvedValue(makeQuiInstance());
		mockQuiClient.getTrackers.mockResolvedValue([
			{
				url: "https://different.example.com/announce",
				status: 2,
				msg: "",
				numSeeds: 0,
				numLeeches: 0,
				numPeers: 0,
			},
		]);

		const res = await injectAuthenticated(
			"POST",
			`/qui/instances/qui-1/qbit/3/torrents/${VALID_HASH}/trackers/remove`,
			{ body: { hostnames: ["tracker.example.com"] } },
		);

		expect(res.statusCode).toBe(404);
		expect(mockQuiClient.removeTrackers).not.toHaveBeenCalled();
	});

	it("rejects an empty hostname list", async () => {
		mockRequireQuiInstance.mockResolvedValue(makeQuiInstance());
		const res = await injectAuthenticated(
			"POST",
			`/qui/instances/qui-1/qbit/3/torrents/${VALID_HASH}/trackers/remove`,
			{ body: { hostnames: [] } },
		);
		expect(res.statusCode).toBe(400);
		expect(mockQuiClient.getTrackers).not.toHaveBeenCalled();
		expect(mockQuiClient.removeTrackers).not.toHaveBeenCalled();
	});
});

describe("POST /qui/instances/:id/qbit/:instanceId/torrents/:hash/trackers/edit", () => {
	// Edit identifies the old tracker by HOSTNAME (same passkey-safety
	// pattern as removal). The new URL is operator-supplied and arrives
	// whole.

	it("resolves oldHostname to full URL and forwards the edit to qui", async () => {
		mockRequireQuiInstance.mockResolvedValue(makeQuiInstance());
		mockQuiClient.getTrackers.mockResolvedValue([
			{
				url: "https://old-tracker.example.com/announce?passkey=SECRET",
				status: 2,
				msg: "",
				numSeeds: 0,
				numLeeches: 0,
				numPeers: 0,
			},
		]);
		mockQuiClient.editTracker.mockResolvedValue(undefined);

		const res = await injectAuthenticated(
			"POST",
			`/qui/instances/qui-1/qbit/3/torrents/${VALID_HASH}/trackers/edit`,
			{
				body: {
					oldHostname: "old-tracker.example.com",
					newURL: "https://new-tracker.example.com/announce",
				},
			},
		);

		expect(res.statusCode).toBe(200);
		// Old full URL (with passkey) preserved across the route call.
		expect(mockQuiClient.editTracker).toHaveBeenCalledWith(
			3,
			VALID_HASH,
			"https://old-tracker.example.com/announce?passkey=SECRET",
			"https://new-tracker.example.com/announce",
		);
	});

	it("returns 404 when oldHostname doesn't match any tracker on the torrent", async () => {
		mockRequireQuiInstance.mockResolvedValue(makeQuiInstance());
		mockQuiClient.getTrackers.mockResolvedValue([
			{
				url: "https://other.example.com/announce",
				status: 2,
				msg: "",
				numSeeds: 0,
				numLeeches: 0,
				numPeers: 0,
			},
		]);
		const res = await injectAuthenticated(
			"POST",
			`/qui/instances/qui-1/qbit/3/torrents/${VALID_HASH}/trackers/edit`,
			{
				body: {
					oldHostname: "missing.example.com",
					newURL: "https://new.example.com/announce",
				},
			},
		);
		expect(res.statusCode).toBe(404);
		expect(mockQuiClient.editTracker).not.toHaveBeenCalled();
	});
});

// ────────────────────────────────────────────────────────────────────────
// /qui/backfill/run-now — wire-shape regression guard
//
// The route runs THREE separate sweeps internally (movie path-backfill,
// episode-file sync, episode path-backfill) and returns ONE aggregate
// matching `QuiBackfillNowResult` on the client. An earlier version of
// the route returned `{ movieSweep, episodeSync, episodeSweep }` while
// the client type declared the flat aggregate — so
// `data.rowsHashed.toLocaleString()` on the frontend threw, surfacing as
// a false "Backfill failed" toast even though the work succeeded. These
// tests pin the contract so that drift can't return silently.
// ────────────────────────────────────────────────────────────────────────

describe("POST /qui/backfill/run-now — aggregate response shape", () => {
	beforeEach(() => {
		mockRunPathBackfillSweep.mockReset();
		mockRunEpisodeFileSync.mockReset();
		mockRunEpisodeBackfillSweep.mockReset();
	});

	it("returns a flat aggregate with every field QuiBackfillNowResult expects", async () => {
		mockRunPathBackfillSweep.mockResolvedValue({
			usersScanned: 1,
			rowsScanned: 100,
			rowsHashed: 70,
			rowsMissed: 30,
			errors: 1,
			durationMs: 1200,
		});
		mockRunEpisodeFileSync.mockResolvedValue({
			usersScanned: 1,
			seriesScanned: 12,
			filesUpserted: 80,
			filesDeleted: 5,
			errors: 0,
			durationMs: 800,
		});
		mockRunEpisodeBackfillSweep.mockResolvedValue({
			usersScanned: 1,
			rowsScanned: 200,
			rowsHashed: 150,
			rowsMissed: 50,
			errors: 2,
			durationMs: 1500,
		});

		const res = await injectAuthenticated("POST", "/qui/backfill/run-now", { body: {} });

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		// Every required field on QuiBackfillNowResult must be present
		// AND must be a number. `rowsHashed` is the specific field that
		// crashed `qui-home-client.tsx:147` when it was missing — this
		// assertion is the regression guard for that exact bug.
		for (const key of [
			"usersScanned",
			"rowsScanned",
			"rowsHashed",
			"rowsMissed",
			"errors",
			"durationMs",
		] as const) {
			expect(body[key], `field "${key}" must be present and numeric`).toEqual(expect.any(Number));
		}
		// The aggregate arithmetic — sums for row counts (movie + episode
		// sweeps both contribute rows), max for usersScanned (the three
		// sweeps scan the same set of qui-enabled users, summing would
		// overcount), sum for errors + durationMs across all three phases.
		expect(body.rowsScanned).toBe(100 + 200);
		expect(body.rowsHashed).toBe(70 + 150);
		expect(body.rowsMissed).toBe(30 + 50);
		expect(body.usersScanned).toBe(1);
		expect(body.errors).toBe(1 + 0 + 2);
		expect(body.durationMs).toBe(1200 + 800 + 1500);
	});

	it("does NOT return the legacy three-phase shape (regression guard)", async () => {
		// The pre-fix shape was `{ movieSweep, episodeSync, episodeSweep }`
		// — these keys must NEVER appear at the top level of the response,
		// otherwise the client's type-cast would silently consume the
		// wrong shape again.
		mockRunPathBackfillSweep.mockResolvedValue({
			usersScanned: 0,
			rowsScanned: 0,
			rowsHashed: 0,
			rowsMissed: 0,
			errors: 0,
			durationMs: 0,
		});
		mockRunEpisodeFileSync.mockResolvedValue({
			usersScanned: 0,
			seriesScanned: 0,
			filesUpserted: 0,
			filesDeleted: 0,
			errors: 0,
			durationMs: 0,
		});
		mockRunEpisodeBackfillSweep.mockResolvedValue({
			usersScanned: 0,
			rowsScanned: 0,
			rowsHashed: 0,
			rowsMissed: 0,
			errors: 0,
			durationMs: 0,
		});

		const res = await injectAuthenticated("POST", "/qui/backfill/run-now", { body: {} });
		const body = JSON.parse(res.payload);

		expect(body.movieSweep).toBeUndefined();
		expect(body.episodeSync).toBeUndefined();
		expect(body.episodeSweep).toBeUndefined();
	});

	it("handles a zero-result run cleanly (no NaN, no missing fields)", async () => {
		// Empty-library case — every counter is 0, durations 0. The
		// aggregate must still come back with all six numeric fields,
		// not undefined or NaN.
		mockRunPathBackfillSweep.mockResolvedValue({
			usersScanned: 0,
			rowsScanned: 0,
			rowsHashed: 0,
			rowsMissed: 0,
			errors: 0,
			durationMs: 0,
		});
		mockRunEpisodeFileSync.mockResolvedValue({
			usersScanned: 0,
			seriesScanned: 0,
			filesUpserted: 0,
			filesDeleted: 0,
			errors: 0,
			durationMs: 0,
		});
		mockRunEpisodeBackfillSweep.mockResolvedValue({
			usersScanned: 0,
			rowsScanned: 0,
			rowsHashed: 0,
			rowsMissed: 0,
			errors: 0,
			durationMs: 0,
		});

		const res = await injectAuthenticated("POST", "/qui/backfill/run-now", { body: {} });
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body).toEqual({
			usersScanned: 0,
			rowsScanned: 0,
			rowsHashed: 0,
			rowsMissed: 0,
			errors: 0,
			durationMs: 0,
		});
		expect(Number.isNaN(body.rowsHashed)).toBe(false);
	});
});
