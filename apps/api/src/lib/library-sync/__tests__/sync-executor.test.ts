/**
 * Tests for library-sync sync-executor
 *
 * Covers:
 * - Readarr/Lidarr cache query does NOT select data column (memory win)
 * - Sonarr/Radarr still select/use data for tag-delta detection
 * - ALL services always write full JSON to data on create and update
 * - Batched processing without building a full normalized items array
 * - Memory instrumentation at debug level
 */

import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient, ServiceType } from "../../../lib/prisma.js";
import type { ArrClientFactory } from "../../arr/client-factory.js";
import type { Encryptor } from "../../auth/encryption.js";
import { type SyncExecutorDeps, syncInstance } from "../sync-executor.js";

const MOCK_USER_ID = "user-1";
const INSTANCE_ID = "instance-1";

function makeRawItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 1,
		title: "Test Item",
		sortTitle: "test item",
		titleSlug: "test-item",
		year: 2024,
		monitored: true,
		status: "released",
		qualityProfileId: 1,
		qualityProfile: { name: "Test Profile" },
		sizeOnDisk: 0,
		added: "2024-01-01T00:00:00Z",
		updated: "2024-01-02T00:00:00Z",
		tmdbId: 12345,
		remoteIds: { tmdbId: 12345 },
		tags: [] as number[],
		genres: [] as string[],
		...overrides,
	};
}

function createMockInstance(service: ServiceType) {
	return {
		id: INSTANCE_ID,
		label: `Test ${service}`,
		service,
		userId: MOCK_USER_ID,
		baseUrl: "http://localhost:8989",
		externalUrl: null as string | null,
		isDefault: false,
		storageGroupId: null as string | null,
		encryptedApiKey: "enc-key",
		encryptionIv: "iv",
		enabled: true,
		createdAt: new Date(),
		updatedAt: new Date(),
	};
}

const { MockSonarrClient, MockRadarrClient, MockLidarrClient, MockReadarrClient } = vi.hoisted(
	() => {
		const g = globalThis as Record<string, unknown>;

		class MockSonarr {
			series: { getAll: ReturnType<typeof vi.fn> } = {
				getAll: vi.fn().mockResolvedValue([]),
			};
			wanted: { cutoff: ReturnType<typeof vi.fn> } = {
				cutoff: vi.fn().mockResolvedValue({ records: [] }),
			};
			tag: { getAll: ReturnType<typeof vi.fn> } = {
				getAll: vi.fn().mockResolvedValue([]),
			};
		}

		class MockRadarr {
			movie: { getAll: ReturnType<typeof vi.fn> } = {
				getAll: vi.fn().mockResolvedValue([]),
			};
			wanted: { cutoff: ReturnType<typeof vi.fn> } = {
				cutoff: vi.fn().mockResolvedValue({ records: [] }),
			};
			tag: { getAll: ReturnType<typeof vi.fn> } = {
				getAll: vi.fn().mockResolvedValue([]),
			};
		}

		class MockLidarr {
			artist: { getAll: ReturnType<typeof vi.fn> } = {
				getAll: vi.fn().mockResolvedValue([]),
			};
		}

		class MockReadarr {
			author: { getAll: ReturnType<typeof vi.fn> } = {
				getAll: vi.fn().mockResolvedValue([]),
			};
		}

		g.__MockSonarrClient = MockSonarr;
		g.__MockRadarrClient = MockRadarr;
		g.__MockLidarrClient = MockLidarr;
		g.__MockReadarrClient = MockReadarr;

		return {
			MockSonarrClient: MockSonarr,
			MockRadarrClient: MockRadarr,
			MockLidarrClient: MockLidarr,
			MockReadarrClient: MockReadarr,
		};
	},
);

vi.mock("arr-sdk", () => ({
	SonarrClient: MockSonarrClient,
	RadarrClient: MockRadarrClient,
	LidarrClient: MockLidarrClient,
	ReadarrClient: MockReadarrClient,
	ArrError: class extends Error {
		statusCode: number;
		constructor(msg: string, code: number) {
			super(msg);
			this.statusCode = code;
		}
	},
	ProwlarrClient: class MockProwlarrClient {},
}));

vi.mock("../../label-sync/trigger-for-item.js", () => ({
	triggerLabelSyncForItem: vi.fn().mockResolvedValue({ rulesFired: 1 }),
}));

