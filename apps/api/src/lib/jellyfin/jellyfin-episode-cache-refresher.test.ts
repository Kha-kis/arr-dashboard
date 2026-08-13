import { describe, expect, it, vi } from "vitest";
import { refreshJellyfinEpisodeCache } from "./jellyfin-episode-cache-refresher.js";
import { jellyfinConnectionFingerprint } from "./service-instance-fingerprint.js";

describe("refreshJellyfinEpisodeCache generation publication", () => {
	it("merges episode progress across separate copies of the same TMDb series", async () => {
		const currentConnection = {
			service: "JELLYFIN" as const,
			baseUrl: "https://jellyfin.example.test",
			encryptedApiKey: "key",
			encryptionIv: "iv",
			encryptedHttpAuthCredentials: null,
			httpAuthEncryptionIv: null,
			enabled: true,
			connectionGeneration: 4,
		};
		const createMany = vi.fn().mockResolvedValue({ count: 1 });
		const prisma = {
			cacheRefreshStatus: {
				findUnique: vi.fn().mockResolvedValue({ generationId: "parent-a", lastResult: "success" }),
			},
			jellyfinCache: {
				groupBy: vi
					.fn()
					.mockResolvedValue([
						{ tmdbId: 42, _max: { lastWatchedAt: new Date("2025-01-02T00:00:00.000Z") } },
					]),
				findMany: vi.fn().mockResolvedValue([
					{ tmdbId: 42, jellyfinId: "series-1080p", title: "Show" },
					{ tmdbId: 42, jellyfinId: "series-4k", title: "Show" },
				]),
			},
			$transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
				callback({
					serviceInstance: { findUnique: vi.fn().mockResolvedValue(currentConnection) },
					cacheRefreshStatus: {
						findUnique: vi.fn().mockResolvedValue({ generationId: "parent-a" }),
						upsert: vi.fn().mockResolvedValue({}),
					},
					jellyfinEpisodeCache: {
						deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
						createMany,
					},
				}),
			),
		};
		const episode = (id: string, played: boolean, lastPlayedDate?: string) => ({
			id,
			name: "Pilot",
			type: "Episode" as const,
			seasonNumber: 1,
			episodeNumber: 1,
			played,
			playCount: played ? 1 : 0,
			lastPlayedDate,
			isFavorite: false,
		});
		const client = {
			getUsers: vi.fn().mockResolvedValue([{ id: "user-1", name: "Alice" }]),
			getEpisodes: vi
				.fn()
				.mockResolvedValueOnce([episode("episode-1080p", true, "2025-01-01T00:00:00.000Z")])
				.mockResolvedValueOnce([
					episode("episode-4k", false),
					{ ...episode("episode-4k-extra", false), episodeNumber: 2 },
				]),
		};

		const result = await refreshJellyfinEpisodeCache(
			client as never,
			prisma as never,
			"jellyfin-1",
			{ warn: vi.fn(), error: vi.fn() } as never,
			jellyfinConnectionFingerprint(currentConnection),
		);

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 2 });
		expect(prisma.jellyfinCache.findMany).toHaveBeenCalledWith({
			where: {
				instanceId: "jellyfin-1",
				mediaType: "series",
				tmdbId: { in: [42] },
			},
			orderBy: [{ tmdbId: "asc" }, { jellyfinId: "asc" }],
			select: { tmdbId: true, jellyfinId: true, title: true },
		});
		expect(client.getEpisodes).toHaveBeenNthCalledWith(1, "user-1", "series-1080p");
		expect(client.getEpisodes).toHaveBeenNthCalledWith(2, "user-1", "series-4k");
		expect(createMany).toHaveBeenCalledWith({
			data: expect.arrayContaining([
				expect.objectContaining({
					showTmdbId: 42,
					seasonNumber: 1,
					episodeNumber: 1,
					watched: true,
					watchedByUsers: JSON.stringify(["Alice"]),
				}),
				expect.objectContaining({
					showTmdbId: 42,
					seasonNumber: 1,
					episodeNumber: 2,
					watched: false,
				}),
			]),
		});
	});

	it("keeps the prior generation when an alternate series copy inventory fails", async () => {
		const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
		const upsert = vi.fn().mockResolvedValue({});
		const prisma = {
			cacheRefreshStatus: {
				findUnique: vi.fn().mockResolvedValue({ generationId: "parent-a", lastResult: "success" }),
			},
			jellyfinCache: {
				groupBy: vi.fn().mockResolvedValue([{ tmdbId: 42 }]),
				findMany: vi.fn().mockResolvedValue([
					{ tmdbId: 42, jellyfinId: "series-watched", title: "Show" },
					{ tmdbId: 42, jellyfinId: "series-unwatched-copy", title: "Show" },
				]),
			},
			jellyfinEpisodeCache: { upsert },
			$transaction: vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
		};
		const client = {
			getUsers: vi.fn().mockResolvedValue([{ id: "user-1", name: "Alice" }]),
			getEpisodes: vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("partial")),
		};

		const result = await refreshJellyfinEpisodeCache(
			client as never,
			prisma as never,
			"jellyfin-1",
			{ warn: vi.fn(), error: vi.fn() } as never,
			"connection-fingerprint",
		);

		expect(result).toMatchObject({ upserted: 0, errors: 1, complete: false });
		expect(client.getEpisodes).toHaveBeenCalledTimes(2);
		expect(deleteMany).not.toHaveBeenCalled();
		expect(upsert).not.toHaveBeenCalled();
	});

	it("discards rows when the parent Jellyfin generation changes during refresh", async () => {
		const currentConnection = {
			service: "JELLYFIN" as const,
			baseUrl: "https://jellyfin.example.test",
			encryptedApiKey: "key",
			encryptionIv: "iv",
			encryptedHttpAuthCredentials: null,
			httpAuthEncryptionIv: null,
			enabled: true,
			connectionGeneration: 4,
		};
		const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
		const createMany = vi.fn().mockResolvedValue({ count: 1 });
		const statusUpsert = vi.fn().mockResolvedValue({});
		const prisma = {
			cacheRefreshStatus: {
				findUnique: vi.fn().mockResolvedValue({ generationId: "parent-a", lastResult: "success" }),
			},
			jellyfinCache: {
				groupBy: vi.fn().mockResolvedValue([{ tmdbId: 42 }]),
				findMany: vi
					.fn()
					.mockResolvedValue([{ tmdbId: 42, jellyfinId: "series-1", title: "Show" }]),
			},
			$transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
				callback({
					serviceInstance: { findUnique: vi.fn().mockResolvedValue(currentConnection) },
					cacheRefreshStatus: {
						findUnique: vi.fn().mockResolvedValue({ generationId: "parent-b" }),
						upsert: statusUpsert,
					},
					jellyfinEpisodeCache: { deleteMany, createMany },
				}),
			),
		};
		const client = {
			getUsers: vi.fn().mockResolvedValue([{ id: "user-1", name: "Alice" }]),
			getEpisodes: vi.fn().mockResolvedValue([
				{
					id: "episode-1",
					name: "Pilot",
					type: "Episode",
					seasonNumber: 1,
					episodeNumber: 1,
					played: true,
					playCount: 1,
					lastPlayedDate: "2025-01-01T00:00:00.000Z",
					isFavorite: false,
				},
			]),
		};

		const result = await refreshJellyfinEpisodeCache(
			client as never,
			prisma as never,
			"jellyfin-1",
			{ warn: vi.fn(), error: vi.fn() } as never,
			jellyfinConnectionFingerprint(currentConnection),
		);

		expect(result).toMatchObject({ complete: false, superseded: true, upserted: 0 });
		expect(deleteMany).not.toHaveBeenCalled();
		expect(createMany).not.toHaveBeenCalled();
		expect(statusUpsert).not.toHaveBeenCalled();
	});
});
