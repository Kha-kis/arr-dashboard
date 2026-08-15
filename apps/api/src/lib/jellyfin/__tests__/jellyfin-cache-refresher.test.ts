/**
 * Jellyfin Cache Refresher Tests
 *
 * Validates the aggregation logic inside refreshJellyfinCache, with a focus
 * on the partially-watched series fix: lastWatchedAt should be set whenever
 * lastPlayedDate is present, even if item.played === false.
 */

import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	collectJellyfinCacheLiveEvidence,
	JELLYFIN_CACHE_PUBLICATION_CHUNK_SIZE,
	JELLYFIN_CACHE_PUBLICATION_TRANSACTION_TIMEOUT_MS,
	refreshJellyfinCache as refreshGuardedJellyfinCache,
} from "../jellyfin-cache-refresher.js";
import type {
	JellyfinClient,
	JellyfinItem,
	JellyfinLibrary,
	JellyfinUser,
} from "../jellyfin-client.js";

const publication = vi.hoisted(() => ({ client: undefined as JellyfinClient | undefined }));

vi.mock("../jellyfin-client.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../jellyfin-client.js")>();
	return {
		...actual,
		JellyfinClient: class {
			constructor() {
				if (!publication.client) throw new Error("Jellyfin test client was not configured");
				Object.assign(this, publication.client);
			}
		},
	};
});

vi.mock("../../services/provider-identity-guard.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../services/provider-identity-guard.js")>();
	return {
		...actual,
		withGuardedProviderPublication: vi.fn(
			async (
				prisma: {
					$transaction: (
						callback: (tx: unknown) => Promise<unknown>,
						options?: unknown,
					) => Promise<unknown>;
				},
				_instance: unknown,
				_log: unknown,
				collect: () => Promise<unknown>,
				publish: (tx: unknown, snapshot: unknown) => Promise<unknown>,
				options: unknown,
			) => {
				const snapshot = await collect();
				if ((snapshot as { complete?: boolean }).complete !== true) return snapshot;
				return await prisma.$transaction(async (tx) => await publish(tx, snapshot), {
					isolationLevel: "Serializable",
					...(options as object),
				});
			},
		),
	};
});

async function refreshJellyfinCache(
	client: JellyfinClient,
	prisma: never,
	instanceId: string,
	log: FastifyBaseLogger,
	_expectedConnection?: string,
	options?: { publish?: boolean },
) {
	if (options?.publish === false) {
		return await collectJellyfinCacheLiveEvidence(client, instanceId, log);
	}
	publication.client = client;
	return await refreshGuardedJellyfinCache({
		prisma,
		instance: {
			id: instanceId,
			userId: "user-1",
			service: "JELLYFIN",
			label: "Jellyfin",
			baseUrl: "https://jellyfin-current.example.com",
			apiKey: "key",
			httpAuthHeaders: {},
			enabled: true,
			encryptedApiKey: "current-key",
			encryptionIv: "current-iv",
			encryptedHttpAuthCredentials: null,
			httpAuthEncryptionIv: null,
			expectedIdentity: "jellyfin-a",
			identityStatus: "VERIFIED",
			connectionGeneration: 7,
			identityGeneration: 3,
		},
		log,
	});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const silentLog = {
	warn: vi.fn(),
	info: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
	child: vi.fn(),
} as unknown as FastifyBaseLogger;

function makeSeriesItem(overrides: Partial<JellyfinItem> = {}): JellyfinItem {
	return {
		id: "jf-series-1",
		name: "Amadeus",
		type: "Series",
		tmdbId: 99999,
		played: false,
		playCount: 0,
		lastPlayedDate: null,
		isFavorite: false,
		imageTags: {},
		...overrides,
	};
}

const oneUser: JellyfinUser[] = [{ id: "user-1", name: "Alice" }];
const oneLibrary: JellyfinLibrary[] = [
	{ id: "lib-1", name: "TV Shows", collectionType: "tvshows" },
];

/**
 * Build a minimal mock JellyfinClient that serves the given library items.
 */
function makeMockClient(items: JellyfinItem[]): JellyfinClient {
	return {
		getUsers: vi.fn().mockResolvedValue(oneUser),
		getLibraries: vi.fn().mockResolvedValue(oneLibrary),
		getLibraryItems: vi.fn().mockResolvedValue(items),
		getResumeItems: vi.fn().mockResolvedValue([]),
		getNextUp: vi.fn().mockResolvedValue([]),
	} as unknown as JellyfinClient;
}

/**
 * Build a minimal Prisma stub that captures upsert payloads.
 */
function makeMockPrisma() {
	const upserts: unknown[] = [];
	const tx = {
		$queryRawUnsafe: vi.fn().mockResolvedValue([]),
		serviceInstance: {
			findUnique: vi.fn().mockResolvedValue({
				service: "JELLYFIN",
				baseUrl: "https://jellyfin-current.example.com",
				encryptedApiKey: "current-key",
				encryptionIv: "current-iv",
				encryptedHttpAuthCredentials: null,
				httpAuthEncryptionIv: null,
				enabled: true,
				connectionGeneration: 7,
			}),
		},
		jellyfinCache: {
			deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
			createMany: vi.fn(async ({ data }: { data: unknown[] }) => {
				for (const row of data) upserts.push({ create: row });
				return { count: data.length };
			}),
		},
		cacheRefreshStatus: { upsert: vi.fn().mockResolvedValue({}) },
	};
	const stub = {
		jellyfinCache: tx.jellyfinCache,
		cacheRefreshStatus: tx.cacheRefreshStatus,
		$transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
			callback(tx),
		),
	};
	return { stub, upserts, tx };
}

