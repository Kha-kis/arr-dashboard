import type { FastifyBaseLogger } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	backfillInfoHashForRow,
	countBackfillCandidates,
	fetchInfoHashFromArrHistory,
	runInfoHashBackfillSweep,
} from "../infohash-backfill.js";

const silentLog: FastifyBaseLogger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	fatal: vi.fn(),
	trace: vi.fn(),
	child: vi.fn(() => silentLog),
	level: "info",
	silent: vi.fn(),
} as unknown as FastifyBaseLogger;

const VALID_SHA1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // 40 hex
const VALID_SHA256 = "b".repeat(64); // 64 hex
const NZB_ID = "Z3J0LWFiY2QtZWZnaA"; // base64-ish, NOT a hash
const MIXED_RECORDS = [
	{ downloadId: "manual-import" }, // first record, but bogus
	{ downloadId: NZB_ID }, // looks NZB, must be rejected
	{ downloadId: VALID_SHA1.toUpperCase() }, // upper-case hex
];

const arrInstance = {
	id: "radarr-1",
	baseUrl: "http://radarr.test",
	encryptedApiKey: "enc",
	encryptionIv: "iv",
	service: "RADARR",
	label: "Primary Radarr",
} as never;

function makeApp(historyResponse: { ok: boolean; records?: unknown[] }) {
	return {
		log: silentLog,
		arrClientFactory: {
			rawRequest: vi.fn().mockResolvedValue({
				ok: historyResponse.ok,
				status: historyResponse.ok ? 200 : 500,
				// Subpath endpoints (`/history/movie`, `/history/series`) return a flat
				// array, not the paginated `{ records: [] }` shape of the base endpoint.
				json: async () => historyResponse.records ?? [],
			}),
		},
		prisma: {
			serviceInstance: {
				findFirst: vi.fn().mockResolvedValue(null),
				findMany: vi.fn().mockResolvedValue([]),
				count: vi.fn().mockResolvedValue(0),
			},
			libraryCache: {
				update: vi.fn().mockResolvedValue({}),
				findMany: vi.fn().mockResolvedValue([]),
				count: vi.fn().mockResolvedValue(0),
			},
		},
		// biome-ignore lint/suspicious/noExplicitAny: test shim
	} as any;
}

