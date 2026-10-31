/**
 * Library Route — Torrent State Filter Integration Tests (Phase 2.1)
 *
 * Verifies the new `?torrentState=` filter and the `torrentStateCounts`
 * response field behave correctly under load. Mocks Prisma so we can
 * assert the exact `where` clauses + `groupBy` calls without standing up
 * a real DB.
 *
 * Properties under test:
 *   1. `?torrentState=all` (or omitted) does NOT add the column to the where clause
 *   2. `?torrentState=none` includes missing or non-current projections
 *   3. Exact states require the current verified publication timestamp
 *   4. `torrentStateCounts` requires an available owned qUI publication
 *   5. `torrentStateCounts` is computed against the where clause MINUS the
 *      torrentState filter — picking one bucket from the dropdown does not
 *      zero out the others (which would defeat the purpose)
 */

import { createHash } from "node:crypto";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerLibraryRoutes } from "../library.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

function createMockPrisma() {
	const observedAt = new Date();
	const quiSources = [
		{
			id: "qui-1",
			userId: "user-1",
			service: "QUI",
			enabled: true,
			connectionGeneration: 1,
			identityGeneration: 1,
			baseUrl: "http://synthetic.invalid",
			encryptedApiKey: "synthetic-key",
			encryptionIv: "synthetic-iv",
			encryptedHttpAuthCredentials: null,
			httpAuthEncryptionIv: null,
		},
	];
	const publication = {
		userId: "user-1",
		generation: "synthetic-generation",
		topologyDigest: createHash("sha256").update(JSON.stringify(quiSources)).digest("hex"),
		rowCount: 2,
		complete: true,
		observedAt,
	};
	const tables = {
		serviceInstance: {
			findMany: vi.fn(
				async ({ where }: { where: { userId: string; enabled: boolean; service: unknown } }) => {
					expect(where).toMatchObject({ userId: "user-1", enabled: true });
					return where.service === "QUI" ? quiSources : [{ id: "radarr-1" }];
				},
			),
		},
		quiObservationPublication: {
			findUnique: vi.fn(async ({ where }: { where: { userId: string } }) => {
				expect(where).toEqual({ userId: "user-1" });
				return publication;
			}),
		},
		quiTorrentObservation: {
			count: vi.fn(async ({ where }: { where: { userId: string; generation: string } }) => {
				expect(where).toEqual({ userId: "user-1", generation: "synthetic-generation" });
				return 2;
			}),
		},
		libraryCache: {
			count: vi.fn().mockResolvedValue(10),
			findMany: vi.fn().mockResolvedValue([]),
			groupBy: vi.fn().mockResolvedValue([]),
		},
		librarySyncStatus: {
			findMany: vi.fn().mockResolvedValue([]),
		},
	};
	return {
		...tables,
		observedAt,
		quiSources,
		$transaction: vi.fn(async <T>(read: (tx: typeof tables) => Promise<T>) => read(tables)),
	};
}

let app: ReturnType<typeof Fastify>;
let mockPrisma: ReturnType<typeof createMockPrisma>;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;

beforeEach(async () => {
	vi.clearAllMocks();
	mockPrisma = createMockPrisma();

	app = Fastify();
	app.decorate("prisma", mockPrisma);
	app.decorate("dbProvider", "sqlite");

	setupAuthInjection(app);
	registerTestErrorHandler(app);

	await app.register(registerLibraryRoutes);
	await app.ready();

	injectAuthenticated = createInjectAuthenticated(app);
});

afterEach(async () => {
	await app?.close();
});

function findManyCallWhere(call: number = 0): any {
	const calls = mockPrisma.libraryCache.findMany.mock.calls;
	if (call >= calls.length)
		throw new Error(`findMany called ${calls.length} times; expected ≥${call + 1}`);
	return (calls[call] as [{ where: unknown }])[0].where;
}