afterEach(() => {
	vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("refreshJellyfinCache — lastWatchedAt aggregation", () => {
	it("publishes a large cache through bounded createMany calls", async () => {
		const itemCount = JELLYFIN_CACHE_PUBLICATION_CHUNK_SIZE * 2 + 17;
		const items = Array.from({ length: itemCount }, (_, index) =>
			makeSeriesItem({
				id: `jf-series-${index}`,
				name: `Series ${index}`,
				tmdbId: 100_000 + index,
			}),
		);
		const client = makeMockClient(items);
		const { stub, tx } = makeMockPrisma();

		const result = await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: itemCount });
		expect(tx.jellyfinCache.createMany).toHaveBeenCalledTimes(3);
		for (const [call] of tx.jellyfinCache.createMany.mock.calls) {
			expect(call.data.length).toBeLessThanOrEqual(JELLYFIN_CACHE_PUBLICATION_CHUNK_SIZE);
		}
		expect(stub.$transaction).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({ timeout: JELLYFIN_CACHE_PUBLICATION_TRANSACTION_TIMEOUT_MS }),
		);
	});

	it("sets lastWatchedAt for a fully-watched series (item.played === true)", async () => {
		const item = makeSeriesItem({
			played: true,
			playCount: 2,
			lastPlayedDate: "2024-05-10T20:00:00Z",
		});
		const client = makeMockClient([item]);
		const { stub, upserts } = makeMockPrisma();

		await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(upserts).toHaveLength(1);
		const payload = (upserts[0] as { create: { lastWatchedAt: Date | null } }).create;
		expect(payload.lastWatchedAt).toEqual(new Date("2024-05-10T20:00:00Z"));
	});

	it("sets lastWatchedAt for a partially-watched series (played=false, lastPlayedDate set)", async () => {
		// This is the regression case: user watched 2/5 episodes but not all.
		// Jellyfin marks the Series item as played=false, but still sets lastPlayedDate.
		const item = makeSeriesItem({
			played: false,
			playCount: 0,
			lastPlayedDate: "2024-06-15T18:30:00Z",
		});
		const client = makeMockClient([item]);
		const { stub, upserts } = makeMockPrisma();

		await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(upserts).toHaveLength(1);
		const payload = (upserts[0] as { create: { lastWatchedAt: Date | null; watchCount: number } })
			.create;
		// lastWatchedAt must be set so the episode-cache refresher picks up this series
		expect(payload.lastWatchedAt).toEqual(new Date("2024-06-15T18:30:00Z"));
		// watchCount stays 0 — the series wasn't fully watched
		expect(payload.watchCount).toBe(0);
	});

	it("leaves lastWatchedAt null when neither played nor lastPlayedDate is set", async () => {
		const item = makeSeriesItem({
			played: false,
			playCount: 0,
			lastPlayedDate: null,
		});
		const client = makeMockClient([item]);
		const { stub, upserts } = makeMockPrisma();

		await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(upserts).toHaveLength(1);
		const payload = (upserts[0] as { create: { lastWatchedAt: Date | null } }).create;
		expect(payload.lastWatchedAt).toBeNull();
	});

	it("picks the most recent lastPlayedDate across multiple users for the same series", async () => {
		// Simulate the per-user iteration: same series returned for two users with
		// different lastPlayedDate values — we want the latest date to win.
		const olderItem = makeSeriesItem({ lastPlayedDate: "2024-03-01T10:00:00Z" });
		const newerItem = makeSeriesItem({ lastPlayedDate: "2024-06-20T22:00:00Z" });

		const twoUsers: JellyfinUser[] = [
			{ id: "user-1", name: "Alice" },
			{ id: "user-2", name: "Bob" },
		];

		const client = {
			getUsers: vi.fn().mockResolvedValue(twoUsers),
			getLibraries: vi.fn().mockResolvedValue(oneLibrary),
			// First call (Alice) returns older, second call (Bob) returns newer
			getLibraryItems: vi
				.fn()
				.mockResolvedValueOnce([olderItem])
				.mockResolvedValueOnce([newerItem]),
			getResumeItems: vi.fn().mockResolvedValue([]),
			getNextUp: vi.fn().mockResolvedValue([]),
		} as unknown as JellyfinClient;

		const { stub, upserts } = makeMockPrisma();
		await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(upserts).toHaveLength(1);
		const payload = (upserts[0] as { create: { lastWatchedAt: Date | null } }).create;
		expect(payload.lastWatchedAt).toEqual(new Date("2024-06-20T22:00:00Z"));
	});

	it("discovers and scans media libraries visible only to a later user", async () => {
		const twoUsers: JellyfinUser[] = [
			{ id: "user-1", name: "Alice" },
			{ id: "user-2", name: "Bob" },
		];
		const aliceLibrary: JellyfinLibrary = {
			id: "lib-alice",
			name: "Alice TV",
			collectionType: "tvshows",
		};
		const bobLibrary: JellyfinLibrary = {
			id: "lib-bob",
			name: "Bob Movies",
			collectionType: "movies",
		};
		const bobMovie = makeSeriesItem({
			id: "jf-movie-bob",
			name: "Bob's Recent Movie",
			type: "Movie",
			tmdbId: 4242,
			played: true,
			playCount: 1,
			lastPlayedDate: "2026-08-09T20:00:00Z",
		});
		const client = {
			getUsers: vi.fn().mockResolvedValue(twoUsers),
			getLibraries: vi.fn(async (userId: string) =>
				userId === "user-1" ? [aliceLibrary] : [bobLibrary],
			),
			getLibraryItems: vi.fn(async (userId: string, libraryId: string) => {
				if (userId === "user-2" && libraryId === "lib-bob") return [bobMovie];
				return [];
			}),
			getResumeItems: vi.fn().mockResolvedValue([]),
			getNextUp: vi.fn().mockResolvedValue([]),
		} as unknown as JellyfinClient;
		const { stub, upserts } = makeMockPrisma();

		const result = await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 1 });
		expect(client.getLibraries).toHaveBeenNthCalledWith(1, "user-1");
		expect(client.getLibraries).toHaveBeenNthCalledWith(2, "user-2");
		expect(client.getLibraryItems).toHaveBeenCalledWith(
			"user-2",
			"lib-bob",
			expect.objectContaining({ includeItemTypes: "Movie" }),
		);
		expect(upserts).toHaveLength(1);
		expect(upserts[0]).toMatchObject({
			create: {
				libraryId: "lib-bob",
				lastWatchedAt: new Date("2026-08-09T20:00:00Z"),
				watchCount: 1,
				watchedByUsers: '["Bob"]',
			},
		});
	});

	it("fails closed when any user's library inventory is unavailable", async () => {
		const twoUsers: JellyfinUser[] = [
			{ id: "user-1", name: "Alice" },
			{ id: "user-2", name: "Bob" },
		];
		const client = {
			getUsers: vi.fn().mockResolvedValue(twoUsers),
			getLibraries: vi
				.fn()
				.mockResolvedValueOnce(oneLibrary)
				.mockRejectedValueOnce(new Error("Bob's library inventory was truncated")),
		} as unknown as JellyfinClient;
		const deleteMany = vi.fn();
		const transaction = vi.fn();
		const stub = { jellyfinCache: { deleteMany }, $transaction: transaction };

		const result = await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(result.complete).toBe(false);
		expect(result.errors).toBeGreaterThan(0);
		expect(result.errorMessages).toContainEqual(
			expect.stringContaining("Bob's library inventory was truncated"),
		);
		expect(deleteMany).not.toHaveBeenCalled();
		expect(transaction).not.toHaveBeenCalled();
	});

	it("evicts stale rows when a discovered library is authoritatively empty", async () => {
		const client = makeMockClient([]);
		const { stub, tx } = makeMockPrisma();

		const result = await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(result).toMatchObject({ errors: 0, complete: true, upserted: 0 });
		expect(tx.jellyfinCache.deleteMany).toHaveBeenCalledWith({ where: { instanceId: "inst-1" } });
	});

	it("fails closed without evicting when user discovery is empty", async () => {
		const client = {
			getUsers: vi.fn().mockResolvedValue([]),
		} as unknown as JellyfinClient;
		const deleteMany = vi.fn();
		const stub = { jellyfinCache: { deleteMany } };

		const result = await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(result.complete).toBe(false);
		expect(result.errors).toBeGreaterThan(0);
		expect(deleteMany).not.toHaveBeenCalled();
	});

	it("leaves the previous generation unchanged when atomic publication fails", async () => {
		const client = makeMockClient([]);
		const stub = {
			$transaction: vi.fn().mockRejectedValue(new Error("database unavailable")),
		};

		const result = await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(result.complete).toBe(false);
		expect(result.errors).toBeGreaterThan(0);
		expect(result.errorMessages).toContainEqual(
			expect.stringContaining("Atomic cache publication failed"),
		);
	});

	it("aggregates on-deck evidence across every discovered user", async () => {
		const twoUsers: JellyfinUser[] = [
			{ id: "user-1", name: "Alice" },
			{ id: "user-2", name: "Bob" },
		];
		const item = makeSeriesItem();
		const client = {
			getUsers: vi.fn().mockResolvedValue(twoUsers),
			getLibraries: vi.fn().mockResolvedValue(oneLibrary),
			getLibraryItems: vi.fn().mockResolvedValue([item]),
			getResumeItems: vi
				.fn()
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([
					{
						id: "episode-1",
						name: "Pilot",
						type: "Episode",
						seriesId: item.id,
						played: false,
						playCount: 0,
						lastPlayedDate: null,
						isFavorite: false,
					},
				]),
			getNextUp: vi.fn().mockResolvedValue([]),
		} as unknown as JellyfinClient;
		const { stub, upserts } = makeMockPrisma();

		const result = await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(result.complete).toBe(true);
		expect(client.getResumeItems).toHaveBeenCalledTimes(2);
		expect((upserts[0] as { create: { onDeck: boolean } }).create.onDeck).toBe(true);
	});

	it("fails closed when any user's on-deck inventory is unavailable", async () => {
		const twoUsers: JellyfinUser[] = [
			{ id: "user-1", name: "Alice" },
			{ id: "user-2", name: "Bob" },
		];
		const client = {
			getUsers: vi.fn().mockResolvedValue(twoUsers),
			getLibraries: vi.fn().mockResolvedValue(oneLibrary),
			getLibraryItems: vi.fn().mockResolvedValue([makeSeriesItem()]),
			getResumeItems: vi.fn().mockResolvedValue([]),
			getNextUp: vi
				.fn()
				.mockResolvedValueOnce([])
				.mockRejectedValueOnce(new Error("next-up unavailable")),
		} as unknown as JellyfinClient;
		const deleteMany = vi.fn();
		const stub = {
			jellyfinCache: {
				upsert: vi.fn().mockResolvedValue({ id: "fresh-1" }),
				findMany: vi.fn(),
				deleteMany,
			},
			$transaction: vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
		};

		const result = await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(result.complete).toBe(false);
		expect(result.errors).toBeGreaterThan(0);
		expect(deleteMany).not.toHaveBeenCalled();
	});

	it("fails closed without evicting when media library discovery is empty", async () => {
		const client = {
			getUsers: vi.fn().mockResolvedValue(oneUser),
			getLibraries: vi.fn().mockResolvedValue([]),
		} as unknown as JellyfinClient;
		const deleteMany = vi.fn();
		const stub = { jellyfinCache: { deleteMany } };

		const result = await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(result.complete).toBe(false);
		expect(result.errors).toBeGreaterThan(0);
		expect(deleteMany).not.toHaveBeenCalled();
	});

	it("fails closed without evicting when a library inventory is partial", async () => {
		const client = {
			...makeMockClient([]),
			getLibraryItems: vi.fn().mockRejectedValue(new Error("pagination stopped early")),
		} as unknown as JellyfinClient;
		const deleteMany = vi.fn();
		const stub = { jellyfinCache: { findMany: vi.fn(), deleteMany }, $transaction: vi.fn() };

		const result = await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(result.complete).toBe(false);
		expect(result.errors).toBeGreaterThan(0);
		expect(deleteMany).not.toHaveBeenCalled();
	});

	it("fails closed without evicting when a relevant item has no TMDb mapping", async () => {
		const client = makeMockClient([makeSeriesItem({ tmdbId: undefined })]);
		const deleteMany = vi.fn();
		const stub = {
			jellyfinCache: { findMany: vi.fn(), deleteMany },
			$transaction: vi.fn(),
		};

		const result = await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(result).toMatchObject({ complete: false, errors: 0, upserted: 0 });
		expect(deleteMany).not.toHaveBeenCalled();
	});

	it("publishes a complete empty replacement in one transaction", async () => {
		const client = makeMockClient([]);
		const { stub, tx } = makeMockPrisma();

		const result = await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 0 });
		expect(tx.jellyfinCache.deleteMany).toHaveBeenCalledOnce();
		expect(tx.jellyfinCache.createMany).not.toHaveBeenCalled();
		expect(tx.cacheRefreshStatus.upsert).toHaveBeenCalledOnce();
		expect(stub.$transaction).toHaveBeenCalledWith(expect.any(Function), {
			isolationLevel: "Serializable",
			timeout: JELLYFIN_CACHE_PUBLICATION_TRANSACTION_TIMEOUT_MS,
		});
	});

	it("collects a complete live snapshot without publishing cache state", async () => {
		const watchedAt = "2024-08-06T10:00:00Z";
		const client = makeMockClient([
			makeSeriesItem({ played: true, playCount: 1, lastPlayedDate: watchedAt }),
		]);
		const transaction = vi.fn();
		const stub = { $transaction: transaction };

		const result = await refreshJellyfinCache(
			client,
			stub as never,
			"inst-1",
			silentLog,
			undefined,
			{ publish: false },
		);

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 0 });
		expect(result.snapshot?.rows).toEqual([
			expect.objectContaining({
				instanceId: "inst-1",
				tmdbId: 99999,
				lastWatchedAt: new Date(watchedAt),
				watchCount: 1,
			}),
		]);
		expect(transaction).not.toHaveBeenCalled();
	});
});
