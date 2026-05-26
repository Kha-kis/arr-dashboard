import type { FastifyBaseLogger } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateQuiClient } = vi.hoisted(() => ({
	mockCreateQuiClient: vi.fn(),
}));

vi.mock("../client-factory.js", () => ({
	createQuiClient: mockCreateQuiClient,
}));

import { getDiscoveryAvailability, runDiscoveryBatch } from "../cross-seed-discovery.js";

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

function makeApp(overrides: Record<string, unknown> = {}) {
	return {
		log: silentLog,
		prisma: {
			libraryCache: {
				count: vi.fn().mockResolvedValue(0),
				findMany: vi.fn().mockResolvedValue([]),
			},
			serviceInstance: {
				findFirst: vi.fn().mockResolvedValue(null),
			},
		},
		...overrides,
		// biome-ignore lint/suspicious/noExplicitAny: test-shim
	} as any;
}

function makeQuiInstance() {
	return {
		id: "qui-1",
		userId: "user-1",
		service: "QUI",
		label: "main qui",
		baseUrl: "http://qui",
		enabled: true,
		isDefault: true,
		createdAt: new Date(),
	};
}

function makeTorrent(overrides: Record<string, unknown> = {}) {
	return {
		hash: "aaaa",
		name: "torrent",
		state: "uploading",
		ratio: 1.5,
		progress: 1,
		numSeeds: 0,
		numLeechs: 0,
		tags: [],
		category: "",
		savePath: "/",
		addedOn: 0,
		completedOn: 1,
		seedingTime: 0,
		eta: 0,
		dlSpeed: 0,
		upSpeed: 0,
		priority: 0,
		size: 1024,
		instanceId: 1,
		instanceName: "qbit-main",
		...overrides,
	};
}

function makeRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "row-1",
		instanceId: "arr-1",
		instance: { label: "Sonarr", service: "SONARR" },
		arrItemId: 100,
		itemType: "SERIES",
		title: "Severance",
		year: 2022,
		infoHash: "aaaa",
		...overrides,
	};
}

describe("getDiscoveryAvailability", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns no_qui_instance when the user has no qui configured", async () => {
		const app = makeApp();
		app.prisma.serviceInstance.findFirst.mockResolvedValue(null);

		const result = await getDiscoveryAvailability(app, "user-1");
		expect(result).toEqual({ available: false, reason: "no_qui_instance" });
	});

	it("returns no_correlated_items when qui exists but no rows have infoHash", async () => {
		const app = makeApp();
		app.prisma.serviceInstance.findFirst.mockResolvedValue(makeQuiInstance());
		app.prisma.libraryCache.count.mockResolvedValue(0);

		const result = await getDiscoveryAvailability(app, "user-1");
		expect(result).toEqual({ available: false, reason: "no_correlated_items" });
	});

	it("returns available with scan-candidates count when both conditions are met", async () => {
		const app = makeApp();
		app.prisma.serviceInstance.findFirst.mockResolvedValue(makeQuiInstance());
		app.prisma.libraryCache.count.mockResolvedValue(42);

		const result = await getDiscoveryAvailability(app, "user-1");
		expect(result).toEqual({
			available: true,
			quiInstanceId: "qui-1",
			quiInstanceLabel: "main qui",
			scanCandidates: 42,
		});
	});

	it("scopes the count query by userId via the instance relation", async () => {
		const app = makeApp();
		app.prisma.serviceInstance.findFirst.mockResolvedValue(makeQuiInstance());
		app.prisma.libraryCache.count.mockResolvedValue(1);

		await getDiscoveryAvailability(app, "user-1");
		const where = app.prisma.libraryCache.count.mock.calls[0]?.[0].where;
		expect(where.instance.userId).toBe("user-1");
		expect(where.infoHash).toEqual({ not: null });
	});
});