describe("fetchInfoHashFromArrHistory", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns the first record whose downloadId looks like a real torrent hash", async () => {
		// The two records before the SHA1 are intentional: manual imports and
		// NZB downloads have non-hash downloadIds. The util must skip them.
		const app = makeApp({ ok: true, records: MIXED_RECORDS });
		const hash = await fetchInfoHashFromArrHistory({
			app,
			arrInstance,
			itemType: "movie",
			arrItemId: 1,
		});
		expect(hash).toBe(VALID_SHA1); // lower-cased
	});

	it("accepts SHA-256 hashes (64-char hex)", async () => {
		const app = makeApp({ ok: true, records: [{ downloadId: VALID_SHA256 }] });
		const hash = await fetchInfoHashFromArrHistory({
			app,
			arrInstance,
			itemType: "series",
			arrItemId: 5,
		});
		expect(hash).toBe(VALID_SHA256);
	});

	it("uses the dedicated /history/movie and /history/series subpath endpoints", async () => {
		// Critical regression guard: the base `/api/v3/history` endpoint accepts
		// `movieIds`/`seriesIds` (plural arrays). Passing the singular form is
		// SILENTLY ignored, returning unfiltered global history — which causes
		// the same hash to be assigned to every item. The subpath endpoints take
		// the singular id and filter correctly. Hard-asserting both pieces of the
		// URL prevents anyone from "simplifying" this back to the broken form.
		const app = makeApp({ ok: true, records: [{ downloadId: VALID_SHA1 }] });
		await fetchInfoHashFromArrHistory({
			app,
			arrInstance,
			itemType: "series",
			arrItemId: 42,
		});
		expect(app.arrClientFactory.rawRequest).toHaveBeenCalledWith(
			expect.anything(),
			"/api/v3/history/series?seriesId=42",
		);
		await fetchInfoHashFromArrHistory({
			app,
			arrInstance,
			itemType: "movie",
			arrItemId: 99,
		});
		expect(app.arrClientFactory.rawRequest).toHaveBeenCalledWith(
			expect.anything(),
			"/api/v3/history/movie?movieId=99",
		);
	});

	it("returns null for benign 4xx responses (e.g. 404 — no history record exists)", async () => {
		const app = makeApp({ ok: false }); // status 500 by default in the helper
		// Override the mock to return a benign 404
		app.arrClientFactory.rawRequest.mockResolvedValueOnce({
			ok: false,
			status: 404,
			json: async () => ({ message: "Not Found" }),
		});
		const hash = await fetchInfoHashFromArrHistory({
			app,
			arrInstance,
			itemType: "movie",
			arrItemId: 1,
		});
		expect(hash).toBeNull();
	});

	it("THROWS on 401/403 auth errors so the sweep counts it as an error not a miss", async () => {
		// Pre-fix: 401 returned null and counted as `rowsMissed`, identical
		// to a benign 404 record-not-found. A totally-broken *arr API key
		// produced a clean-looking sweep with 0 errors and 100% misses,
		// masking the actionable config issue. Now: 401/403 throw.
		const app = makeApp({ ok: false });
		app.arrClientFactory.rawRequest.mockResolvedValueOnce({
			ok: false,
			status: 401,
			json: async () => ({ message: "Unauthorized" }),
		});
		await expect(
			fetchInfoHashFromArrHistory({
				app,
				arrInstance,
				itemType: "movie",
				arrItemId: 1,
			}),
		).rejects.toThrow(/auth failure.*HTTP 401/);
	});

	it("THROWS on 5xx so transient *arr outages drive sweep `errors` (visible in scheduler diagnostics)", async () => {
		const app = makeApp({ ok: false });
		app.arrClientFactory.rawRequest.mockResolvedValueOnce({
			ok: false,
			status: 503,
			json: async () => ({ message: "Service Unavailable" }),
		});
		await expect(
			fetchInfoHashFromArrHistory({
				app,
				arrInstance,
				itemType: "movie",
				arrItemId: 1,
			}),
		).rejects.toThrow(/server error.*HTTP 503/);
	});

	it("returns null when no records carry a hash-shaped downloadId", async () => {
		const app = makeApp({
			ok: true,
			records: [{ downloadId: NZB_ID }, { downloadId: "" }, { downloadId: null }],
		});
		const hash = await fetchInfoHashFromArrHistory({
			app,
			arrInstance,
			itemType: "movie",
			arrItemId: 1,
		});
		expect(hash).toBeNull();
	});

	it("returns null on thrown errors (network, malformed JSON)", async () => {
		const app = makeApp({ ok: true });
		app.arrClientFactory.rawRequest.mockRejectedValueOnce(new Error("ECONNREFUSED"));
		const hash = await fetchInfoHashFromArrHistory({
			app,
			arrInstance,
			itemType: "movie",
			arrItemId: 1,
		});
		expect(hash).toBeNull();
	});
});

describe("backfillInfoHashForRow", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns null when the *arr instance lookup fails (wrong user / disabled)", async () => {
		const app = makeApp({ ok: true });
		app.prisma.serviceInstance.findFirst.mockResolvedValue(null);
		const hash = await backfillInfoHashForRow({
			app,
			cacheRowId: "cache-1",
			userId: "user-1",
			arrInstanceId: "radarr-1",
			itemType: "movie",
			arrItemId: 5,
		});
		expect(hash).toBeNull();
		expect(app.prisma.libraryCache.update).not.toHaveBeenCalled();
	});

	it("persists the hash to LibraryCache when found", async () => {
		const app = makeApp({ ok: true, records: [{ downloadId: VALID_SHA1 }] });
		app.prisma.serviceInstance.findFirst.mockResolvedValue(arrInstance);
		const hash = await backfillInfoHashForRow({
			app,
			cacheRowId: "cache-1",
			userId: "user-1",
			arrInstanceId: "radarr-1",
			itemType: "movie",
			arrItemId: 5,
		});
		expect(hash).toBe(VALID_SHA1);
		expect(app.prisma.libraryCache.update).toHaveBeenCalledWith({
			where: { id: "cache-1" },
			data: { infoHash: VALID_SHA1 },
		});
	});

	it("scopes to RADARR for movies and SONARR for series (user-isolation)", async () => {
		const app = makeApp({ ok: true, records: [{ downloadId: VALID_SHA1 }] });
		app.prisma.serviceInstance.findFirst.mockResolvedValue(arrInstance);
		await backfillInfoHashForRow({
			app,
			cacheRowId: "cache-2",
			userId: "user-2",
			arrInstanceId: "sonarr-1",
			itemType: "series",
			arrItemId: 1,
		});
		expect(app.prisma.serviceInstance.findFirst).toHaveBeenCalledWith({
			where: { id: "sonarr-1", userId: "user-2", service: "SONARR" },
		});
	});
});