/**
 * Creates a mock Prisma where the transaction's inner `tx.libraryCache.create/update`
 * are plain pass-through spies. This lets tests capture every payload written inside
 * the transaction after syncInstance completes.
 */
function createMockPrisma(
	opts: {
		existingItems?: Array<{
			id: string;
			arrItemId: number;
			itemType: string;
			hasFile: boolean;
			data?: string | null;
		}>;
	} = {},
) {
	const selectCalls: unknown[] = [];
	const existingItems = opts.existingItems ?? [
		{ id: "cache-1", arrItemId: 1, itemType: "series", hasFile: false, data: null },
	];

	// Shared spy list — the transaction closure captures these by reference
	const txCreates: Array<{ data: Record<string, unknown> }> = [];
	const txUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];

	return {
		_selectCalls: selectCalls,
		_txCreates: txCreates,
		_txUpdates: txUpdates,
		librarySyncStatus: {
			upsert: vi.fn().mockResolvedValue({}),
			update: vi.fn().mockResolvedValue({}),
		},
		libraryCache: {
			findMany: vi.fn().mockImplementation((args: { select?: Record<string, unknown> }) => {
				selectCalls.push(args?.select);
				return existingItems;
			}),
			create: vi.fn().mockResolvedValue({}),
			update: vi.fn().mockResolvedValue({}),
			deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
		},
		$transaction: vi.fn().mockImplementation(
			async (
				fn: (tx: {
					libraryCache: {
						update: (args: {
							where: { id: string };
							data: Record<string, unknown>;
						}) => Promise<unknown>;
						create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
					};
				}) => Promise<void>,
			) => {
				const tx = {
					libraryCache: {
						update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
							txUpdates.push(args);
						},
						create: async (args: { data: Record<string, unknown> }) => {
							txCreates.push(args);
						},
					},
				};
				await fn(tx);
			},
		),
	} as unknown as PrismaClient & {
		_selectCalls: unknown[];
		_txCreates: Array<{ data: Record<string, unknown> }>;
		_txUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
	};
}

function createMockLog(): FastifyBaseLogger {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		fatal: vi.fn(),
		trace: vi.fn(),
		child: vi.fn(),
		level: "debug",
		silent: vi.fn(),
	} as unknown as FastifyBaseLogger;
}

function createMockEncryptor(): Encryptor {
	return {
		encrypt: vi.fn((value: string) => ({
			value: `encrypted-${value}`,
			iv: "test-iv",
		})),
		decrypt: vi.fn((_: { value: string; iv: string }) => "decrypted-api-key"),
		safeCompare: vi.fn((a: string, b: string) => a === b),
	} as unknown as Encryptor;
}

function buildArrClientFactory(
	service: ServiceType,
	rawItems: Record<string, unknown>[],
): ArrClientFactory {
	const g = globalThis as Record<string, unknown>;
	const S = g.__MockSonarrClient as new () => {
		series: { getAll: ReturnType<typeof vi.fn> };
		wanted: { cutoff: ReturnType<typeof vi.fn> };
		tag: { getAll: ReturnType<typeof vi.fn> };
	};
	const R = g.__MockRadarrClient as new () => {
		movie: { getAll: ReturnType<typeof vi.fn> };
		wanted: { cutoff: ReturnType<typeof vi.fn> };
		tag: { getAll: ReturnType<typeof vi.fn> };
	};
	const L = g.__MockLidarrClient as new () => {
		artist: { getAll: ReturnType<typeof vi.fn> };
	};
	const Rd = g.__MockReadarrClient as new () => {
		author: { getAll: ReturnType<typeof vi.fn> };
	};

	const create = vi.fn().mockImplementation(() => {
		if (service === "SONARR") {
			const client = new S();
			client.series.getAll = vi.fn().mockResolvedValue(rawItems);
			client.wanted.cutoff = vi.fn().mockResolvedValue({ records: [{ seriesId: 1 }] });
			client.tag.getAll = vi.fn().mockResolvedValue([
				{ id: 1, label: "my-tag" },
				{ id: 2, label: "" },
			]);
			return client;
		}
		if (service === "RADARR") {
			const client = new R();
			client.movie.getAll = vi.fn().mockResolvedValue(rawItems);
			client.wanted.cutoff = vi.fn().mockResolvedValue({ records: [{ id: 1 }] });
			client.tag.getAll = vi.fn().mockResolvedValue([
				{ id: 1, label: "my-tag" },
				{ id: 2, label: "" },
			]);
			return client;
		}
		if (service === "LIDARR") {
			const client = new L();
			client.artist.getAll = vi.fn().mockResolvedValue(rawItems);
			return client;
		}
		if (service === "READARR") {
			const client = new Rd();
			client.author.getAll = vi.fn().mockResolvedValue(rawItems);
			return client;
		}
		throw new Error(`Unknown service: ${service}`);
	});

	return { create } as unknown as ArrClientFactory;
}

