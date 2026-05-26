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
 *   2. `?torrentState=none` adds `where.torrentState = null`
 *   3. `?torrentState=seeding` (etc.) adds exact equality match
 *   4. `torrentStateCounts` is only included when user has ≥1 enabled qui instance
 *   5. `torrentStateCounts` is computed against the where clause MINUS the
 *      torrentState filter — picking one bucket from the dropdown does not
 *      zero out the others (which would defeat the purpose)
 */

import Fastify from "fastify";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerLibraryRoutes } from "../library.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

function createMockPrisma() {
	return {
		serviceInstance: {
			findMany: vi.fn().mockResolvedValue([{ id: "radarr-1" }]),
			count: vi.fn().mockResolvedValue(0),
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

afterAll(async () => {
	await app?.close();
});

// biome-ignore lint/suspicious/noExplicitAny: typed access into vi.fn().mock.calls would obscure intent
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
		expect(findManyCallWhere()).not.toHaveProperty("torrentState");
	});

	it("matches NULL torrentState when filter=none", async () => {
		const res = await injectAuthenticated("GET", "/library?torrentState=none");
		expect(res.statusCode).toBe(200);
		expect(findManyCallWhere().torrentState).toBeNull();
	});

	it("matches exact state when filter=seeding", async () => {
		const res = await injectAuthenticated("GET", "/library?torrentState=seeding");
		expect(res.statusCode).toBe(200);
		expect(findManyCallWhere().torrentState).toBe("seeding");
	});

	it("matches exact state when filter=stalled_dl", async () => {
		const res = await injectAuthenticated("GET", "/library?torrentState=stalled_dl");
		expect(res.statusCode).toBe(200);
		expect(findManyCallWhere().torrentState).toBe("stalled_dl");
	});

	it("rejects invalid torrentState values with 400", async () => {
		// Validation guards against URL tampering — only the documented enum values pass.
		const res = await injectAuthenticated("GET", "/library?torrentState=bogus");
		expect(res.statusCode).toBe(400);
	});
});

describe("GET /library — torrentStateCounts response field", () => {
	it("omits torrentStateCounts when user has zero qui instances", async () => {
		// serviceInstance.count returns 0 for the qui-presence probe → no counts query runs
		mockPrisma.serviceInstance.count.mockResolvedValue(0);
		const res = await injectAuthenticated("GET", "/library");
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.torrentStateCounts).toBeUndefined();
		// And critically: groupBy MUST NOT be called — costs zero for non-qui users.
		expect(mockPrisma.libraryCache.groupBy).not.toHaveBeenCalled();
	});

	it("includes torrentStateCounts when user has ≥1 enabled qui instance", async () => {
		mockPrisma.serviceInstance.count.mockResolvedValue(1); // user has qui
		mockPrisma.libraryCache.groupBy.mockResolvedValue([
			{ torrentState: "seeding", _count: { _all: 150 } },
			{ torrentState: "stalled_dl", _count: { _all: 3 } },
			{ torrentState: null, _count: { _all: 1962 } },
		]);
		// Both the pagination count and the totalForCounts query call .count. For
		// the test's purposes, returning 2115 for any count call is fine — it
		// matches the buckets above (150 + 3 + 1962 ≈ 2115).
		mockPrisma.libraryCache.count.mockResolvedValue(2115);
		const res = await injectAuthenticated("GET", "/library");
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.torrentStateCounts).toBeDefined();
		expect(body.torrentStateCounts.seeding).toBe(150);
		expect(body.torrentStateCounts.stalled_dl).toBe(3);
		expect(body.torrentStateCounts.none).toBe(1962); // null mapped to "none" bucket
		// Other states default to 0 even when not returned by groupBy.
		expect(body.torrentStateCounts.error).toBe(0);
		expect(body.torrentStateCounts.paused).toBe(0);
	});

	it("computes counts BEFORE applying torrentState filter (pivot integrity)", async () => {
		// This is the behaviour that makes the filter dropdown useful. If counts were
		// computed AFTER applying the filter, picking `seeding` would show
		// "Seeding (150) | Stalled (0) | ..." — nonsense, defeats the dropdown's job.
		mockPrisma.serviceInstance.count.mockResolvedValue(1);
		mockPrisma.libraryCache.groupBy.mockResolvedValue([
			{ torrentState: "seeding", _count: { _all: 150 } },
			{ torrentState: "stalled_dl", _count: { _all: 3 } },
		]);

		const res = await injectAuthenticated("GET", "/library?torrentState=seeding");
		expect(res.statusCode).toBe(200);
		// The groupBy `where` must NOT include the torrentState filter, otherwise
		// it would self-zero non-seeding buckets.
		const groupByCall = groupByCallArg(0);
		expect(groupByCall.by).toEqual(["torrentState"]);
		expect(groupByCall.where).not.toHaveProperty("torrentState");
	});

	it("counts honor OTHER applied filters (e.g. monitored=true)", async () => {
		// The "without torrentState" snapshot must still preserve every other
		// active filter — e.g. if user filters monitored=true + torrentState=seeding,
		// counts should reflect "of just the monitored items, how many are seeding?"
		mockPrisma.serviceInstance.count.mockResolvedValue(1);
		const res = await injectAuthenticated("GET", "/library?monitored=true&torrentState=seeding");
		expect(res.statusCode).toBe(200);
		const groupByCall = groupByCallArg(0);
		expect(groupByCall.where.monitored).toBe(true); // other filter preserved
		expect(groupByCall.where).not.toHaveProperty("torrentState"); // pivoted
	});
});

// biome-ignore lint/suspicious/noExplicitAny: typed access into vi.fn().mock.calls would obscure intent
function groupByCallArg(call: number): any {
	const calls = mockPrisma.libraryCache.groupBy.mock.calls;
	if (call >= calls.length)
		throw new Error(`groupBy called ${calls.length} times; expected ≥${call + 1}`);
	return (calls[call] as [unknown])[0];
}