describe("GET /library — torrentState filter", () => {
	it("omits the torrentState column from the where clause when filter=all", async () => {
		const res = await injectAuthenticated("GET", "/library?torrentState=all");
		expect(res.statusCode).toBe(200);
		// findMany is called with the constructed where clause; it must NOT have torrentState set.
		expect(findManyCallWhere()).toEqual({ instanceId: { in: ["radarr-1"] } });
	});

	it("matches missing, stale, or null-state projections when filter=none", async () => {
		const res = await injectAuthenticated("GET", "/library?torrentState=none");
		expect(res.statusCode).toBe(200);
		expect(findManyCallWhere()).toEqual({
			AND: [
				{ instanceId: { in: ["radarr-1"] } },
				{
					OR: [
						{ torrentSyncedAt: null },
						{ torrentSyncedAt: { not: mockPrisma.observedAt } },
						{ torrentState: null },
					],
				},
			],
		});
	});

	it("matches exact state when filter=seeding", async () => {
		const res = await injectAuthenticated("GET", "/library?torrentState=seeding");
		expect(res.statusCode).toBe(200);
		expect(findManyCallWhere()).toEqual({
			AND: [
				{ instanceId: { in: ["radarr-1"] } },
				{ torrentSyncedAt: mockPrisma.observedAt, torrentState: "seeding" },
			],
		});
	});

	it("matches exact state when filter=stalled_dl", async () => {
		const res = await injectAuthenticated("GET", "/library?torrentState=stalled_dl");
		expect(res.statusCode).toBe(200);
		expect(findManyCallWhere()).toEqual({
			AND: [
				{ instanceId: { in: ["radarr-1"] } },
				{ torrentSyncedAt: mockPrisma.observedAt, torrentState: "stalled_dl" },
			],
		});
	});

	it("rejects invalid torrentState values with 400", async () => {
		// Validation guards against URL tampering — only the documented enum values pass.
		const res = await injectAuthenticated("GET", "/library?torrentState=bogus");
		expect(res.statusCode).toBe(400);
	});
});