function setupSync(
	service: "SONARR" | "RADARR" | "LIDARR" | "READARR",
	rawItems?: Record<string, unknown>[],
	existingItems?: Array<{
		id: string;
		arrItemId: number;
		itemType: string;
		hasFile: boolean;
		data?: string | null;
	}>,
) {
	const items = rawItems ?? [makeRawItem()];
	const log = createMockLog();
	const mockPrisma = createMockPrisma({ existingItems });
	const arrClientFactory = buildArrClientFactory(service, items);

	const deps: SyncExecutorDeps & { prisma: ReturnType<typeof createMockPrisma> } = {
		prisma: mockPrisma,
		arrClientFactory,
		encryptor: createMockEncryptor(),
		log,
	};

	const instance = createMockInstance(service);

	return { deps, instance, mockPrisma, log };
}

// ============================================================================
// Tests
// ============================================================================

describe("syncInstance", () => {
	// --- Data column selection tests ----------------------------------------

	describe("LibraryCache data column selection", () => {
		it("Readarr: LibraryCache.findMany should NOT select data", async () => {
			const { deps, instance, mockPrisma } = setupSync("READARR");

			await syncInstance(deps, instance);

			const select = mockPrisma._selectCalls[0] as Record<string, unknown> | undefined;
			expect(select).toBeDefined();
			expect(select).not.toHaveProperty("data");
			expect(select).toHaveProperty("id");
			expect(select).toHaveProperty("arrItemId");
			expect(select).toHaveProperty("itemType");
			expect(select).toHaveProperty("hasFile");
		});

		it("Lidarr: LibraryCache.findMany should NOT select data", async () => {
			const { deps, instance, mockPrisma } = setupSync("LIDARR");

			await syncInstance(deps, instance);

			const select = mockPrisma._selectCalls[0] as Record<string, unknown> | undefined;
			expect(select).toBeDefined();
			expect(select).not.toHaveProperty("data");
		});

		it("Sonarr: LibraryCache.findMany SHOULD select data", async () => {
			const { deps, instance, mockPrisma } = setupSync("SONARR");

			await syncInstance(deps, instance);

			const select = mockPrisma._selectCalls[0] as Record<string, unknown> | undefined;
			expect(select).toBeDefined();
			expect(select).toHaveProperty("data");
		});

		it("Radarr: LibraryCache.findMany SHOULD select data", async () => {
			const { deps, instance, mockPrisma } = setupSync("RADARR");

			await syncInstance(deps, instance);

			const select = mockPrisma._selectCalls[0] as Record<string, unknown> | undefined;
			expect(select).toBeDefined();
			expect(select).toHaveProperty("data");
		});
	});

	// --- Data write integrity (Readarr/Lidarr must write full JSON) ---------

	describe("Data write integrity", () => {
		it("Readarr create: writes valid JSON data with type=author and current title", async () => {
			const rawItems = [makeRawItem({ id: 5, title: "My Author", authorName: "My Author" })];
			const { deps, instance, mockPrisma } = setupSync("READARR", rawItems, []);

			const result = await syncInstance(deps, instance);

			expect(result.success).toBe(true);
			expect(result.itemsAdded).toBe(1);
			expect(mockPrisma._txCreates.length).toBe(1);

			const createPayload = mockPrisma._txCreates[0]!.data;
			expect(createPayload).toHaveProperty("data");
			expect(typeof createPayload.data).toBe("string");

			const parsed = JSON.parse(createPayload.data as string) as Record<string, unknown>;
			expect(parsed.type).toBe("author");
			expect(parsed.title).toBe("My Author");
			expect(parsed.id).toBe(5);
		});

		it("Lidarr create: writes valid JSON data with type=artist and current title", async () => {
			const rawItems = [makeRawItem({ id: 7, artistName: "My Artist" })];
			const { deps, instance, mockPrisma } = setupSync("LIDARR", rawItems, []);

			const result = await syncInstance(deps, instance);

			expect(result.success).toBe(true);
			expect(result.itemsAdded).toBe(1);
			expect(mockPrisma._txCreates.length).toBe(1);

			const createPayload = mockPrisma._txCreates[0]!.data;
			const parsed = JSON.parse(createPayload.data as string) as Record<string, unknown>;
			expect(parsed.type).toBe("artist");
			expect(parsed.title).toBe("My Artist");
			expect(parsed.id).toBe(7);
		});

		it("Readarr update: writes updated JSON data with current title", async () => {
			const rawItems = [
				makeRawItem({ id: 1, title: "Updated Author", authorName: "Updated Author" }),
			];
			const existingItems = [{ id: "cache-1", arrItemId: 1, itemType: "author", hasFile: false }];

			const { deps, instance, mockPrisma } = setupSync("READARR", rawItems, existingItems);

			const result = await syncInstance(deps, instance);

			expect(result.success).toBe(true);
			expect(result.itemsUpdated).toBe(1);
			expect(mockPrisma._txUpdates.length).toBe(1);

			const updatePayload = mockPrisma._txUpdates[0]!;
			expect(updatePayload.where.id).toBe("cache-1");
			expect(updatePayload.data).toHaveProperty("data");

			const parsed = JSON.parse(updatePayload.data.data as string) as Record<string, unknown>;
			expect(parsed.type).toBe("author");
			expect(parsed.title).toBe("Updated Author");
		});

		it("Lidarr update: writes updated JSON data with current title", async () => {
			const rawItems = [makeRawItem({ id: 1, artistName: "Updated Artist" })];
			const existingItems = [{ id: "cache-1", arrItemId: 1, itemType: "artist", hasFile: false }];

			const { deps, instance, mockPrisma } = setupSync("LIDARR", rawItems, existingItems);

			const result = await syncInstance(deps, instance);

			expect(result.success).toBe(true);
			expect(result.itemsUpdated).toBe(1);
			expect(mockPrisma._txUpdates.length).toBe(1);

			const parsed = JSON.parse(mockPrisma._txUpdates[0]!.data.data as string) as Record<
				string,
				unknown
			>;
			expect(parsed.type).toBe("artist");
			expect(parsed.title).toBe("Updated Artist");
		});

		it("Sonarr create: always writes full JSON data", async () => {
			const rawItems = [makeRawItem({ id: 3, title: "New Series" })];
			const { deps, instance, mockPrisma } = setupSync("SONARR", rawItems, []);

			const result = await syncInstance(deps, instance);

			expect(result.success).toBe(true);
			expect(result.itemsAdded).toBe(1);
			expect(mockPrisma._txCreates.length).toBe(1);

			const parsed = JSON.parse(mockPrisma._txCreates[0]!.data.data as string) as Record<
				string,
				unknown
			>;
			expect(parsed.type).toBe("series");
			expect(parsed.title).toBe("New Series");
		});
	});

	// --- Batching (no full items array) -------------------------------------

	describe("Batched processing without full normalized array", () => {
		it("Readarr: processes 250 items in 3 batches (100+100+50)", async () => {
			const rawItems = Array.from({ length: 250 }, (_, i) =>
				makeRawItem({ id: i + 1, authorName: `Author ${i + 1}` }),
			);
			const existingItems = rawItems.map((r) => ({
				id: `cache-${r.id}`,
				arrItemId: r.id as number,
				itemType: "author",
				hasFile: false,
			}));

			const { deps, instance, mockPrisma } = setupSync("READARR", rawItems, existingItems);

			const result = await syncInstance(deps, instance);

			expect(result.success).toBe(true);
			expect(result.itemsProcessed).toBe(250);
			expect(result.itemsUpdated).toBe(250);

			const txCalls = (mockPrisma.$transaction as ReturnType<typeof vi.fn>).mock.calls;
			expect(txCalls.length).toBe(3);
		});

		it("Lidarr: processes a single-item batch correctly", async () => {
			const rawItems = [makeRawItem()];
			const existingItems = [{ id: "cache-1", arrItemId: 1, itemType: "artist", hasFile: false }];

			const { deps, instance } = setupSync("LIDARR", rawItems, existingItems);

			const result = await syncInstance(deps, instance);

			expect(result.success).toBe(true);
			expect(result.itemsProcessed).toBe(1);
			expect(result.itemsUpdated).toBe(1);
		});

		it("Readarr: creates new items when cache is empty", async () => {
			const rawItems = [makeRawItem({ id: 5, authorName: "Author 5" })];
			const { deps, instance } = setupSync("READARR", rawItems, []);

			const result = await syncInstance(deps, instance);

			expect(result.success).toBe(true);
			expect(result.itemsAdded).toBe(1);
			expect(result.itemsProcessed).toBe(1);
		});

		// Pins the issue #427 pop-based batch drain. Two assertions:
		// (a) every input id is touched exactly once — sync correctness regardless
		//     of drain shape.
		// (b) the FIRST update targets the LAST input id — only true for a
		//     tail-popping drain (or any other shrinking pattern that consumes
		//     from the end). A future refactor that re-introduces `slice()` or
		//     builds a normalized forward copy would process id=1 first and fail
		//     this assertion, surfacing the regression.
		it("Lidarr: pop-based drain processes tail-first and touches every arrItemId (issue #427)", async () => {
			const COUNT = 150; // spans 2 batches at BATCH_SIZE=100
			const rawItems = Array.from({ length: COUNT }, (_, i) =>
				makeRawItem({ id: i + 1, artistName: `Artist ${i + 1}` }),
			);
			const existingItems = rawItems.map((r) => ({
				id: `cache-${r.id}`,
				arrItemId: r.id as number,
				itemType: "artist",
				hasFile: false,
			}));

			const { deps, instance, mockPrisma } = setupSync("LIDARR", rawItems, existingItems);

			const result = await syncInstance(deps, instance);

			expect(result.success).toBe(true);
			expect(result.itemsProcessed).toBe(COUNT);
			expect(result.itemsUpdated).toBe(COUNT);

			// (a) Coverage: every cache id touched exactly once.
			const touchedIds = new Set(mockPrisma._txUpdates.map((u) => u.where.id));
			expect(touchedIds.size).toBe(COUNT);
			for (let i = 1; i <= COUNT; i++) {
				expect(touchedIds.has(`cache-${i}`)).toBe(true);
			}

			// (b) Order: first update targets the tail (id=150). Re-introducing
			// slice() would process id=1 first and fail this.
			expect(mockPrisma._txUpdates[0]?.where.id).toBe(`cache-${COUNT}`);
		});
	});

	// --- Tag-delta: Sonarr/Radarr only -------------------------------------

	describe("Tag-delta detection (Sonarr/Radarr only)", () => {
		it("Radarr: detects tag change and fires label sync trigger", async () => {
			const rawItems = [
				makeRawItem({
					id: 1,
					tags: [1],
					tmdbId: 12345,
					remoteIds: { tmdbId: 12345 },
				}),
			];
			const existingItems = [
				{
					id: "cache-1",
					arrItemId: 1,
					itemType: "movie",
					hasFile: false,
					data: JSON.stringify({ tags: [] }),
				},
			];

			const { deps, instance, log } = setupSync("RADARR", rawItems, existingItems);

			const result = await syncInstance(deps, instance);

			expect(result.success).toBe(true);
			expect(result.itemsUpdated).toBe(1);

			const { triggerLabelSyncForItem } = await import("../../label-sync/trigger-for-item.js");
			expect(triggerLabelSyncForItem).toHaveBeenCalledWith(
				expect.objectContaining({
					sourceService: "RADARR",
					arrItemId: 1,
					itemType: "movie",
					tagName: "my-tag",
					tmdbId: 12345,
				}),
			);

			const infoCalls = (log.info as ReturnType<typeof vi.fn>).mock.calls.filter(
				(call: unknown[]) =>
					typeof call[1] === "string" && (call[1] as string).includes("Library sync delta fired"),
			);
			expect(infoCalls.length).toBe(1);
		});

		it("Sonarr: detects tag change and fires label sync trigger", async () => {
			const rawItems = [
				makeRawItem({
					id: 1,
					tags: [1],
					tmdbId: 12345,
					remoteIds: { tmdbId: 12345 },
				}),
			];
			const existingItems = [
				{
					id: "cache-1",
					arrItemId: 1,
					itemType: "series",
					hasFile: false,
					data: JSON.stringify({ tags: [] }),
				},
			];

			const { deps, instance } = setupSync("SONARR", rawItems, existingItems);

			const result = await syncInstance(deps, instance);

			expect(result.success).toBe(true);
			expect(result.itemsUpdated).toBe(1);

			const { triggerLabelSyncForItem } = await import("../../label-sync/trigger-for-item.js");
			expect(triggerLabelSyncForItem).toHaveBeenCalledWith(
				expect.objectContaining({
					sourceService: "SONARR",
					arrItemId: 1,
					itemType: "series",
					tagName: "my-tag",
					tmdbId: 12345,
				}),
			);
		});

		it("Readarr: does NOT fire label sync triggers", async () => {
			const rawItems = [makeRawItem({ id: 1, tags: [1, 2], authorName: "Author" })];
			const existingItems = [{ id: "cache-1", arrItemId: 1, itemType: "author", hasFile: false }];

			const { deps, instance } = setupSync("READARR", rawItems, existingItems);

			const result = await syncInstance(deps, instance);

			expect(result.success).toBe(true);

			const { triggerLabelSyncForItem } = await import("../../label-sync/trigger-for-item.js");
			const relevantCalls = (triggerLabelSyncForItem as ReturnType<typeof vi.fn>).mock.calls.filter(
				(call: unknown[]) => (call[0] as { itemType?: string }).itemType === "author",
			);
			expect(relevantCalls).toHaveLength(0);
		});
	});

	// --- New download detection ---------------------------------------------

	describe("New download detection (hasFile false->true)", () => {
		it("Sonarr: detects when hasFile transitions from false to true", async () => {
			const rawItems = [
				makeRawItem({
					id: 1,
					title: "Downloaded Series",
					statistics: { episodeFileCount: 1 },
				}),
			];
			const existingItems = [
				{
					id: "cache-1",
					arrItemId: 1,
					itemType: "series",
					hasFile: false,
					data: JSON.stringify({ tags: [] }),
				},
			];

			const { deps, instance } = setupSync("SONARR", rawItems, existingItems);

			const result = await syncInstance(deps, instance);

			expect(result.success).toBe(true);
			expect(result.newDownloads).toHaveLength(1);
			expect(result.newDownloads[0]).toEqual({
				title: "Downloaded Series",
				itemType: "series",
			});
		});

		it("Readarr: detects when hasFile transitions from false to true", async () => {
			const rawItems = [
				makeRawItem({
					id: 1,
					title: "Downloaded Book",
					authorName: "Downloaded Book",
					statistics: { bookFileCount: 1 },
				}),
			];
			const existingItems = [{ id: "cache-1", arrItemId: 1, itemType: "author", hasFile: false }];

			const { deps, instance } = setupSync("READARR", rawItems, existingItems);

			const result = await syncInstance(deps, instance);

			expect(result.success).toBe(true);
			expect(result.newDownloads).toHaveLength(1);
			expect(result.newDownloads[0]).toEqual({
				title: "Downloaded Book",
				itemType: "author",
			});
		});
	});

	// --- Item removal detection ---------------------------------------------

	describe("Stale item removal", () => {
		it("removes items in cache that are not in the ARR response", async () => {
			const rawItems = [makeRawItem({ id: 1 })];
			const existingItems = [
				{ id: "cache-1", arrItemId: 1, itemType: "series", hasFile: false, data: null },
				{ id: "cache-2", arrItemId: 99, itemType: "series", hasFile: true, data: null },
			];

			const { deps, instance, mockPrisma } = setupSync("SONARR", rawItems, existingItems);

			const result = await syncInstance(deps, instance);

			expect(result.success).toBe(true);
			expect(result.itemsRemoved).toBe(1);
			expect(mockPrisma.libraryCache.deleteMany).toHaveBeenCalledWith({
				where: { id: { in: ["cache-2"] } },
			});
		});

		// Pins the v2.18.5 cursor-paginated existing-items load (issue #427
		// follow-up). The pre-refactor shape held a single `existingItems`
		// array used for both the upsert map AND the post-sync deletion-id
		// diff. The new shape walks libraryCache in cursor batches, collecting
		// (id, arrItemId, itemType) into `existingForDeletion` as it goes.
		// Verify the deletion set is identical when input is delivered across
		// MULTIPLE cursor batches, not just one — without this, a refactor
		// that resets `existingForDeletion` per batch would silently leak
		// zombie cache rows.
		it("cursor-paginates existing-items load and computes the SAME deletion set across batches", async () => {
			// 600 existing rows → 2 cursor batches at SYNC_QUERY_BATCH_SIZE=500.
			const TOTAL = 600;
			const existingItems = Array.from({ length: TOTAL }, (_, i) => ({
				id: `cache-${String(i).padStart(4, "0")}`,
				arrItemId: i + 1,
				itemType: "series" as const,
				hasFile: false,
				data: null as string | null,
			}));

			// ARR returns the first 200 items; the remaining 400 should be
			// flagged for deletion.
			const KEPT = 200;
			const rawItems = Array.from({ length: KEPT }, (_, i) =>
				makeRawItem({ id: i + 1, title: `Series ${i + 1}` }),
			);

			const { deps, instance, mockPrisma } = setupSync(
				"SONARR",
				rawItems,
				// Pass a placeholder so the default mock doesn't deliver all rows
				// in a single call — we override findMany below to simulate Prisma's
				// cursor-pagination semantics. The placeholder is just a type hint
				// for createMockPrisma.
				existingItems.slice(0, 1),
			);

			// Override findMany to mimic Prisma's cursor-pagination behavior:
			// without a cursor, return rows starting at index 0; with a cursor,
			// return rows AFTER the cursor row (skip:1). Bound by `take`.
			const findManySpy = vi
				.fn()
				.mockImplementation((args: { cursor?: { id: string }; skip?: number; take?: number }) => {
					const take = args.take ?? existingItems.length;
					if (!args.cursor) {
						return Promise.resolve(existingItems.slice(0, take));
					}
					const cursorIdx = existingItems.findIndex((row) => row.id === args.cursor!.id);
					const startIdx = cursorIdx === -1 ? 0 : cursorIdx + (args.skip ?? 0);
					return Promise.resolve(existingItems.slice(startIdx, startIdx + take));
				});
			mockPrisma.libraryCache.findMany = findManySpy;

			const result = await syncInstance(deps, instance);

			expect(result.success).toBe(true);
			// The 400 rows whose arrItemId falls outside the kept set must be deleted.
			expect(result.itemsRemoved).toBe(TOTAL - KEPT);

			// Cursor walk must have made >= 2 calls — proves the pagination loop
			// actually advanced past batch 1 instead of degenerating to a single read.
			expect(findManySpy.mock.calls.length).toBeGreaterThanOrEqual(2);

			// Second call must carry cursor + skip:1, matching the proven
			// pattern from cleanup-executor.ts's prefetch helpers.
			const secondCallArgs = findManySpy.mock.calls[1]?.[0] as
				| { cursor?: { id: string }; skip?: number }
				| undefined;
			expect(secondCallArgs?.cursor).toBeDefined();
			expect(secondCallArgs?.skip).toBe(1);

			// The deleted ids must be EXACTLY the 400 stale rows — not a subset
			// (would mean missed evictions / zombies) and not a superset
			// (would mean live rows wrongly deleted).
			const deleteCall = (mockPrisma.libraryCache.deleteMany as ReturnType<typeof vi.fn>).mock
				.calls[0]?.[0];
			const deletedIds = (deleteCall?.where?.id?.in ?? []) as string[];
			expect(deletedIds).toHaveLength(TOTAL - KEPT);
			// Stale rows are arrItemIds 201..600 → cache ids cache-0200..cache-0599.
			expect(deletedIds).toContain("cache-0200");
			expect(deletedIds).toContain("cache-0599");
			// Kept rows must NOT appear in the deletion set.
			expect(deletedIds).not.toContain("cache-0000");
			expect(deletedIds).not.toContain("cache-0199");
		});
	});

	// --- Memory instrumentation ---------------------------------------------

	describe("Memory instrumentation", () => {
		it("logs memory usage at debug level during sync phases", async () => {
			const { deps, instance, log } = setupSync("SONARR");

			await syncInstance(deps, instance);

			const debugCalls = (log.debug as ReturnType<typeof vi.fn>).mock.calls;
			const memCalls = debugCalls.filter(
				(call: unknown[]) =>
					typeof call[1] === "string" && (call[1] as string) === "Library sync memory usage",
			);
			expect(memCalls.length).toBeGreaterThanOrEqual(1);

			const memObj = memCalls[0]?.[0] as Record<string, unknown> | undefined;
			expect(memObj).toHaveProperty("phase");
			expect(memObj).toHaveProperty("heapUsedMB");
			expect(memObj).toHaveProperty("heapTotalMB");
		});

		it("does NOT log memory instrumentation when log level is silent", async () => {
			const { deps, instance, log } = setupSync("LIDARR");
			(log as { level?: string }).level = "silent";

			await syncInstance(deps, instance);

			const debugCalls = (log.debug as ReturnType<typeof vi.fn>).mock.calls;
			const memCalls = debugCalls.filter(
				(call: unknown[]) =>
					typeof call[1] === "string" && (call[1] as string) === "Library sync memory usage",
			);
			expect(memCalls.length).toBe(0);
		});
	});

	// --- Sync status updates ------------------------------------------------

	describe("Sync status updates", () => {
		it("marks sync as in-progress at start and complete on success", async () => {
			const { deps, instance, mockPrisma } = setupSync("LIDARR");

			const result = await syncInstance(deps, instance);

			expect(result.success).toBe(true);

			const upsertCall = mockPrisma.librarySyncStatus.upsert as ReturnType<typeof vi.fn>;
			expect(upsertCall).toHaveBeenCalledWith(
				expect.objectContaining({
					where: { instanceId: instance.id },
					create: expect.objectContaining({ syncInProgress: true }),
				}),
			);

			const updateCall = mockPrisma.librarySyncStatus.update as ReturnType<typeof vi.fn>;
			expect(updateCall).toHaveBeenCalledWith(
				expect.objectContaining({
					where: { instanceId: instance.id },
					data: expect.objectContaining({
						syncInProgress: false,
						lastError: null,
					}),
				}),
			);
		});

		it("records error in sync status on failure", async () => {
			const mockPrisma = createMockPrisma();
			mockPrisma.librarySyncStatus.upsert = vi.fn().mockRejectedValue(new Error("DB down"));

			const deps = {
				prisma: mockPrisma,
				arrClientFactory: { create: vi.fn() } as unknown as ArrClientFactory,
				encryptor: createMockEncryptor(),
				log: createMockLog(),
			};
			const instance = createMockInstance("READARR");

			const result = await syncInstance(deps, instance);

			expect(result.success).toBe(false);
			expect(result.error).toBe("DB down");
		});
	});

	// --- Cutoff-unmet (Sonarr/Radarr) ---------------------------------------

	describe("Cutoff-unmet handling", () => {
		it("Sonarr: fetches and stores cutoff-unmet IDs", async () => {
			const { deps, instance, mockPrisma } = setupSync("SONARR");

			await syncInstance(deps, instance);

			const fn = (mockPrisma.$transaction as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
			expect(fn).toBeDefined();
		});

		it("Readarr: does NOT fetch cutoff-unmet data", async () => {
			const { deps, instance, mockPrisma } = setupSync("READARR");

			const result = await syncInstance(deps, instance);

			expect(result.success).toBe(true);
			const fn = (mockPrisma.$transaction as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
			expect(fn).toBeDefined();
		});
	});

	// --- Result structure ---------------------------------------------------

	describe("SyncResult structure", () => {
		it("returns correctly structured SyncResult on success", async () => {
			const { deps, instance } = setupSync("SONARR");

			const result = await syncInstance(deps, instance);

			expect(result).toMatchObject({
				instanceId: instance.id,
				instanceName: instance.label,
				success: true,
				itemsProcessed: expect.any(Number),
				itemsAdded: expect.any(Number),
				itemsUpdated: expect.any(Number),
				itemsRemoved: expect.any(Number),
				newDownloads: expect.any(Array),
				durationMs: expect.any(Number),
			});
			expect(result.error).toBeUndefined();
		});
	});

	// --- Silence-only instrumentation ---------------------------------------

	describe("Silence memory instrumentation", () => {
		it("does NOT log memory instrumentation when log level is null/undefined", async () => {
			const { deps, instance, log } = setupSync("READARR");
			delete (log as { level?: string }).level;

			await syncInstance(deps, instance);

			const debugCalls = (log.debug as ReturnType<typeof vi.fn>).mock.calls;
			const memCalls = debugCalls.filter(
				(call: unknown[]) =>
					typeof call[1] === "string" && (call[1] as string) === "Library sync memory usage",
			);
			expect(memCalls.length).toBe(0);
		});
	});
});
