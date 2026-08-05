/**
 * Jellyfin Cache Refresher Tests
 *
 * Validates the aggregation logic inside refreshJellyfinCache, with a focus
 * on the partially-watched series fix: lastWatchedAt should be set whenever
 * lastPlayedDate is present, even if item.played === false.
 */

import { describe, expect, it, vi } from "vitest";
import { refreshJellyfinCache } from "../jellyfin-cache-refresher.js";
import type {
	JellyfinClient,
	JellyfinItem,
	JellyfinLibrary,
	JellyfinUser,
} from "../jellyfin-client.js";
import type { FastifyBaseLogger } from "fastify";

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("refreshJellyfinCache — lastWatchedAt aggregation", () => {
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
	});
});