describe("runDiscoveryBatch", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns an empty batch when the user has no qui instance", async () => {
		const app = makeApp();
		app.prisma.serviceInstance.findFirst.mockResolvedValue(null);

		const result = await runDiscoveryBatch({
			app,
			userId: "user-1",
			cursor: null,
			batchSize: 100,
			log: silentLog,
		});

		expect(result.items).toEqual([]);
		expect(result.exhausted).toBe(true);
		// No qui client should have been built — caller is gated on availability.
		expect(mockCreateQuiClient).not.toHaveBeenCalled();
	});

	it("returns items only when qui has siblings for the matched hash", async () => {
		const app = makeApp();
		app.prisma.serviceInstance.findFirst.mockResolvedValue(makeQuiInstance());
		app.prisma.libraryCache.findMany.mockResolvedValue([
			makeRow({ id: "row-1", infoHash: "aaaa" }),
			makeRow({ id: "row-2", infoHash: "bbbb", title: "Other Show" }),
			makeRow({ id: "row-3", infoHash: "cccc", title: "Third Show" }),
		]);

		mockCreateQuiClient.mockReturnValue({
			listAllTorrents: vi.fn().mockResolvedValue([
				makeTorrent({ hash: "aaaa", instanceId: 1 }),
				makeTorrent({ hash: "bbbb", instanceId: 1 }),
				// cccc isn't in qui at all → skipped
			]),
			getCrossSeedMatches: vi.fn((_instanceId, hash) => {
				// Only aaaa has siblings; bbbb has none.
				if (hash === "aaaa") {
					return Promise.resolve([
						{
							hash: "aaaa-sibling",
							name: "AAAA sibling",
							instanceId: 1,
							instanceName: "qbit",
							state: "uploading",
							progress: 1,
							size: 100,
							category: "",
							savePath: "/",
							contentPath: "/",
							tracker: "tracker.example",
							matchType: "release" as const,
							tags: "",
						},
					]);
				}
				return Promise.resolve([]);
			}),
		});

		const result = await runDiscoveryBatch({
			app,
			userId: "user-1",
			cursor: null,
			batchSize: 100,
			log: silentLog,
		});

		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.libraryCacheId).toBe("row-1");
		expect(result.items[0]?.siblings).toHaveLength(1);
		expect(result.scannedThisBatch).toBe(3);
		expect(result.foundThisBatch).toBe(1);
		expect(result.exhausted).toBe(true); // batch size 100, returned 3 → done
	});

	it("uses cursor pagination and reports nextCursor when batch is full", async () => {
		const app = makeApp();
		app.prisma.serviceInstance.findFirst.mockResolvedValue(makeQuiInstance());
		// Returning exactly batchSize rows means we're NOT exhausted yet.
		const rows = Array.from({ length: 3 }, (_, i) =>
			makeRow({ id: `row-${i + 1}`, infoHash: `${"a".repeat(i + 1)}aa` }),
		);
		app.prisma.libraryCache.findMany.mockResolvedValue(rows);

		mockCreateQuiClient.mockReturnValue({
			listAllTorrents: vi.fn().mockResolvedValue([]),
			getCrossSeedMatches: vi.fn().mockResolvedValue([]),
		});

		const result = await runDiscoveryBatch({
			app,
			userId: "user-1",
			cursor: "prev-cursor",
			batchSize: 3,
			log: silentLog,
		});

		expect(result.exhausted).toBe(false);
		expect(result.nextCursor).toBe("row-3");
		// cursor passed into findMany as id: { gt: ... }
		const where = app.prisma.libraryCache.findMany.mock.calls[0]?.[0].where;
		expect(where.id).toEqual({ gt: "prev-cursor" });
	});

	it("logs and skips items whose getCrossSeedMatches throws (per-item failure isolation)", async () => {
		const warnSpy = vi.fn();
		const log = { ...silentLog, warn: warnSpy } as unknown as FastifyBaseLogger;
		const app = makeApp();
		app.prisma.serviceInstance.findFirst.mockResolvedValue(makeQuiInstance());
		app.prisma.libraryCache.findMany.mockResolvedValue([
			makeRow({ id: "row-1", infoHash: "aaaa" }),
			makeRow({ id: "row-2", infoHash: "bbbb", title: "Healthy" }),
		]);

		mockCreateQuiClient.mockReturnValue({
			listAllTorrents: vi
				.fn()
				.mockResolvedValue([
					makeTorrent({ hash: "aaaa", instanceId: 1 }),
					makeTorrent({ hash: "bbbb", instanceId: 1 }),
				]),
			getCrossSeedMatches: vi.fn((_id, hash) => {
				if (hash === "aaaa") return Promise.reject(new Error("qui blew up"));
				return Promise.resolve([
					{
						hash: "bbbb-sibling",
						name: "BBBB sibling",
						instanceId: 1,
						instanceName: "qbit",
						state: "uploading",
						progress: 1,
						size: 100,
						category: "",
						savePath: "/",
						contentPath: "/",
						tracker: "tracker.example",
						matchType: "release" as const,
						tags: "",
					},
				]);
			}),
		});

		const result = await runDiscoveryBatch({
			app,
			userId: "user-1",
			cursor: null,
			batchSize: 100,
			log,
		});

		// row-1 errored, row-2 succeeded → only row-2 returned, no thrown.
		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.libraryCacheId).toBe("row-2");
		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	it("filters out unsupported services (e.g., non-arr LibraryCache rows)", async () => {
		const app = makeApp();
		app.prisma.serviceInstance.findFirst.mockResolvedValue(makeQuiInstance());
		app.prisma.libraryCache.findMany.mockResolvedValue([
			makeRow({ id: "row-1", instance: { label: "Strange", service: "WEIRD" } }),
		]);
		mockCreateQuiClient.mockReturnValue({
			listAllTorrents: vi.fn().mockResolvedValue([makeTorrent({ hash: "aaaa" })]),
			getCrossSeedMatches: vi.fn().mockResolvedValue([]),
		});

		const result = await runDiscoveryBatch({
			app,
			userId: "user-1",
			cursor: null,
			batchSize: 100,
			log: silentLog,
		});

		expect(result.items).toHaveLength(0);
		expect(result.scannedThisBatch).toBe(1); // still counted as scanned
	});
});
