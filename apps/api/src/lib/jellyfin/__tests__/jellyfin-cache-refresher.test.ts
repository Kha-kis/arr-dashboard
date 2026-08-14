/**
 * Jellyfin Cache Refresher Tests
 *
 * Validates the aggregation logic inside refreshJellyfinCache, with a focus
 * on the partially-watched series fix: lastWatchedAt should be set whenever
 * lastPlayedDate is present, even if item.played === false.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	JELLYFIN_CACHE_PUBLICATION_CHUNK_SIZE,
	refreshJellyfinCache,
} from "../jellyfin-cache-refresher.js";
import type {
	JellyfinClient,
	JellyfinItem,
	JellyfinLibrary,
	JellyfinUser,
} from "../jellyfin-client.js";
import type { FastifyBaseLogger } from "fastify";
import { jellyfinConnectionFingerprint } from "../service-instance-fingerprint.js";

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
function makeMockPrisma(options?: {
	current?: {
		service: "JELLYFIN" | "EMBY" | "PLEX";
		baseUrl: string;
		encryptedApiKey: string;
		encryptionIv: string;
		encryptedHttpAuthCredentials: string | null;
		httpAuthEncryptionIv: string | null;
		enabled: boolean;
		connectionGeneration: number;
	} | null;
	failTransactionOnce?: boolean;
}) {
	const upserts: unknown[] = [];
	let failTransactionOnce = options?.failTransactionOnce ?? false;
	const current =
		options && "current" in options
			? options.current
			: {
					service: "JELLYFIN" as const,
					baseUrl: "https://jellyfin-current.example.com",
					encryptedApiKey: "current-key",
					encryptionIv: "current-iv",
					encryptedHttpAuthCredentials: null,
					httpAuthEncryptionIv: null,
					enabled: true,
					connectionGeneration: 7,
				};
	const tx = {
		$queryRawUnsafe: vi.fn().mockResolvedValue([]),
		serviceInstance: { findUnique: vi.fn().mockResolvedValue(current) },
		jellyfinCache: {
			deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
			createMany: vi.fn(async ({ data }: { data: unknown[] }) => {
				upserts.push(...data.map((row) => ({ create: row })));
				return { count: data.length };
			}),
		},
		cacheRefreshStatus: { upsert: vi.fn().mockResolvedValue({}) },
	};
	const stub = {
		$transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => {
			if (failTransactionOnce) {
				failTransactionOnce = false;
				throw new Error("database unavailable");
			}
			return callback(tx);
		}),
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

	it("discovers libraries visible only to a later Jellyfin user", async () => {
		const restrictedUser = { id: "user-restricted", name: "Restricted" };
		const libraryUser = { id: "user-library", name: "Library User" };
		const client = {
			...makeMockClient([]),
			getUsers: vi.fn().mockResolvedValue([restrictedUser, libraryUser]),
			getLibraries: vi.fn(async (userId: string) =>
				userId === restrictedUser.id ? [] : oneLibrary,
			),
			getLibraryItems: vi.fn().mockResolvedValue([makeSeriesItem()]),
		} as unknown as JellyfinClient;
		const { stub, upserts } = makeMockPrisma();

		const result = await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(result).toMatchObject({ complete: true, upserted: 1, errors: 0 });
		expect(client.getLibraries).toHaveBeenCalledWith(restrictedUser.id);
		expect(client.getLibraries).toHaveBeenCalledWith(libraryUser.id);
		expect(client.getLibraryItems).toHaveBeenCalledWith(libraryUser.id, "lib-1", {
			includeItemTypes: "Series",
		});
		expect(upserts).toHaveLength(1);
	});

	it("reports missing users as incomplete instead of publishing an empty cache", async () => {
		const client = {
			...makeMockClient([]),
			getUsers: vi.fn().mockResolvedValue([]),
		} as unknown as JellyfinClient;
		const { stub, tx } = makeMockPrisma();

		const result = await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(result).toMatchObject({ complete: false, errors: 1, upserted: 0 });
		expect(tx.jellyfinCache.deleteMany).not.toHaveBeenCalled();
		expect(tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});

	it("keeps the previous generation when a current library item cannot be mapped", async () => {
		const client = makeMockClient([makeSeriesItem({ tmdbId: undefined })]);
		const { stub, tx } = makeMockPrisma();

		const result = await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages.join(" ")).toMatch(/without a tmdb mapping/i);
		expect(tx.jellyfinCache.deleteMany).not.toHaveBeenCalled();
		expect(tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});

	it("keeps the previous generation when a resume item cannot be attributed", async () => {
		const client = {
			...makeMockClient([makeSeriesItem()]),
			getResumeItems: vi.fn().mockResolvedValue([
				{
					id: "unmapped-episode",
					seriesId: "another-series",
					name: "Unmapped",
					type: "Episode",
					played: false,
					playCount: 0,
					lastPlayedDate: null,
					isFavorite: false,
				},
			]),
		} as unknown as JellyfinClient;
		const { stub, tx } = makeMockPrisma();

		const result = await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages.join(" ")).toMatch(/resume item could not be attributed/i);
		expect(tx.jellyfinCache.deleteMany).not.toHaveBeenCalled();
		expect(tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});

	it.each([
		["deleted", null],
		[
			"disabled",
			{
				service: "JELLYFIN" as const,
				baseUrl: "https://jellyfin-current.example.com",
				encryptedApiKey: "current-key",
				encryptionIv: "current-iv",
				encryptedHttpAuthCredentials: null,
				httpAuthEncryptionIv: null,
				enabled: false,
				connectionGeneration: 7,
			},
		],
		[
			"service changed",
			{
				service: "PLEX" as const,
				baseUrl: "https://jellyfin-current.example.com",
				encryptedApiKey: "current-key",
				encryptionIv: "current-iv",
				encryptedHttpAuthCredentials: null,
				httpAuthEncryptionIv: null,
				enabled: true,
				connectionGeneration: 7,
			},
		],
		[
			"generation changed",
			{
				service: "JELLYFIN" as const,
				baseUrl: "https://jellyfin-current.example.com",
				encryptedApiKey: "current-key",
				encryptionIv: "current-iv",
				encryptedHttpAuthCredentials: null,
				httpAuthEncryptionIv: null,
				enabled: true,
				connectionGeneration: 8,
			},
		],
	])(
		"does not publish cache or success status after the originating connection was %s",
		async (_reason, current) => {
			const client = makeMockClient([]);
			const { stub, tx } = makeMockPrisma({ current });
			const expectedConnectionFingerprint = jellyfinConnectionFingerprint({
				service: "JELLYFIN",
				baseUrl: "https://jellyfin-current.example.com",
				encryptedApiKey: "current-key",
				encryptionIv: "current-iv",
				encryptedHttpAuthCredentials: null,
				httpAuthEncryptionIv: null,
				connectionGeneration: 7,
			} as never);

			const result = await refreshJellyfinCache(
				client,
				stub as never,
				"inst-1",
				silentLog,
				expectedConnectionFingerprint,
			);

			expect(result).toMatchObject({ complete: false, superseded: true, upserted: 0 });
			expect(tx.jellyfinCache.deleteMany).not.toHaveBeenCalled();
			expect(tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
		},
	);

	it("leaves publication retryable after a database failure", async () => {
		const client = makeMockClient([]);
		const { stub, tx } = makeMockPrisma({ failTransactionOnce: true });

		const failed = await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);
		expect(failed.complete).toBe(false);
		expect(failed.errorMessages.join(" ")).toMatch(/atomic cache publication failed/i);
		expect(tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();

		const retried = await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);
		expect(retried).toMatchObject({ complete: true, errors: 0, upserted: 0 });
		expect(tx.cacheRefreshStatus.upsert).toHaveBeenCalledOnce();
	});
});