describe("runInfoHashBackfillSweep", () => {
	beforeEach(() => vi.clearAllMocks());

	it("no-ops when no users have qui configured", async () => {
		const app = makeApp({ ok: true });
		app.prisma.serviceInstance.findMany.mockResolvedValue([]);
		const result = await runInfoHashBackfillSweep({ app, batchSize: 500, perRowSleepMs: 0 });
		expect(result.usersScanned).toBe(0);
		expect(result.rowsScanned).toBe(0);
		expect(app.prisma.libraryCache.findMany).not.toHaveBeenCalled();
	});

	it("respects the batch size across users", async () => {
		const app = makeApp({ ok: true, records: [{ downloadId: VALID_SHA1 }] });
		app.prisma.serviceInstance.findMany.mockResolvedValue([
			{ userId: "user-1" },
			{ userId: "user-2" },
		]);
		// First user has 2 rows, second user would have more — but batch=2 caps the run.
		app.prisma.libraryCache.findMany
			.mockResolvedValueOnce([
				{ id: "r1", instanceId: "radarr-1", itemType: "movie", arrItemId: 1 },
				{ id: "r2", instanceId: "radarr-1", itemType: "movie", arrItemId: 2 },
			])
			.mockResolvedValueOnce([]);
		app.prisma.serviceInstance.findFirst.mockResolvedValue(arrInstance);

		const result = await runInfoHashBackfillSweep({ app, batchSize: 2, perRowSleepMs: 0 });
		expect(result.rowsScanned).toBe(2);
		expect(result.rowsHashed).toBe(2);
		// Second user's findMany should never be called because batch is full.
		expect(app.prisma.libraryCache.findMany).toHaveBeenCalledTimes(1);
	});

	it("excludes artist/author rows from the findMany query (qui doesn't track music/books)", async () => {
		// Critical regression guard: Lidarr/Readarr items would yield empty *arr
		// history responses, wasting API budget AND polluting logs. The
		// findMany WHERE clause must explicitly bound itemType to [movie, series].
		const app = makeApp({ ok: true });
		app.prisma.serviceInstance.findMany.mockResolvedValue([{ userId: "user-1" }]);
		app.prisma.libraryCache.findMany.mockResolvedValue([]);

		await runInfoHashBackfillSweep({ app, batchSize: 500, perRowSleepMs: 0 });

		expect(app.prisma.libraryCache.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					infoHash: null,
					itemType: { in: ["movie", "series"] },
					instance: { userId: "user-1" },
				}),
			}),
		);
	});

	it("counts misses (no hash found in history) without aborting the sweep", async () => {
		const app = makeApp({ ok: true, records: [{ downloadId: NZB_ID }] }); // no real hash
		app.prisma.serviceInstance.findMany.mockResolvedValue([{ userId: "user-1" }]);
		app.prisma.libraryCache.findMany.mockResolvedValue([
			{ id: "r1", instanceId: "radarr-1", itemType: "movie", arrItemId: 1 },
		]);
		app.prisma.serviceInstance.findFirst.mockResolvedValue(arrInstance);

		const result = await runInfoHashBackfillSweep({ app, batchSize: 5, perRowSleepMs: 0 });
		expect(result.rowsScanned).toBe(1);
		expect(result.rowsHashed).toBe(0);
		expect(result.rowsMissed).toBe(1);
		expect(result.errors).toBe(0);
	});
});

describe("countBackfillCandidates", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns 0 when no users have qui", async () => {
		const app = makeApp({ ok: true });
		app.prisma.serviceInstance.findMany.mockResolvedValue([]);
		const count = await countBackfillCandidates(app);
		expect(count).toBe(0);
		expect(app.prisma.libraryCache.count).not.toHaveBeenCalled();
	});

	it("counts NULL infoHash rows scoped to qui-using users", async () => {
		const app = makeApp({ ok: true });
		app.prisma.serviceInstance.findMany.mockResolvedValue([{ userId: "user-1" }]);
		app.prisma.libraryCache.count.mockResolvedValue(150);
		const count = await countBackfillCandidates(app);
		expect(count).toBe(150);
		expect(app.prisma.libraryCache.count).toHaveBeenCalledWith({
			where: {
				infoHash: null,
				itemType: { in: ["movie", "series"] },
				instance: { userId: { in: ["user-1"] } },
			},
		});
	});
});
