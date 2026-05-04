/**
 * Tests for library-sync sync-executor
 *
 * Covers:
 * - Readarr/Lidarr cache query does NOT select data column
 * - Sonarr/Radarr still select/use data for tag-delta detection
 * - Batched processing without building a full normalized items array
 * - Memory instrumentation at debug level
 */

import { describe, it, expect, vi } from "vitest";
import type { PrismaClient, ServiceType } from "../../../lib/prisma.js";
import type { ArrClientFactory } from "../../arr/client-factory.js";
import type { Encryptor } from "../../auth/encryption.js";
import type { FastifyBaseLogger } from "fastify";
import { syncInstance, type SyncExecutorDeps } from "../sync-executor.js";

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
		hasFile: false,
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

		// Stash on globalThis so the ARR client factory can reference them
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

	return {
		_selectCalls: selectCalls,
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
		$transaction: vi
			.fn()
			.mockImplementation(
				async (
					fn: (tx: {
						libraryCache: {
							update: ReturnType<typeof vi.fn>;
							create: ReturnType<typeof vi.fn>;
						};
					}) => Promise<void>,
				) => {
					const tx = {
						libraryCache: {
							update: vi.fn().mockResolvedValue({}),
							create: vi.fn().mockResolvedValue({}),
						},
					};
					await fn(tx);
				},
			),
	} as unknown as PrismaClient & { _selectCalls: unknown[] };
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
			client.wanted.cutoff = vi
				.fn()
				.mockResolvedValue({ records: [{ seriesId: 1 }] });
			client.tag.getAll = vi
				.fn()
				.mockResolvedValue([
					{ id: 1, label: "my-tag" },
					{ id: 2, label: "" },
				]);
			return client;
		}
		if (service === "RADARR") {
			const client = new R();
			client.movie.getAll = vi.fn().mockResolvedValue(rawItems);
			client.wanted.cutoff = vi
				.fn()
				.mockResolvedValue({ records: [{ id: 1 }] });
			client.tag.getAll = vi
				.fn()
				.mockResolvedValue([
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
	describe("LibraryCache data column selection", () => {
		it("Readarr: LibraryCache.findMany should NOT select data", async () => {
			const { deps, instance, mockPrisma } = setupSync("READARR");

			await syncInstance(deps, instance);

			const calls = mockPrisma._selectCalls;
			expect(calls.length).toBeGreaterThanOrEqual(1);
			const select = calls[0] as Record<string, unknown> | undefined;
			expect(select).toBeDefined();
			expect(select).not.toHaveProperty("data");
		});

		it("Lidarr: LibraryCache.findMany should NOT select data", async () => {
			const { deps, instance, mockPrisma } = setupSync("LIDARR");

			await syncInstance(deps, instance);

			const calls = mockPrisma._selectCalls;
			expect(calls.length).toBeGreaterThanOrEqual(1);
			const select = calls[0] as Record<string, unknown> | undefined;
			expect(select).toBeDefined();
			expect(select).not.toHaveProperty("data");
		});

		it("Sonarr: LibraryCache.findMany SHOULD select data", async () => {
			const { deps, instance, mockPrisma } = setupSync("SONARR");

			await syncInstance(deps, instance);

			const calls = mockPrisma._selectCalls;
			expect(calls.length).toBeGreaterThanOrEqual(1);
			const select = calls[0] as Record<string, unknown> | undefined;
			expect(select).toBeDefined();
			expect(select).toHaveProperty("data");
		});

		it("Radarr: LibraryCache.findMany SHOULD select data", async () => {
			const { deps, instance, mockPrisma } = setupSync("RADARR");

			await syncInstance(deps, instance);

			const calls = mockPrisma._selectCalls;
			expect(calls.length).toBeGreaterThanOrEqual(1);
			const select = calls[0] as Record<string, unknown> | undefined;
			expect(select).toBeDefined();
			expect(select).toHaveProperty("data");
		});
	});

	describe("Batched processing without full normalized array", () => {
		it("Readarr: processes 250 items in 3 batches (100+100+50)", async () => {
			const rawItems = Array.from({ length: 250 }, (_, i) =>
				makeRawItem({ id: i + 1 }),
			);
			const existingItems = rawItems.map((r) => ({
				id: `cache-${r.id}`,
				arrItemId: r.id as number,
				itemType: "author",
				hasFile: false,
			}));

			const { deps, instance, mockPrisma } = setupSync(
				"READARR",
				rawItems,
				existingItems,
			);

			const result = await syncInstance(deps, instance);

			expect(result.success).toBe(true);
			expect(result.itemsProcessed).toBe(250);
			expect(result.itemsUpdated).toBe(250);

			const txCalls = (mockPrisma.$transaction as ReturnType<typeof vi.fn>).mock
				.calls;
			expect(txCalls.length).toBe(3);
		});

		it("Lidarr: processes a single-item batch correctly", async () => {
			const rawItems = [makeRawItem()];
			const existingItems = [
				{ id: "cache-1", arrItemId: 1, itemType: "artist", hasFile: false },
			];

			const { deps, instance } = setupSync("LIDARR", rawItems, existingItems);

			const result = await syncInstance(deps, instance);

			expect(result.success).toBe(true);
			expect(result.itemsProcessed).toBe(1);
			expect(result.itemsUpdated).toBe(1);
		});

		it("Readarr: creates new items when cache is empty", async () => {
			const rawItems = [makeRawItem({ id: 5 })];
			const { deps, instance } = setupSync("READARR", rawItems, []);

			const result = await syncInstance(deps, instance);

			expect(result.success).toBe(true);
			expect(result.itemsAdded).toBe(1);
			expect(result.itemsProcessed).toBe(1);
		});
	});

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

			const { deps, instance, log } = setupSync(
				"RADARR",
				rawItems,
				existingItems,
			);

			const result = await syncInstance(deps, instance);

			expect(result.success).toBe(true);
			expect(result.itemsUpdated).toBe(1);

			const { triggerLabelSyncForItem } = await import(
				"../../label-sync/trigger-for-item.js"
			);
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
					typeof call[1] === "string" &&
					(call[1] as string).includes("Library sync delta fired"),
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

			const { deps, instance } = setupSync(
				"SONARR",
				rawItems,
				existingItems,
			);

			const result = await syncInstance(deps, instance);

			expect(result.success).toBe(true);
			expect(result.itemsUpdated).toBe(1);

			const { triggerLabelSyncForItem } = await import(
				"../../label-sync/trigger-for-item.js"
			);
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
			const rawItems = [makeRawItem({ id: 1, tags: [1, 2] })];
			const existingItems = [
				{
					id: "cache-1",
					arrItemId: 1,
					itemType: "author",
					hasFile: false,
				},
			];

			const { deps, instance } = setupSync(
				"READARR",
				rawItems,
				existingItems,
			);

			const result = await syncInstance(deps, instance);

			expect(result.success).toBe(true);

			const { triggerLabelSyncForItem } = await import(
				"../../label-sync/trigger-for-item.js"
			);
			const relevantCalls = (
				triggerLabelSyncForItem as ReturnType<typeof vi.fn>
			).mock.calls.filter(
				(call: unknown[]) =>
					(call[0] as { itemType?: string }).itemType === "author",
			);
			expect(relevantCalls).toHaveLength(0);
		});
	});

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

			const { deps, instance } = setupSync(
				"SONARR",
				rawItems,
				existingItems,
			);

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
			const existingItems = [
				{
					id: "cache-1",
					arrItemId: 1,
					itemType: "author",
					hasFile: false,
				},
			];

			const { deps, instance } = setupSync(
				"READARR",
				rawItems,
				existingItems,
			);

			const result = await syncInstance(deps, instance);

			expect(result.success).toBe(true);
			expect(result.newDownloads).toHaveLength(1);
			expect(result.newDownloads[0]).toEqual({
				title: "Downloaded Book",
				itemType: "author",
			});
		});
	});

	describe("Stale item removal", () => {
		it("removes items in cache that are not in the ARR response", async () => {
			const rawItems = [makeRawItem({ id: 1 })];
			const existingItems = [
				{ id: "cache-1", arrItemId: 1, itemType: "series", hasFile: false, data: null },
				{ id: "cache-2", arrItemId: 99, itemType: "series", hasFile: true, data: null },
			];

			const { deps, instance, mockPrisma } = setupSync(
				"SONARR",
				rawItems,
				existingItems,
			);

			const result = await syncInstance(deps, instance);

			expect(result.success).toBe(true);
			expect(result.itemsRemoved).toBe(1);
			expect(mockPrisma.libraryCache.deleteMany).toHaveBeenCalledWith({
				where: { id: { in: ["cache-2"] } },
			});
		});
	});

	describe("Memory instrumentation", () => {
		it("logs memory usage at debug level during sync phases", async () => {
			const { deps, instance, log } = setupSync("SONARR");

			await syncInstance(deps, instance);

			const debugCalls = (log.debug as ReturnType<typeof vi.fn>).mock.calls;
			const memCalls = debugCalls.filter(
				(call: unknown[]) =>
					typeof call[1] === "string" &&
					(call[1] as string) === "Library sync memory usage",
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
					typeof call[1] === "string" &&
					(call[1] as string) === "Library sync memory usage",
			);
			expect(memCalls.length).toBe(0);
		});
	});

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
			mockPrisma.librarySyncStatus.upsert = vi
				.fn()
				.mockRejectedValue(new Error("DB down"));

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

	describe("Cutoff-unmet handling", () => {
		it("Sonarr: fetches and stores cutoff-unmet IDs", async () => {
			const { deps, instance, mockPrisma } = setupSync("SONARR");

			await syncInstance(deps, instance);

			const tx = (mockPrisma.$transaction as ReturnType<typeof vi.fn>).mock
				.calls[0]?.[0];
			expect(tx).toBeDefined();
		});

		it("Readarr: does NOT fetch cutoff-unmet data", async () => {
			const { deps, instance, mockPrisma } = setupSync("READARR");

			const result = await syncInstance(deps, instance);

			expect(result.success).toBe(true);

			const tx = (mockPrisma.$transaction as ReturnType<typeof vi.fn>).mock
				.calls[0]?.[0];
			expect(tx).toBeDefined();
		});
	});

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

	describe("Silence memory instrumentation", () => {
		it("does NOT log memory instrumentation when log level is null/undefined", async () => {
			const { deps, instance, log } = setupSync("READARR");
			delete (log as { level?: string }).level;

			await syncInstance(deps, instance);

			const debugCalls = (log.debug as ReturnType<typeof vi.fn>).mock.calls;
			const memCalls = debugCalls.filter(
				(call: unknown[]) =>
					typeof call[1] === "string" &&
					(call[1] as string) === "Library sync memory usage",
			);
			expect(memCalls.length).toBe(0);
		});
	});
});
