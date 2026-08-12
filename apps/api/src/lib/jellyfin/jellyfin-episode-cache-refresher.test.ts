import { describe, expect, it, vi } from "vitest";
import { refreshJellyfinEpisodeCache } from "./jellyfin-episode-cache-refresher.js";
import { jellyfinConnectionFingerprint } from "./service-instance-fingerprint.js";

describe("refreshJellyfinEpisodeCache generation publication", () => {
	it("keeps the prior generation when one user's episode inventory fails", async () => {
		const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
		const upsert = vi.fn().mockResolvedValue({});
		const prisma = {
			jellyfinCache: {
				findMany: vi
					.fn()
					.mockResolvedValue([{ tmdbId: 42, jellyfinId: "series-1", title: "Show" }]),
			},
			jellyfinEpisodeCache: { upsert },
			$transaction: vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
		};
		const client = {
			getUsers: vi.fn().mockResolvedValue([
				{ id: "user-1", name: "Alice" },
				{ id: "user-2", name: "Bob" },
			]),
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