describe("GET /library — torrentStateCounts response field", () => {
	it("omits torrentStateCounts when user has zero qui instances", async () => {
		mockPrisma.quiSources.length = 0;
		const res = await injectAuthenticated("GET", "/library?torrentState=none&sortBy=torrentRatio");
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.torrentStateCounts).toBeUndefined();
		expect(body.quiObservationStatus).toEqual({ status: "not_configured", observedAt: null });
		expect(body.appliedFilters).toMatchObject({ torrentState: "all", sortBy: "sortTitle" });
		expect(findManyCallWhere()).toEqual({ instanceId: { in: ["radarr-1"] } });
		// And critically: groupBy MUST NOT be called — costs zero for non-qui users.
		expect(mockPrisma.libraryCache.groupBy).not.toHaveBeenCalled();
	});

	it("includes torrentStateCounts for a verified owned publication", async () => {
		mockPrisma.libraryCache.groupBy.mockResolvedValue([
			{ torrentState: "seeding", _count: { _all: 150 } },
			{ torrentState: "stalled_dl", _count: { _all: 3 } },
		]);
		// Both the pagination count and the totalForCounts query call .count. For
		// the test's purposes, returning 2115 for any count call is fine — it
		// matches the current-state and unprojected buckets (150 + 3 + 1962 = 2115).
		mockPrisma.libraryCache.count.mockResolvedValue(2115);
		const res = await injectAuthenticated("GET", "/library");
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.quiObservationStatus).toEqual({
			status: "available",
			observedAt: mockPrisma.observedAt.toISOString(),
		});
		expect(body.torrentStateCounts.all).toBe(2115);
		expect(body.torrentStateCounts).toBeDefined();
		expect(body.torrentStateCounts.seeding).toBe(150);
		expect(body.torrentStateCounts.stalled_dl).toBe(3);
		expect(body.torrentStateCounts.none).toBe(1962); // remainder lacks a current state
		// Other states default to 0 even when not returned by groupBy.
		expect(body.torrentStateCounts.error).toBe(0);
		expect(body.torrentStateCounts.paused).toBe(0);
	});

	it("computes counts BEFORE applying torrentState filter (pivot integrity)", async () => {
		// This is the behaviour that makes the filter dropdown useful. If counts were
		// computed AFTER applying the filter, picking `seeding` would show
		// "Seeding (150) | Stalled (0) | ..." — nonsense, defeats the dropdown's job.
		mockPrisma.libraryCache.count.mockImplementation(async ({ where }) =>
			where.AND?.[1]?.torrentState === "seeding" ? 150 : 2115,
		);
		mockPrisma.libraryCache.groupBy.mockResolvedValue([
			{ torrentState: "seeding", _count: { _all: 150 } },
			{ torrentState: "stalled_dl", _count: { _all: 3 } },
		]);

		const res = await injectAuthenticated("GET", "/library?torrentState=seeding");
		expect(res.statusCode).toBe(200);
		// Counts include every current non-null state, even while the page selects seeding.
		const groupByCall = groupByCallArg(0);
		expect(groupByCall.by).toEqual(["torrentState"]);
		expect(groupByCall.where).toEqual({
			AND: [
				{ instanceId: { in: ["radarr-1"] } },
				{ torrentSyncedAt: mockPrisma.observedAt, torrentState: { not: null } },
			],
		});
		expect(res.json().torrentStateCounts).toMatchObject({
			all: 2115,
			seeding: 150,
			stalled_dl: 3,
			none: 1962,
		});
		expect(res.json().pagination.totalItems).toBe(150);
	});

	it("counts honor OTHER applied filters (e.g. monitored=true)", async () => {
		// The "without torrentState" snapshot must still preserve every other
		// active filter — e.g. if user filters monitored=true + torrentState=seeding,
		// counts should reflect "of just the monitored items, how many are seeding?"
		const res = await injectAuthenticated("GET", "/library?monitored=true&torrentState=seeding");
		expect(res.statusCode).toBe(200);
		const groupByCall = groupByCallArg(0);
		expect(groupByCall.where).toEqual({
			AND: [
				{ instanceId: { in: ["radarr-1"] }, monitored: true },
				{ torrentSyncedAt: mockPrisma.observedAt, torrentState: { not: null } },
			],
		});
	});

	it.each(["incomplete", "stale", "wrong-topology", "wrong-count"])(
		"refuses %s publication state, counts, and ratio sorting",
		async (reason) => {
			const head = await mockPrisma.quiObservationPublication.findUnique({
				where: { userId: "user-1" },
			});
			if (reason === "incomplete") head.complete = false;
			if (reason === "stale") head.observedAt = new Date(Date.now() - 31 * 60 * 1000);
			if (reason === "wrong-topology") head.topologyDigest = "different-topology";
			if (reason === "wrong-count") head.rowCount = 3;
			const res = await injectAuthenticated(
				"GET",
				"/library?monitored=true&torrentState=seeding&sortBy=torrentRatio",
			);
			expect(res.statusCode).toBe(200);
			expect(res.json().quiObservationStatus).toEqual({ status: "unavailable", observedAt: null });
			expect(res.json().torrentStateCounts).toBeUndefined();
			expect(res.json().appliedFilters).toMatchObject({
				monitored: "true",
				torrentState: "all",
				sortBy: "sortTitle",
			});
			expect(findManyCallWhere()).toEqual({ instanceId: { in: ["radarr-1"] }, monitored: true });
			expect(mockPrisma.libraryCache.groupBy).not.toHaveBeenCalled();
		},
	);

	it("rejects an instance outside the authenticated owner's ARR scope", async () => {
		const res = await injectAuthenticated(
			"GET",
			"/library?instanceId=other-owner-arr&torrentState=seeding",
		);
		expect(res.statusCode).toBe(403);
		expect(mockPrisma.libraryCache.findMany).not.toHaveBeenCalled();
		expect(mockPrisma.libraryCache.groupBy).not.toHaveBeenCalled();
	});
});

function groupByCallArg(call: number): any {
	const calls = mockPrisma.libraryCache.groupBy.mock.calls;
	if (call >= calls.length)
		throw new Error(`groupBy called ${calls.length} times; expected ≥${call + 1}`);
	return (calls[call] as [unknown])[0];
}
